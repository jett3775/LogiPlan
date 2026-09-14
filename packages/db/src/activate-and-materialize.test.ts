import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";

import {
  activateAndMaterialize,
  initializationCoordinationLockKey,
  withInitializationCoordinationLock,
} from "./activate-and-materialize";

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
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT"]);
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
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT"]);
  });

  it("数据库明确拒绝 COMMIT 时保留已确认的数据库错误", async () => {
    const { client, statements } = transactionClient();
    const commitError = Object.assign(new Error("serialization failure"), { code: "40001" });
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
});
