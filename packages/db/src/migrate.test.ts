import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";

import { ensureMigrationTable, runMigrationTransaction, runMigrationsWithLock } from "./migrate";
import type { MigrationFile } from "./migration-files";
import {
  exitCodeForTransactionFailure,
  transactionFailureLogPrefix,
  writeOutcomeUnknownExitCode,
} from "./transaction-outcome";

const migrationLockSql = "SELECT pg_advisory_lock(hashtextextended($1, 0))";
const migrationUnlockSql = "SELECT pg_advisory_unlock(hashtextextended($1, 0))";

function subsequentFailures(error: unknown): unknown {
  return (error as { subsequentFailures?: unknown }).subsequentFailures;
}

function transactionClient(failure?: (sql: string) => Error | undefined): {
  client: Client;
  statements: string[];
} {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      const error = failure?.(sql);
      if (error !== undefined) throw error;
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Client;
  return { client, statements };
}

// 连接清理语义需要同时观测 SQL 顺序、返回值形态与 client.end() 是否被调用。
function connectionClient(options: {
  result?: (sql: string) => { rows: readonly unknown[] } | undefined;
  failure?: (sql: string) => Error | undefined;
  endFailure?: Error;
}): {
  client: Client;
  statements: string[];
  endCalls: () => number;
} {
  const statements: string[] = [];
  let endCalls = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      const error = options.failure?.(sql);
      if (error !== undefined) throw error;
      const rows = options.result?.(sql)?.rows ?? [];
      return { rows, rowCount: rows.length };
    }),
    end: vi.fn(async () => {
      endCalls += 1;
      if (options.endFailure !== undefined) throw options.endFailure;
    }),
  } as unknown as Client;
  return { client, statements, endCalls: () => endCalls };
}

function migrationFixture(): MigrationFile {
  return {
    version: "9001",
    name: "fixture",
    fileName: "9001_fixture.sql",
    sql: "CREATE TABLE fixture_marker()",
    checksum: "fixture-checksum",
  };
}

describe("ensureMigrationTable", () => {
  it("迁移表创建在事务内执行，成功时以 COMMIT 结束", async () => {
    const { client, statements } = transactionClient();

    await ensureMigrationTable(client);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("public._schema_migrations");
    expect(statements[2]).toBe("COMMIT");
  });

  it("迁移表创建的 COMMIT 结果未知时传播未知写入结果", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("statement completion unknown"), { code: "40003" })
        : undefined,
    );

    await expect(ensureMigrationTable(client)).rejects.toMatchObject({
      writeOutcomeUnknown: true,
    });
    expect(statements[0]).toBe("BEGIN");
    expect(statements[2]).toBe("COMMIT");
  });
});

describe("runMigrationTransaction", () => {
  it("生产迁移入口在 COMMIT 确认丢失时传播未知结果", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "COMMIT" ? new Error("ECONNRESET") : undefined,
    );

    await expect(runMigrationTransaction(client, async () => undefined)).rejects.toMatchObject({
      writeOutcomeUnknown: true,
      message: "COMMIT 确认丢失，迁移结果未知；必须先只读核对再重试",
    });
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });

  it("生产迁移入口在回滚确认丢失时仍传播未知结果", async () => {
    const { client, statements } = transactionClient((sql) => {
      if (sql === "ROLLBACK") return new Error("connection closed");
      return undefined;
    });

    await expect(
      runMigrationTransaction(client, async () => {
        throw new Error("migration rejected");
      }),
    ).rejects.toMatchObject({
      writeOutcomeUnknown: true,
      message: "事务回滚确认丢失，迁移结果未知；必须先只读核对再重试",
    });
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("生产迁移入口将 SQL statement timeout 视为未知提交结果", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("statement timeout"), { code: "57014" })
        : undefined,
    );

    await expect(runMigrationTransaction(client, async () => undefined)).rejects.toMatchObject({
      writeOutcomeUnknown: true,
    });
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });

  it("生产迁移入口把 SQLSTATE 40003 判为未知提交结果", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("statement completion unknown"), { code: "40003" })
        : undefined,
    );

    await expect(runMigrationTransaction(client, async () => undefined)).rejects.toMatchObject({
      writeOutcomeUnknown: true,
    });
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });

  it("生产迁移入口把未枚举的 COMMIT 错误码判为未知提交结果", async () => {
    const { client } = transactionClient((sql) =>
      sql === "COMMIT" ? Object.assign(new Error("disk full"), { code: "53100" }) : undefined,
    );

    await expect(runMigrationTransaction(client, async () => undefined)).rejects.toMatchObject({
      writeOutcomeUnknown: true,
    });
  });

  it("生产迁移入口把 COMMIT 阶段的无效事务状态判为确定未提交", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("in failed sql transaction"), { code: "25P02" })
        : undefined,
    );

    let failure: unknown;
    try {
      await runMigrationTransaction(client, async () => undefined);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ rollbackConfirmed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });

  it("生产迁移入口在正常错误且回滚确认后保留 known_failed 语义", async () => {
    const { client, statements } = transactionClient();
    const failure = new Error("migration rejected");

    await expect(
      runMigrationTransaction(client, async () => {
        throw failure;
      }),
    ).rejects.toMatchObject({
      rollbackConfirmed: true,
      message: "migration rejected",
    });
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  });
});

