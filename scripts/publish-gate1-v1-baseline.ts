import { createRequire } from "node:module";
import process from "node:process";

import { loadReleaseBundle, validateReleasePackage } from "../packages/db/src/release-package";
import {
  activateRelease,
  assertActiveRelease,
  assertDatabaseSchemaVersion,
  getReleaseStatus,
  insertReleaseData,
  validateCandidateInDatabase,
  validationSummaryJson,
} from "../packages/db/src/release-store";

const requireFromDatabasePackage = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { Client } = requireFromDatabasePackage("pg") as typeof import("pg");
const publishingLockKey = "logiplan-gate1-v1-baseline-publishing-v1";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

async function publishBaseline(): Promise<void> {
  const bundle = await loadReleaseBundle(requiredEnvironment("RELEASE_MANIFEST"));
  const packageSummary = validateReleasePackage(bundle);
  const releaseId = bundle.manifest.release_version;
  const publisherDatabaseUrl = requiredEnvironment("PUBLISHER_DATABASE_URL");
  const publisherDatabase = new URL(publisherDatabaseUrl);
  if (
    !["127.0.0.1", "localhost"].includes(publisherDatabase.hostname) ||
    publisherDatabase.port.length === 0
  ) {
    throw new Error("Gate1 V1 基线 harness 只允许连接本地显式端口");
  }
  const client = new Client({
    connectionString: publisherDatabaseUrl,
    application_name: "logiplan-gate1-v1-baseline-publisher",
  });

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [publishingLockKey]);
    await assertDatabaseSchemaVersion(client, bundle.manifest.database_schema_version);
    const releaseState = await client.query<{ release_count: string; active_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM logiplan.data_release) AS release_count,
         (SELECT count(*)::text FROM logiplan.active_data_release) AS active_count`,
    );
    const state = releaseState.rows[0];
    if (state?.release_count !== "0" || state.active_count !== "0") {
      throw new Error("Gate1 V1 基线 harness 只允许写入无发布记录的全新隔离数据库");
    }
    await client.query(
      `SELECT logiplan.create_data_release_candidate(
         $1, $1, $2, $3, $4, $5, $6, $7
       )`,
      [
        releaseId,
        bundle.dataSha256,
        bundle.manifest.database_schema_version,
        bundle.manifest.calculation_version,
        `sha256:${bundle.generatorSha256}`,
        bundle.manifest.source_description,
        `${bundle.package.metadata.generated_on}T00:00:00.000Z`,
      ],
    );
    await client.query("BEGIN");
    try {
      await insertReleaseData(client, bundle);
      const coreSummary = await validateCandidateInDatabase(client, bundle, packageSummary);
      await client.query("SELECT logiplan.mark_data_release_validated($1, $2::jsonb)", [
        releaseId,
        validationSummaryJson(packageSummary, coreSummary),
      ]);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    }
    if ((await getReleaseStatus(client, releaseId)) !== "VALIDATED") {
      throw new Error("Gate1 V1 基线未进入 VALIDATED 状态");
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await activateRelease(client, releaseId);
      await assertActiveRelease(client, releaseId);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    }
    process.stdout.write(`测试基线 ${releaseId} 已校验并激活\n`);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [publishingLockKey])
      .catch(() => undefined);
    await client.end();
  }
}

await publishBaseline().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知 Gate1 V1 基线发布错误";
  process.stderr.write(`Gate1 V1 基线发布失败：${message}\n`);
  process.exitCode = 1;
});
