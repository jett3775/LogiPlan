import type { Client } from "pg";

import { materializeEvidenceSnapshots, releaseEvidenceSnapshotIntents } from "./query-service";
import { activateRelease, assertActiveRelease } from "./release-store";
import { runTransaction, runWithConnectionCleanup } from "./transaction-outcome";

export const initializationCoordinationLockKey = "logiplan-neon-baseline-v1";

// 激活属于发布流程的一部分，与 publish-release.ts 共用同一事务结果叙述与退出码口径。
const activationScope = "发布";
const activationIsolationLevel = "REPEATABLE READ";
const advisoryUnlock = {
  statement: "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
  parameters: [initializationCoordinationLockKey],
} as const;

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

export async function withInitializationCoordinationLock<T>(
  client: Client,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
    initializationCoordinationLockKey,
  ]);
  // 连接由调用方拥有（activate-release CLI 在 finally 中关闭），这里只释放 advisory 锁。
  // 会话级锁虽会随连接关闭释放，但 unlock 失败属于清理失败，必须可见而不是被静默吞掉。
  return runWithConnectionCleanup(client, advisoryUnlock, activationScope, operation, false);
}

export async function activateAndMaterialize(
  client: Client,
  releaseId: string,
  activate = true,
  operations: ActivationOperations = defaultOperations,
): Promise<void> {
  await runTransaction(
    client,
    async () => {
      if (activate) await operations.activate(client, releaseId);
      await operations.materialize(client, releaseEvidenceSnapshotIntents);
      await operations.assertActive(client, releaseId);
    },
    activationScope,
    activationIsolationLevel,
  );
}
