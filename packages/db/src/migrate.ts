import { fileURLToPath } from "node:url";

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
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum_sha256 char(64) NOT NULL,
        executed_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

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

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO public._schema_migrations (version, name, checksum_sha256)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        process.stdout.write(`已执行迁移 ${migration.fileName}\n`);
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
      .catch(() => undefined);
    await client.end();
  }
}

await migrate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知迁移错误";
  process.stderr.write(`数据库迁移失败：${message}\n`);
  process.exitCode = 1;
});
