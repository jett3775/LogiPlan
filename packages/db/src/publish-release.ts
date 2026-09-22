import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import { loadReleaseBundle, validateReleasePackage } from "./release-package";
import type { LoadedReleaseBundle } from "./release-package";
import { activateAndMaterialize } from "./activate-and-materialize";
import {
  assertDatabaseSchemaVersion,
  getReleaseStatus,
  insertReleaseData,
  validateCandidateInDatabase,
  validationSummaryJson,
} from "./release-store";

const publishingLockKey = "logiplan-data-publishing-v1";
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
  const error = new Error("COMMIT 确认丢失，发布结果未知；必须先只读核对再重试");
  Object.assign(error, { writeOutcomeUnknown: true });
  return error as TransactionError;
}

function unknownRollbackOutcome(): TransactionError {
  const error = new Error("事务回滚确认丢失，发布结果未知；必须先只读核对再重试");
  Object.assign(error, { writeOutcomeUnknown: true });
  return error as TransactionError;
}

export async function runPublishValidationTransaction(
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

function hasTransactionFlag(
  error: unknown,
  flag: "rollbackConfirmed" | "writeOutcomeUnknown",
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    flag in error &&
    (error as Record<string, unknown>)[flag] === true
  );
}

export async function markPublishFailedIfKnown(
  client: Client,
  releaseId: string,
  error: unknown,
): Promise<void> {
  if (
    hasTransactionFlag(error, "writeOutcomeUnknown") ||
    !hasTransactionFlag(error, "rollbackConfirmed")
  ) {
    return;
  }
  const message = error instanceof Error ? error.message : "未知候选发布错误";
  await client
    .query("SELECT logiplan.mark_data_release_failed($1, $2::jsonb)", [
      releaseId,
      JSON.stringify({ status: "FAIL", message }),
    ])
    .catch(() => undefined);
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
  try {
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

    if (initialStatus === null) {
      await createReleaseCandidate(client, bundle, releaseId);
    }

    const currentStatus = await getReleaseStatus(client, releaseId);
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
      } catch (error: unknown) {
        await markPublishFailedIfKnown(client, releaseId, error);
        throw error;
      }
    } else if (currentStatus === "VALIDATED") {
      await validateCandidateInDatabase(client, bundle, packageSummary);
    }

    const validatedStatus = await getReleaseStatus(client, releaseId);
    if (validatedStatus !== "VALIDATED") {
      throw new Error(`发布 ${releaseId} 未进入 VALIDATED 状态：${validatedStatus ?? "NOT_FOUND"}`);
    }
    if (!shouldActivate) {
      process.stdout.write(`发布 ${releaseId} 已完成校验并停留在 VALIDATED；未切换活动发布\n`);
      return;
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

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await publish().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知数据发布错误";
    const writeOutcomeUnknown =
      typeof error === "object" && error !== null && "writeOutcomeUnknown" in error;
    process.stderr.write(
      `${writeOutcomeUnknown ? "[WRITE_OUTCOME_UNKNOWN] " : ""}数据发布失败：${message}\n`,
    );
    process.exitCode = writeOutcomeUnknown ? 75 : 1;
  });
}
