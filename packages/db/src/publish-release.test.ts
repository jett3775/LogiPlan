import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";

import type { LoadedReleaseBundle, PackageValidationSummary } from "./release-package";
import {
  createReleaseCandidate,
  markPublishFailedIfKnown,
  runPublishValidationTransaction,
  runPublishWithLock,
} from "./publish-release";
import type { PublishPlan } from "./publish-release";
import {
  exitCodeForTransactionFailure,
  transactionFailureLogPrefix,
  writeOutcomeUnknownExitCode,
} from "./transaction-outcome";

const releaseId = "LOGIPLAN_2026_DEMO_V2";
const publishLockSql = "SELECT pg_advisory_lock(hashtextextended($1, 0))";
const publishUnlockSql = "SELECT pg_advisory_unlock(hashtextextended($1, 0))";
const releaseStatusSql = "SELECT status FROM logiplan.data_release WHERE data_release_id = $1";
const markFailedSql = "SELECT logiplan.mark_data_release_failed($1, $2::jsonb)";

type QueryRows = { rows: readonly Record<string, unknown>[] };

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

// 清理与提交后观察语义需要同时观测 SQL 顺序、返回值形态与 client.end() 是否被调用。
function scriptedClient(options: {
  result?: (sql: string) => QueryRows | undefined;
  failure?: (sql: string) => Error | undefined;
  endFailure?: Error;
}): { client: Client; statements: string[]; endCalls: () => number } {
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

function subsequentFailures(error: unknown): unknown {
  return (error as { subsequentFailures?: unknown }).subsequentFailures;
}

// validateCandidateInDatabase 的期望值来自冻结演示数据包的既有断言；假客户端复现同一组取值，
// 以便在不连接数据库的前提下走到发布主流程的提交后阶段。
function frozenValidationRows(sql: string): QueryRows | undefined {
  if (sql.includes("count(*)::text")) {
    return { rows: [{ count: "0" }] };
  }
  if (sql.includes("FROM combined")) {
    return {
      rows: [
        { budget: "16197761.9712", latest_outlook: "18327462.9382", variance: "2129700.9671" },
      ],
    };
  }
  if (sql.includes("AS actual")) {
    return { rows: [{ actual: "891643.2815", budget: "317169.0583", variance: "574474.2232" }] };
  }
  if (sql.includes("GROUP BY a.factor")) {
    return {
      rows: [
        { factor: "VOLUME", amount: "85239.1844" },
        { factor: "MIX", amount: "324207.8221" },
        { factor: "EFFICIENCY", amount: "64558.2789" },
        { factor: "PRICE", amount: "79960.1574" },
        { factor: "FX", amount: "20508.7803" },
      ],
    };
  }
  if (sql.includes("AS air_share")) {
    return {
      rows: [
        {
          scenario_type: "BUDGET",
          air_share: "0.1369",
          carrier_c_share: "0.0288",
          on_time_rate: "0.9",
          maturity_rate: "0.9",
        },
        {
          scenario_type: "ACTUAL",
          air_share: "0.6602",
          carrier_c_share: "0.3884",
          on_time_rate: "0.9616",
          maturity_rate: "0.9200",
        },
      ],
    };
  }
  if (sql.includes("UNION ALL")) {
    return {
      rows: [
        { scenario_type: "BUDGET", order_qty: "4800.0000" },
        { scenario_type: "ACTUAL", order_qty: "8932.0000" },
      ],
    };
  }
  if (sql.includes("AS center")) {
    return {
      rows: [
        { center: "DE_FC", variance: "589251.0927" },
        { center: "FR_FC", variance: "12299.5128" },
      ],
    };
  }
  if (sql.includes("AS category")) {
    return { rows: [{ category: "BASE_FREIGHT", variance: "432453.0802" }] };
  }
  return undefined;
}

function candidateBundle(): LoadedReleaseBundle {
  return {
    dataSha256: "data-sha",
    generatorSha256: "generator-sha",
    manifest: {
      release_version: releaseId,
      database_schema_version: "1",
      calculation_version: "1.1",
      source_description: "fixture",
    },
    package: {
      metadata: {
        generated_on: "2026-09-22",
        budget_version_id: "BUDGET",
        actual_version_id: "ACTUAL",
      },
    },
  } as unknown as LoadedReleaseBundle;
}

function publishPlan(overrides: Partial<PublishPlan> = {}): PublishPlan {
  return {
    bundle: candidateBundle(),
    packageSummary: { gate1_rows: {} } as unknown as PackageValidationSummary,
    releaseId,
    shouldActivate: false,
    ...overrides,
  };
}

describe("createReleaseCandidate", () => {
  it("候选创建在事务内执行，成功时以 COMMIT 结束", async () => {
    const { client, statements } = transactionClient();

    await createReleaseCandidate(client, candidateBundle(), "LOGIPLAN_2026_DEMO_V2");
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("create_data_release_candidate");
    expect(statements[2]).toBe("COMMIT");
  });

  it("候选创建的 COMMIT 结果未知时传播未知写入结果", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("statement completion unknown"), { code: "40003" })
        : undefined,
    );

    await expect(
      createReleaseCandidate(client, candidateBundle(), "LOGIPLAN_2026_DEMO_V2"),
    ).rejects.toMatchObject({ writeOutcomeUnknown: true });
    expect(statements[0]).toBe("BEGIN");
    expect(statements[2]).toBe("COMMIT");
  });
});

