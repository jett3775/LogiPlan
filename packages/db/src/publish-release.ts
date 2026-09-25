import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import { loadReleaseBundle, validateReleasePackage } from "./release-package";
import type { LoadedReleaseBundle, PackageValidationSummary } from "./release-package";
import { activateAndMaterialize } from "./activate-and-materialize";
import {
  assertDatabaseSchemaVersion,
  getReleaseStatus,
  insertReleaseData,
  validateCandidateInDatabase,
  validationSummaryJson,
} from "./release-store";
import {
  combineOutcomeWithSubsequentFailures,
  exitCodeForTransactionFailure,
  hasOutcomeFlag,
  observeCommittedWrite,
  runTransaction,
  runWithConnectionCleanup,
  transactionFailureLogPrefix,
} from "./transaction-outcome";

const publishingLockKey = "logiplan-data-publishing-v1";
const advisoryUnlock = {
  statement: "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
  parameters: [publishingLockKey],
} as const;
const publishMode = process.env.LOGIPLAN_PUBLISH_MODE || "activate";
const defaultManifestPath = fileURLToPath(
  new URL("../../../database/releases/LOGIPLAN_2026_DEMO_V2.json", import.meta.url),
);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

export async function runPublishValidationTransaction(
  client: Client,
  operation: () => Promise<void>,
): Promise<void> {
  await runTransaction(client, operation, "发布");
}

// mark_data_release_failed 自身是写操作：它必须跑在可以判定 COMMIT 结果的事务里。
// 已知失败、COMMIT 未知与成功三种结果分别传播；已经提交或结果未知的候选绝不再标记失败。
export async function markPublishFailedIfKnown(
  client: Client,
  releaseId: string,
  error: unknown,
): Promise<void> {
  if (
    hasOutcomeFlag(error, "writeOutcomeUnknown") ||
    hasOutcomeFlag(error, "writeCommittedObservationFailed") ||
    !hasOutcomeFlag(error, "rollbackConfirmed")
  ) {
    return;
  }
  const message = error instanceof Error ? error.message : "未知候选发布错误";
  try {
    await runPublishValidationTransaction(client, async () => {
      await client.query("SELECT logiplan.mark_data_release_failed($1, $2::jsonb)", [
        releaseId,
        JSON.stringify({ status: "FAIL", message }),
      ]);
    });
  } catch (markError: unknown) {
    throw combineOutcomeWithSubsequentFailures(
      error,
      [{ stage: "标记发布失败状态", error: markError }],
      "发布",
      "标记失败状态",
    );
  }
}

export async function createReleaseCandidate(
  client: Client,
  bundle: LoadedReleaseBundle,
  releaseId: string,
): Promise<void> {
  await runPublishValidationTransaction(client, async () => {
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
  });
}

export interface PublishPlan {
  readonly bundle: LoadedReleaseBundle;
  readonly packageSummary: PackageValidationSummary;
  readonly releaseId: string;
  readonly shouldActivate: boolean;
}

export async function runPublishWithLock(client: Client, plan: PublishPlan): Promise<void> {
  const { bundle, packageSummary, releaseId, shouldActivate } = plan;
  await runWithConnectionCleanup(client, advisoryUnlock, "发布", async () => {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [publishingLockKey]);
    await assertDatabaseSchemaVersion(client, bundle.manifest.database_schema_version);
    const initialStatus = await getReleaseStatus(client, releaseId);

    if (initialStatus === "ACTIVE") {
      await validateCandidateInDatabase(client, bundle, packageSummary);
      if (shouldActivate) {
        await activateAndMaterialize(client, releaseId, false);
      }
      process.stdout.write(
        `发布 ${releaseId} 已处于活动状态；校验通过，${shouldActivate ? "未重复写入" : "validate-only 未改变活动版本"}\n`,
      );
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

    let candidateCreated = false;
    if (initialStatus === null) {
      await createReleaseCandidate(client, bundle, releaseId);
      candidateCreated = true;
    }

    // 候选创建一旦 COMMIT 成功，后续读取失败只能是提交后观察失败：既不重做创建，也不标记失败。
    const currentStatus = candidateCreated
      ? await observeCommittedWrite(
          "发布",
          `候选 ${releaseId} 创建事务已提交，但紧接着读取发布状态失败`,
          () => getReleaseStatus(client, releaseId),
        )
      : await getReleaseStatus(client, releaseId);

    let validationWriteCommitted = false;
    if (currentStatus === "CANDIDATE") {
      try {
        await runPublishValidationTransaction(client, async () => {
          await insertReleaseData(client, bundle);
          const coreSummary = await validateCandidateInDatabase(client, bundle, packageSummary);
          const validationSummary = validationSummaryJson(packageSummary, coreSummary);
          await client.query("SELECT logiplan.mark_data_release_validated($1, $2::jsonb)", [
            releaseId,
            validationSummary,
          ]);
        });
        validationWriteCommitted = true;
      } catch (error: unknown) {
        await markPublishFailedIfKnown(client, releaseId, error);
        throw error;
      }
    } else if (currentStatus === "VALIDATED") {
      await validateCandidateInDatabase(client, bundle, packageSummary);
    }

    const validatedStatus = validationWriteCommitted
      ? await observeCommittedWrite(
          "发布",
          `候选 ${releaseId} 校验写入已提交，但紧接着读取发布状态失败`,
          () => getReleaseStatus(client, releaseId),
        )
      : await getReleaseStatus(client, releaseId);
    if (validatedStatus !== "VALIDATED") {
      throw new Error(`发布 ${releaseId} 未进入 VALIDATED 状态：${validatedStatus ?? "NOT_FOUND"}`);
    }
    if (!shouldActivate) {
      process.stdout.write(`发布 ${releaseId} 已完成校验并停留在 VALIDATED；未切换活动发布\n`);
      return;
    }
    await activateAndMaterialize(client, releaseId);
    process.stdout.write(`发布 ${releaseId} 已完成校验并原子激活\n`);
  });
}

async function publish(): Promise<void> {
  if (publishMode !== "activate" && publishMode !== "validate-only") {
    throw new Error("LOGIPLAN_PUBLISH_MODE 只允许 activate 或 validate-only");
  }
  const shouldActivate = publishMode === "activate";
  const manifestPath = process.env.RELEASE_MANIFEST ?? defaultManifestPath;
  const bundle = await loadReleaseBundle(manifestPath);
  const packageSummary = validateReleasePackage(bundle);
  const releaseId = bundle.manifest.release_version;
  const client = new Client({
    connectionString: requiredEnvironment("PUBLISHER_DATABASE_URL"),
    application_name: "logiplan-data-publisher",
  });

  await client.connect();
  await runPublishWithLock(client, { bundle, packageSummary, releaseId, shouldActivate });
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await publish().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知数据发布错误";
    process.stderr.write(`${transactionFailureLogPrefix(error)}数据发布失败：${message}\n`);
    process.exitCode = exitCodeForTransactionFailure(error);
  });
}
