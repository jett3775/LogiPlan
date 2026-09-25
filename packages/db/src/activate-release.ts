import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "pg";

import {
  activateAndMaterialize,
  withInitializationCoordinationLock,
} from "./activate-and-materialize";
import { exitCodeForTransactionFailure, transactionFailureLogPrefix } from "./transaction-outcome";

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
    await withInitializationCoordinationLock(client, async () => {
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
      await activateAndMaterialize(client, releaseId);
      process.stdout.write(`活动发布已原子切换为 ${releaseId}，固定证据已物化\n`);
    });
  } finally {
    await client.end();
  }
}

// 与 publish-release CLI 共用同一套失败归类：写入结果未知必须以 75 结束并带机器可识别前缀，
// 好让调用方先只读核对再决定是否重试；可确认回滚的失败仍以 1 结束且不带前缀。
export function reportActivationFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "未知发布切换错误";
  process.stderr.write(`${transactionFailureLogPrefix(error)}发布切换失败：${message}\n`);
  process.exitCode = exitCodeForTransactionFailure(error);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await run().catch(reportActivationFailure);
}
