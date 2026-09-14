import type { Client } from "pg";

import { materializeEvidenceSnapshots, releaseEvidenceSnapshotIntents } from "./query-service";
import { activateRelease, assertActiveRelease } from "./release-store";

export const initializationCoordinationLockKey = "logiplan-neon-baseline-v1";

interface ActivationOperations {
  readonly activate: typeof activateRelease;
  readonly materialize: typeof materializeEvidenceSnapshots;
  readonly assertActive: typeof assertActiveRelease;
}

const defaultOperations: ActivationOperations = {
  activate: activateRelease,
  materialize: materializeEvidenceSnapshots,
  assertActive: assertActiveRelease,
};

function isConfirmedCommitFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/u.test(error.code) &&
    !error.code.startsWith("08")
  );
}

function unknownCommitOutcome(): Error & { writeOutcomeUnknown: true } {
  const error = new Error("COMMIT 确认丢失，发布结果未知；必须先只读核对再重试");
  Object.assign(error, { writeOutcomeUnknown: true });
  return error as Error & { writeOutcomeUnknown: true };
}

function unknownRollbackOutcome(): Error & { writeOutcomeUnknown: true } {
  const error = new Error("事务回滚确认丢失，发布结果未知；必须先只读核对再重试");
  Object.assign(error, { writeOutcomeUnknown: true });
  return error as Error & { writeOutcomeUnknown: true };
}

function markRollbackConfirmed(error: unknown): Error & { rollbackConfirmed: true } {
  const confirmed = error instanceof Error ? error : new Error("数据库事务失败");
  Object.assign(confirmed, { rollbackConfirmed: true });
  return confirmed as Error & { rollbackConfirmed: true };
}

export async function withInitializationCoordinationLock<T>(
  client: Client,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
    initializationCoordinationLockKey,
  ]);
  try {
    return await operation();
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        initializationCoordinationLockKey,
      ])
      .catch(() => undefined);
  }
}

export async function activateAndMaterialize(
  client: Client,
  releaseId: string,
  activate = true,
  operations: ActivationOperations = defaultOperations,
): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  let commitAttempted = false;
  try {
    if (activate) await operations.activate(client, releaseId);
    await operations.materialize(client, releaseEvidenceSnapshotIntents);
    await operations.assertActive(client, releaseId);
    commitAttempted = true;
    await client.query("COMMIT");
  } catch (error: unknown) {
    if (commitAttempted) {
      if (!isConfirmedCommitFailure(error)) throw unknownCommitOutcome();
      try {
        await client.query("ROLLBACK");
      } catch {
        throw unknownRollbackOutcome();
      }
      throw markRollbackConfirmed(error);
    }
    try {
      await client.query("ROLLBACK");
    } catch {
      throw unknownRollbackOutcome();
    }
    throw markRollbackConfirmed(error);
  }
}