describe("publish-release transaction entry", () => {
  it("在 COMMIT 确认丢失时传播未知结果", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "COMMIT" ? new Error("ETIMEDOUT") : undefined,
    );

    await expect(
      runPublishValidationTransaction(client, async () => undefined),
    ).rejects.toMatchObject({
      writeOutcomeUnknown: true,
      message: "COMMIT 确认丢失，发布结果未知；必须先只读核对再重试",
    });
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });

  it("把 SQLSTATE 40003 判为未知提交结果", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("statement completion unknown"), { code: "40003" })
        : undefined,
    );

    await expect(
      runPublishValidationTransaction(client, async () => undefined),
    ).rejects.toMatchObject({ writeOutcomeUnknown: true });
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });

  it("把未枚举的 COMMIT 错误码判为未知提交结果", async () => {
    const { client } = transactionClient((sql) =>
      sql === "COMMIT" ? Object.assign(new Error("disk full"), { code: "53100" }) : undefined,
    );

    await expect(
      runPublishValidationTransaction(client, async () => undefined),
    ).rejects.toMatchObject({ writeOutcomeUnknown: true });
  });

  it("把 COMMIT 阶段的无效事务状态判为确定未提交", async () => {
    const { client } = transactionClient((sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("in failed sql transaction"), { code: "25P02" })
        : undefined,
    );

    let failure: unknown;
    try {
      await runPublishValidationTransaction(client, async () => undefined);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ rollbackConfirmed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
  });

  it("正常验证错误且回滚确认后保留 known_failed 语义", async () => {
    const { client, statements } = transactionClient();
    const failure = new Error("validation rejected");

    await expect(
      runPublishValidationTransaction(client, async () => {
        throw failure;
      }),
    ).rejects.toMatchObject({ rollbackConfirmed: true, message: "validation rejected" });
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("正常验证错误进入 BEGIN/ROLLBACK，且动态 ROLLBACK 失败时传播未知结果", async () => {
    const { client, statements } = transactionClient((sql) =>
      sql === "ROLLBACK" ? new Error("rollback confirmation lost") : undefined,
    );

    await expect(
      runPublishValidationTransaction(client, async () => {
        throw new Error("validation rejected");
      }),
    ).rejects.toMatchObject({
      writeOutcomeUnknown: true,
      message: "事务回滚确认丢失，发布结果未知；必须先只读核对再重试",
    });
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("未知提交结果不执行 mark_failed，避免二次写入", async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Client;
    await markPublishFailedIfKnown(
      client,
      "LOGIPLAN_2026_DEMO_V2",
      Object.assign(new Error("commit lost"), { writeOutcomeUnknown: true }),
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it("正常回滚确认后允许 mark_failed", async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Client;
    await markPublishFailedIfKnown(
      client,
      "LOGIPLAN_2026_DEMO_V2",
      Object.assign(new Error("validation rejected"), { rollbackConfirmed: true }),
    );
    expect(client.query).toHaveBeenCalledWith(
      "SELECT logiplan.mark_data_release_failed($1, $2::jsonb)",
      ["LOGIPLAN_2026_DEMO_V2", JSON.stringify({ status: "FAIL", message: "validation rejected" })],
    );
  });
});

// mark_data_release_failed 自身是写操作：成功、已知失败与 COMMIT 未知必须分别传播，
// 不得再用 .catch(() => undefined) 吞掉，也不得让第二次未知写入被归为普通失败。
describe("markPublishFailedIfKnown 二次写入结果传播", () => {
  function rollbackConfirmedError(): Error {
    return Object.assign(new Error("候选校验失败"), { rollbackConfirmed: true });
  }

  it("标记成功时以显式事务提交", async () => {
    const { client, statements } = scriptedClient({});

    await markPublishFailedIfKnown(client, releaseId, rollbackConfirmedError());

    expect(statements).toEqual(["BEGIN", markFailedSql, "COMMIT"]);
  });

  it("标记的已知失败必须传播为可见错误，同时保留原错误标志", async () => {
    const { client, statements } = scriptedClient({
      failure: (sql) =>
        sql === markFailedSql
          ? Object.assign(new Error("标记失败状态被拒绝"), { code: "23503" })
          : undefined,
    });

    const failure = await markPublishFailedIfKnown(
      client,
      releaseId,
      rollbackConfirmedError(),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ rollbackConfirmed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    expect((failure as Error).message).toContain("候选校验失败");
    expect((failure as Error).message).toContain("标记失败状态被拒绝");
    expect(subsequentFailures(failure)).toEqual([
      { stage: "标记发布失败状态", message: "标记失败状态被拒绝" },
    ]);
    expect(statements).toEqual(["BEGIN", markFailedSql, "ROLLBACK"]);
  });

  it("标记的 COMMIT 结果未知必须升级为未知写入，并保留原错误为 cause", async () => {
    const { client, statements } = scriptedClient({
      failure: (sql) => (sql === "COMMIT" ? new Error("COMMIT 时连接中断") : undefined),
    });

    const failure = await markPublishFailedIfKnown(
      client,
      releaseId,
      rollbackConfirmedError(),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ writeOutcomeUnknown: true, rollbackConfirmed: true });
    expect((failure as Error).message).toContain("COMMIT 确认丢失");
    expect((failure as Error).message).toContain("候选校验失败");
    expect((failure as { cause?: unknown }).cause).toMatchObject({ message: "候选校验失败" });
    expect(exitCodeForTransactionFailure(failure)).toBe(writeOutcomeUnknownExitCode);
    expect(statements).toEqual(["BEGIN", markFailedSql, "COMMIT", "ROLLBACK"]);
  });
});

// 第 3 类结果：写入已确认提交，失败只发生在提交后的观察或清理阶段。
describe("runPublishWithLock 提交后观察与清理失败语义", () => {
  it("主流程成功后 advisory unlock 失败：错误可见、仍关闭连接、且不报告为写入未知", async () => {
    const { client, statements, endCalls } = scriptedClient({
      result: (sql) => {
        if (sql.includes("current_schema_version")) return { rows: [{ version: "1" }] };
        if (sql === releaseStatusSql) return { rows: [{ status: "ACTIVE" }] };
        return frozenValidationRows(sql);
      },
      failure: (sql) => (sql === publishUnlockSql ? new Error("unlock 时连接已断开") : undefined),
    });
    // 该路径会写出“已处于活动状态”的正常日志，测试中屏蔽以免与真实的失败日志混淆。
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let failure: unknown;
    try {
      failure = await runPublishWithLock(client, publishPlan()).catch((error: unknown) => error);
    } finally {
      stdout.mockRestore();
    }

    expect(failure).toMatchObject({ writeCommittedObservationFailed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    expect((failure as Error).message).toContain("写入已提交，失败发生在后续观察或清理阶段");
    expect((failure as Error).message).toContain("unlock 时连接已断开");
    expect(exitCodeForTransactionFailure(failure)).toBe(1);
    expect(transactionFailureLogPrefix(failure)).toBe("[WRITE_COMMITTED_OBSERVATION_FAILED] ");
    expect(endCalls()).toBe(1);

    expect(statements[0]).toBe(publishLockSql);
    expect(statements.at(-1)).toBe(publishUnlockSql);
    expect(statements.some((sql) => sql.includes("count(*)::text"))).toBe(true);
  });

  it("候选创建 COMMIT 成功但紧随的状态读取失败：报为提交后观察失败，且不重做创建、不标记失败", async () => {
    let statusReads = 0;
    const { client, statements, endCalls } = scriptedClient({
      result: (sql) =>
        sql.includes("current_schema_version") ? { rows: [{ version: "1" }] } : undefined,
      failure: (sql) => {
        if (sql !== releaseStatusSql) return undefined;
        statusReads += 1;
        return statusReads === 2 ? new Error("读取状态时连接中断") : undefined;
      },
    });

    const failure = await runPublishWithLock(client, publishPlan()).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ writeCommittedObservationFailed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    const message = (failure as Error).message;
    expect(message).toContain("写入已提交，失败发生在后续观察或清理阶段");
    expect(message).toContain(releaseId);
    expect(message).toContain("读取发布状态失败");
    expect(message).toContain("读取状态时连接中断");

    const createStatements = statements.filter((sql) =>
      sql.includes("create_data_release_candidate"),
    );
    expect(createStatements).toHaveLength(1);
    const createIndex = statements.findIndex((sql) =>
      sql.includes("create_data_release_candidate"),
    );
    expect(statements[createIndex + 1]).toBe("COMMIT");
    expect(statements.some((sql) => sql.includes("mark_data_release_failed"))).toBe(false);
    expect(exitCodeForTransactionFailure(failure)).toBe(1);
    expect(endCalls()).toBe(1);
  });
});
