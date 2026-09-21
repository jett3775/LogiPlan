import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";

import { markPublishFailedIfKnown, runPublishValidationTransaction } from "./publish-release";

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