// 第 1 类（确认回滚/未开始）保持已知失败；第 2 类（COMMIT 未确认）保持未知写入并映射退出码 75；
// 第 3 类（写入已提交、提交后观察或清理失败）使用独立标志、独立日志前缀，避免被误报为写入失败。
describe("迁移入口的提交后观察与清理失败语义", () => {
  it("主流程成功后 advisory unlock 失败：错误可见、仍关闭连接、且不报告为写入未知", async () => {
    const { client, statements, endCalls } = connectionClient({
      failure: (sql) => (sql === migrationUnlockSql ? new Error("unlock 时连接已断开") : undefined),
    });

    const failure = await runMigrationsWithLock(client, []).catch((error: unknown) => error);

    expect(failure).toMatchObject({ writeCommittedObservationFailed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    expect((failure as Error).message).toContain("写入已提交，失败发生在后续观察或清理阶段");
    expect((failure as Error).message).toContain("unlock 时连接已断开");
    expect(exitCodeForTransactionFailure(failure)).toBe(1);
    expect(transactionFailureLogPrefix(failure)).toBe("[WRITE_COMMITTED_OBSERVATION_FAILED] ");
    expect(endCalls()).toBe(1);

    expect(statements).toHaveLength(5);
    expect(statements[0]).toBe(migrationLockSql);
    expect(statements[1]).toBe("BEGIN");
    expect(statements[2]).toContain("public._schema_migrations");
    expect(statements[3]).toBe("COMMIT");
    expect(statements[4]).toBe(migrationUnlockSql);
  });

  it("主流程成功但连接关闭失败：错误可见且解锁已被尝试", async () => {
    const { client, statements, endCalls } = connectionClient({
      endFailure: new Error("关闭连接失败"),
    });

    const failure = await runMigrationsWithLock(client, []).catch((error: unknown) => error);

    expect(failure).toMatchObject({ writeCommittedObservationFailed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    expect((failure as Error).message).toContain("关闭数据库连接");
    expect(endCalls()).toBe(1);
    expect(statements).toContain(migrationUnlockSql);
  });

  it("解锁与关闭同时失败：两步都被尝试并各自保留为结构化证据", async () => {
    const { client, endCalls } = connectionClient({
      failure: (sql) => (sql === migrationUnlockSql ? new Error("unlock failed") : undefined),
      endFailure: new Error("end failed"),
    });

    const failure = await runMigrationsWithLock(client, []).catch((error: unknown) => error);

    expect(failure).toMatchObject({ writeCommittedObservationFailed: true });
    expect(subsequentFailures(failure)).toEqual([
      { stage: "释放 advisory 锁", message: "unlock failed" },
      { stage: "关闭数据库连接", message: "end failed" },
    ]);
    expect((failure as { cause?: unknown }).cause).toMatchObject({ message: "unlock failed" });
    expect(endCalls()).toBe(1);
  });

  it("主错误为确认回滚且清理失败：主错误标志保留，清理失败作为附加信息", async () => {
    const { client, endCalls } = connectionClient({
      result: (sql) => (sql.includes("checksum_sha256") ? { rows: [] } : undefined),
      failure: (sql) => {
        if (sql === migrationUnlockSql) return new Error("unlock failed");
        if (sql.includes("INSERT INTO public._schema_migrations")) {
          return Object.assign(new Error("insert rejected"), { code: "23505" });
        }
        return undefined;
      },
    });

    const failure = await runMigrationsWithLock(client, [migrationFixture()]).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ rollbackConfirmed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    expect((failure as Error).message).toContain("insert rejected");
    expect(subsequentFailures(failure)).toEqual([
      { stage: "释放 advisory 锁", message: "unlock failed" },
    ]);
    expect(exitCodeForTransactionFailure(failure)).toBe(1);
    expect(endCalls()).toBe(1);
  });

  it("主错误为未知 COMMIT 且清理失败：未知写入标志与退出码 75 不得丢失", async () => {
    const { client, endCalls } = connectionClient({
      failure: (sql) => {
        if (sql === "COMMIT") {
          return Object.assign(new Error("statement completion unknown"), { code: "40003" });
        }
        if (sql === migrationUnlockSql) return new Error("unlock failed");
        return undefined;
      },
    });

    const failure = await runMigrationsWithLock(client, []).catch((error: unknown) => error);

    expect(failure).toMatchObject({ writeOutcomeUnknown: true });
    expect((failure as Error).message).toContain("COMMIT 确认丢失，迁移结果未知");
    expect((failure as Error).message).toContain("unlock failed");
    expect(subsequentFailures(failure)).toEqual([
      { stage: "释放 advisory 锁", message: "unlock failed" },
    ]);
    expect(exitCodeForTransactionFailure(failure)).toBe(writeOutcomeUnknownExitCode);
    expect(transactionFailureLogPrefix(failure)).toBe("[WRITE_OUTCOME_UNKNOWN] ");
    expect(endCalls()).toBe(1);
  });
});
