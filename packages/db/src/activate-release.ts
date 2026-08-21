import { Client } from "pg";

import { activateRelease, assertActiveRelease } from "./release-store";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

async function run(): Promise<void> {
  const releaseId = process.argv[2];
  if (releaseId === undefined || releaseId.length === 0 || process.argv.length !== 3) {
    throw new Error("用法：pnpm db:activate-release <data_release_id>");
  }
  const client = new Client({
    connectionString: requiredEnvironment("PUBLISHER_DATABASE_URL"),
    application_name: "logiplan-release-activator",
  });
  await client.connect();
  try {
    const result = await client.query<{ status: string; validation_status: string | null }>(
      `SELECT status, validation_summary ->> 'status' AS validation_status
       FROM logiplan.data_release
       WHERE data_release_id = $1`,
      [releaseId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`发布不存在：${releaseId}`);
    }
    if (row.validation_status !== "PASS") {
      throw new Error(`发布没有通过完整校验：${releaseId}`);
    }
    await activateRelease(client, releaseId);
    await assertActiveRelease(client, releaseId);
    process.stdout.write(`活动发布已切换为 ${releaseId}\n`);
  } finally {
    await client.end();
  }
}

await run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知发布切换错误";
  process.stderr.write(`发布切换失败：${message}\n`);
  process.exitCode = 1;
});
