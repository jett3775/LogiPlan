import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";

import {
  activateAndMaterialize,
  initializationCoordinationLockKey,
  withInitializationCoordinationLock,
} from "./activate-and-materialize";

const lockSql = "SELECT pg_advisory_lock(hashtextextended($1, 0))";
const unlockSql = "SELECT pg_advisory_unlock(hashtextextended($1, 0))";

function transactionClient() {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Client;
  return { client, statements };
}

// 清理语义需要同时观测 SQL 顺序、错误标志与 client.end() 是否被调用。
function scriptedClient(failure?: (sql: string) => Error | undefined): {
  client: Client;
  statements: string[];
  endCalls: () => number;
} {
  const statements: string[] = [];
  let endCalls = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      const error = failure?.(sql);
      if (error !== undefined) throw error;
      return { rows: [], rowCount: 0 };
    }),
    end: vi.fn(async () => {
      endCalls += 1;
    }),
  } as unknown as Client;
  return { client, statements, endCalls: () => endCalls };
}

function subsequentFailures(error: unknown): unknown {
  return (error as { subsequentFailures?: unknown }).subsequentFailures;
}

describe("activateAndMaterialize", () => {
  it("使用与初始化相同的 advisory lock 协调独立激活", async () => {
    const { client, statements } = transactionClient();
    const result = await withInitializationCoordinationLock(client, async () => "locked");
    expect(result).toBe("locked");
    expect(statements).toEqual([
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
    ]);
    expect((client.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual([
      initializationCoordinationLockKey,
    ]);
  });

  it("在同一 REPEATABLE READ 事务中激活、物化并断言", async () => {
    const { client, statements } = transactionClient();
    const order: string[] = [];
    await activateAndMaterialize(client, "R2", true, {
      activate: async () => {
        order.push("activate");
      },
      materialize: async () => {
        order.push("materialize");
      },
      assertActive: async () => {
        order.push("assert");
      },
    });
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT"]);
    expect(order).toEqual(["activate", "materialize", "assert"]);
  });

  it("物化失败时回滚激活事务", async () => {
    const { client, statements } = transactionClient();
    await expect(
      activateAndMaterialize(client, "R2", true, {
        activate: vi.fn(async () => undefined),
        materialize: vi.fn(async () => {
          throw new Error("materialization failed");
        }),
        assertActive: vi.fn(async () => undefined),
      }),
    ).rejects.toMatchObject({
      message: "materialization failed",
      rollbackConfirmed: true,
    });
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "ROLLBACK"]);
  });

  it("重复物化活动发布时不重复调用激活函数", async () => {
    const { client, statements } = transactionClient();
    const activate = vi.fn(async () => undefined);
    const materialize = vi.fn(async () => undefined);
    const assertActive = vi.fn(async () => undefined);
    await activateAndMaterialize(client, "R2", false, {
      activate,
      materialize,
      assertActive,
    });
    expect(activate).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledOnce();
    expect(assertActive).toHaveBeenCalledOnce();
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT"]);
  });

  it("丢失 COMMIT 确认时标记结果未知，不冒充已回滚", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === "COMMIT") throw new Error("ECONNRESET");
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Client;

    await expect(
      activateAndMaterialize(client, "R2", true, {
        activate: async () => undefined,
        materialize: async () => undefined,
        assertActive: async () => undefined,
      }),
    ).rejects.toMatchObject({
      writeOutcomeUnknown: true,
      message: "COMMIT 确认丢失，发布结果未知；必须先只读核对再重试",
    });
    // 与 publish 一致：COMMIT 结果未知后仍尝试 ROLLBACK，但不得据此宣称已回滚。
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT", "ROLLBACK"]);
  });

  it("SQLSTATE 08xxx 连接异常不能证明已回滚", async () => {
    const statements: string[] = [];
    const connectionError = Object.assign(new Error("connection failure"), { code: "08006" });
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === "COMMIT") throw connectionError;
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Client;

    await expect(
      activateAndMaterialize(client, "R2", true, {
        activate: async () => undefined,
        materialize: async () => undefined,
        assertActive: async () => undefined,
      }),
    ).rejects.toMatchObject({
      writeOutcomeUnknown: true,
      message: "COMMIT 确认丢失，发布结果未知；必须先只读核对再重试",
    });
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT", "ROLLBACK"]);
  });

  // 共享分类只把 25xxx / 2D000 视为「确定未提交」；此用例沿用该口径。
  it("数据库明确拒绝 COMMIT 时保留已确认的数据库错误", async () => {
    const { client, statements } = transactionClient();
    const commitError = Object.assign(new Error("in failed sql transaction"), { code: "25P02" });
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql === "COMMIT") throw commitError;
      return { rows: [], rowCount: 0 };
    });

    await expect(
      activateAndMaterialize(client, "R2", true, {
        activate: async () => undefined,
        materialize: async () => undefined,
        assertActive: async () => undefined,
      }),
    ).rejects.toMatchObject({ rollbackConfirmed: true });
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT", "ROLLBACK"]);
  });

  // 与 migrate / publish 共用同一套 COMMIT 分类：未枚举的错误码（含 40003）归入写入结果未知。
  it("把 SQLSTATE 40003 判为未知提交结果", async () => {
    const { client, statements } = transactionClient();
    const commitError = Object.assign(new Error("statement completion unknown"), { code: "40003" });
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql === "COMMIT") throw commitError;
      return { rows: [], rowCount: 0 };
    });

    const failure = await activateAndMaterialize(client, "R2", true, {
      activate: async () => undefined,
      materialize: async () => undefined,
      assertActive: async () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ writeOutcomeUnknown: true });
    expect(failure).not.toHaveProperty("rollbackConfirmed");
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT", "ROLLBACK"]);
  });

  it("激活事务的 BEGIN 保留 REPEATABLE READ 隔离级别", async () => {
    const { client, statements } = transactionClient();
    await activateAndMaterialize(client, "R2", false, {
      activate: async () => undefined,
      materialize: async () => undefined,
      assertActive: async () => undefined,
    });
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(statements[0]).toContain("REPEATABLE READ");
  });
});

