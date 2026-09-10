import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { loadReleaseBundle, validateReleasePackage } from "./release-package";
import {
  activateRelease,
  assertActiveRelease,
  assertDatabaseSchemaVersion,
  getReleaseStatus,
  insertReleaseData,
  validateCandidateInDatabase,
  validationSummaryJson,
} from "./release-store";
import { materializeEvidenceSnapshots, releaseEvidenceSnapshotIntents } from "./query-service";

const publishingLockKey = "logiplan-data-publishing-v1";
const defaultManifestPath = fileURLToPath(
  new URL("../../../database/releases/LOGIPLAN_2026_DEMO_V2.json", import.meta.url),
);

async function activateAndMaterialize(
  client: Client,
  releaseId: string,
  activate = true,
): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    if (activate) await activateRelease(client, releaseId);
    await materializeEvidenceSnapshots(client, releaseEvidenceSnapshotIntents);
    await assertActiveRelease(client, releaseId);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

async function publish(): Promise<void> {
  const manifestPath = process.env.RELEASE_MANIFEST ?? defaultManifestPath;
  const bundle = await loadReleaseBundle(manifestPath);
  const packageSummary = validateReleasePackage(bundle);
  const releaseId = bundle.manifest.release_version;
  const client = new Client({
    connectionString: requiredEnvironment("PUBLISHER_DATABASE_URL"),
    application_name: "logiplan-data-publisher",
  });

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [publishingLockKey]);
    await assertDatabaseSchemaVersion(client, bundle.manifest.database_schema_version);
    const initialStatus = await getReleaseStatus(client, releaseId);

    if (initialStatus === "ACTIVE") {
      await validateCandidateInDatabase(client, bundle, packageSummary);
      await activateAndMaterialize(client, releaseId, false);
      process.stdout.write(`发布 ${releaseId} 已处于活动状态；校验通过，未重复写入\n`);
      return;
    }
    if (initialStatus === "RETIRED") {
      await validateCandidateInDatabase(client, bundle, packageSummary);
      process.stdout.write(`发布 ${releaseId} 已退役；校验通过，重复执行不改变活动版本\n`);
      return;
    }
    if (initialStatus === "FAILED") {
      throw new Error(`发布 ${releaseId} 此前已失败；修正数据后必须使用新的发布版本`);
    }

    if (initialStatus === null) {
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
    }

    const currentStatus = await getReleaseStatus(client, releaseId);
    if (currentStatus === "CANDIDATE") {
      await client.query("BEGIN");
      try {
        await insertReleaseData(client, bundle);
        const coreSummary = await validateCandidateInDatabase(client, bundle, packageSummary);
        const validationSummary = validationSummaryJson(packageSummary, coreSummary);
        await client.query("SELECT logiplan.mark_data_release_validated($1, $2::jsonb)", [
          releaseId,
          validationSummary,
        ]);
        await client.query("COMMIT");
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        const message = error instanceof Error ? error.message : "未知候选发布错误";
        await client
          .query("SELECT logiplan.mark_data_release_failed($1, $2::jsonb)", [
            releaseId,
            JSON.stringify({ status: "FAIL", message }),
          ])
          .catch(() => undefined);
        throw error;
      }
    }

    const validatedStatus = await getReleaseStatus(client, releaseId);
    if (validatedStatus !== "VALIDATED") {
      throw new Error(`发布 ${releaseId} 未进入 VALIDATED 状态：${validatedStatus ?? "NOT_FOUND"}`);
    }
    await activateAndMaterialize(client, releaseId);
    process.stdout.write(`发布 ${releaseId} 已完成校验并原子激活\n`);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [publishingLockKey])
      .catch(() => undefined);
    await client.end();
  }
}

await publish().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知数据发布错误";
  process.stderr.write(`数据发布失败：${message}\n`);
  process.exitCode = 1;
});
