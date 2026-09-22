import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import { loadMigrationFiles } from "./migration-files";

const lockKey = "logiplan-schema-migrations-v1";
const defaultMigrationDirectory = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

type TransactionError = Error & {
  rollbackConfirmed?: true;
  writeOutcomeUnknown?: true;
};

// COMMIT 阶段只有在 SQLSTATE 明确表示事务已终止且不可能提交时，才允许判定为确定失败。
// 40003（statement completion unknown）、08xxx（连接异常）、57014（查询取消）以及任何
// 未枚举的错误码都必须归入写入结果未知，避免把已提交的写入误报为已知失败。
const definitelyUncommittedCodePrefixes = ["25"];
const definitelyUncommittedCodes = new Set(["2D000"]);

function isConfirmedCommitFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  if (typeof code !== "string") return false;
  return (
    definitelyUncommittedCodes.has(code) ||
    definitelyUncommittedCodePrefixes.some((prefix) => code.startsWith(prefix))
  );
}

function markRollbackConfirmed(error: unknown): TransactionError {
  const confirmed = error instanceof Error ? error : new Error("数据库事务失败");
  Object.assign(confirmed, { rollbackConfirmed: true });
  return confirmed as TransactionError;
}

function unknownCommitOutcome(): TransactionError {
  const error = new Error("COMMIT 确认丢失，迁移结果未知；必须先只读核对再重试");
  Object.assign(error, { writeOutcomeUnknown: true });
  return error as TransactionError;
}

function unknownRollbackOutcome(): TransactionError {
  const error = new Error("事务回滚确认丢失，迁移结果未知；必须先只读核对再重试");
  Object.assign(error, { writeOutcomeUnknown: true });
  return error as TransactionError;
}

export async function runMigrationTransaction(
  client: Client,
  operation: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  let commitAttempted = false;
  try {
    await operation();
    commitAttempted = true;
    await client.query("COMMIT");
  } catch (error: unknown) {
    if (commitAttempted && !isConfirmedCommitFailure(error)) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw unknownRollbackOutcome();
      }
      throw unknownCommitOutcome();
    }
    try {
      await client.query("ROLLBACK");
    } catch {
      throw unknownRollbackOutcome();
    }
    throw markRollbackConfirmed(error);
  }
}

export async function ensureMigrationTable(client: Client): Promise<void> {
  await runMigrationTransaction(client, async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum_sha256 char(64) NOT NULL,
        executed_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
  });
}

async function migrate(): Promise<void> {
  const client = new Client({
    connectionString: requiredEnvironment("MIGRATION_DATABASE_URL"),
    application_name: "logiplan-schema-migrator",
  });
  const migrations = await loadMigrationFiles(
    process.env.MIGRATION_DIRECTORY ?? defaultMigrationDirectory,
  );

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    await ensureMigrationTable(client);

    for (const migration of migrations) {
      const existing = await client.query<{ checksum_sha256: string }>(
        "SELECT checksum_sha256 FROM public._schema_migrations WHERE version = $1",
        [migration.version],
      );
      const applied = existing.rows[0];
      if (applied !== undefined) {
        if (applied.checksum_sha256 !== migration.checksum) {
          throw new Error(`已执行迁移的校验和发生变化：${migration.fileName}`);
        }
        process.stdout.write(`跳过已执行迁移 ${migration.fileName}\n`);
        continue;
      }

      await runMigrationTransaction(client, async () => {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO public._schema_migrations (version, name, checksum_sha256)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
        );
      });
      process.stdout.write(`已执行迁移 ${migration.fileName}\n`);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
      .catch(() => undefined);
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await migrate().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知迁移错误";
    const writeOutcomeUnknown =
      typeof error === "object" && error !== null && "writeOutcomeUnknown" in error;
    process.stderr.write(
      `${writeOutcomeUnknown ? "[WRITE_OUTCOME_UNKNOWN] " : ""}数据库迁移失败：${message}\n`,
    );
    process.exitCode = writeOutcomeUnknown ? 75 : 1;
  });
}
