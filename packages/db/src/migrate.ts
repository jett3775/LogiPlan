import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import { loadMigrationFiles } from "./migration-files";
import type { MigrationFile } from "./migration-files";
import {
  exitCodeForTransactionFailure,
  runTransaction,
  runWithConnectionCleanup,
  transactionFailureLogPrefix,
} from "./transaction-outcome";

const lockKey = "logiplan-schema-migrations-v1";
const advisoryUnlock = {
  statement: "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
  parameters: [lockKey],
} as const;
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

export async function runMigrationTransaction(
  client: Client,
  operation: () => Promise<void>,
): Promise<void> {
  await runTransaction(client, operation, "迁移");
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

export async function runMigrationsWithLock(
  client: Client,
  migrations: readonly MigrationFile[],
): Promise<void> {
  await runWithConnectionCleanup(client, advisoryUnlock, "迁移", async () => {
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
  await runMigrationsWithLock(client, migrations);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await migrate().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知迁移错误";
    process.stderr.write(`${transactionFailureLogPrefix(error)}数据库迁移失败：${message}\n`);
    process.exitCode = exitCodeForTransactionFailure(error);
  });
}