// 释放 advisory 锁属于提交后的清理阶段：失败必须可见，且绝不能代调用方关闭连接。
describe("withInitializationCoordinationLock 的 advisory unlock 可见性", () => {
  it("主流程成功但 unlock 失败时报为提交后清理失败，且不关闭调用方的连接", async () => {
    const { client, statements, endCalls } = scriptedClient((sql) =>
      sql === unlockSql ? new Error("unlock 时连接已断开") : undefined,
    );

    const failure = await withInitializationCoordinationLock(client, async () => "locked").catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ writeCommittedObservationFailed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    expect((failure as Error).message).toContain("写入已提交，失败发生在后续观察或清理阶段");
    expect((failure as Error).message).toContain("unlock 时连接已断开");
    expect(subsequentFailures(failure)).toEqual([
      { stage: "释放 advisory 锁", message: "unlock 时连接已断开" },
    ]);
    expect(endCalls()).toBe(0);
    expect(statements).toEqual([lockSql, unlockSql]);
  });

  it("主流程已确认回滚且 unlock 也失败时保留主错误标志", async () => {
    const { client, endCalls } = scriptedClient((sql) =>
      sql === unlockSql ? new Error("unlock 时连接已断开") : undefined,
    );
    const primary = Object.assign(new Error("materialization failed"), {
      rollbackConfirmed: true,
    });

    const failure = await withInitializationCoordinationLock(client, async () => {
      throw primary;
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ rollbackConfirmed: true });
    expect(failure).not.toHaveProperty("writeOutcomeUnknown");
    expect((failure as Error).message).toContain("materialization failed");
    expect((failure as Error).message).toContain("unlock 时连接已断开");
    expect(subsequentFailures(failure)).toEqual([
      { stage: "释放 advisory 锁", message: "unlock 时连接已断开" },
    ]);
    expect(endCalls()).toBe(0);
  });

  // 主流程写入结果未知时，清理失败只能作为附加证据，不得被降级描述成「已提交」。
  it("主流程写入结果未知且 unlock 也失败时仍保持未知写入", async () => {
    const { client } = scriptedClient((sql) =>
      sql === unlockSql ? new Error("unlock 时连接已断开") : undefined,
    );
    const primary = Object.assign(
      new Error("COMMIT 确认丢失，发布结果未知；必须先只读核对再重试"),
      {
        writeOutcomeUnknown: true,
      },
    );

    const failure = await withInitializationCoordinationLock(client, async () => {
      throw primary;
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ writeOutcomeUnknown: true });
    expect(failure).not.toHaveProperty("writeCommittedObservationFailed");
    expect((failure as Error).message).toContain("unlock 时连接已断开");
  });
});
