import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";

import { runMigrationTransaction } from "./migrate";

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
