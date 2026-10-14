import type { EvidenceSnapshotPayload } from "./snapshot-payload";
import type { EvidenceSnapshotStore } from "./snapshot-store";
import type { SnapshotVersions } from "./snapshot-versions";

/**
 * 页面恢复验证（`docs/gate2-design.md` §4.2、`docs/decisions.md` D-191 决策四）。
 *
 * 「页面恢复能力成立」= 回答引用的**每一条**证据都能在已写入的快照中解析。本模块把该
 * 性质做成**可机械判定的纯函数**：给定「被引用证据的 `(evidence_id, evidence_snapshot_id)`
 * 列表」「快照种子列表」「契约声明的快照 ID 集合」，逐份恢复并逐条解析。
 *
 * 关键点：一个回答可能同时引用分属 `country` / `bridge` / `diagnostics` / `drilldown`
 * 多个查询结果的证据，因此**必须**逐份恢复、逐条解析；只断言「主证据可解析」不算通过。
 * 任一不过即整体不可恢复——**不返回「部分可用」**。
 *
 * 本模块不做 I/O：存储与时钟经 `EvidenceSnapshotStore` 注入。
 */

/** 恢复所需的最小证据引用信息（结构上兼容 `EvidenceObject` / 页面的证据白名单条目）。 */
export interface SnapshotEvidenceReference {
  readonly evidence_id: string;
  readonly evidence_snapshot_id: string;
}

/** 一份快照种子：键名（即 `evidence_snapshot_id`）+ 载荷。 */
export interface EvidenceSnapshotSeed {
  readonly evidence_snapshot_id: string;
  readonly payload: EvidenceSnapshotPayload;
}

/** 恢复失败原因的穷尽清单；用于测试与审计的稳定枚举。 */
export const SNAPSHOT_RECOVERY_FAILURE_REASONS = [
  "no_references",
  "seed_set_mismatch",
  "snapshot_not_restorable",
  "snapshot_binding_mismatch",
  "missing_seed",
  "evidence_unresolved",
] as const;

export type SnapshotRecoveryFailureReason = (typeof SNAPSHOT_RECOVERY_FAILURE_REASONS)[number];

export type SnapshotRecoveryOutcome =
  | { readonly ok: true; readonly resolved_snapshot_ids: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: SnapshotRecoveryFailureReason;
      /** 机械细分信息（键名 / 证据 ID / 状态）；不含正文或证据值。 */
      readonly detail: string;
    };

/**
 * 去重并按字典序稳定排序的快照 ID 列表（D-191：集合语义，顺序可复现）。
 *
 * 契约的 `evidence_snapshot_ids` 是集合，且其元素顺序必须可复现（同一回答每次生成
 * 得到同一顺序），故用字典序而非引用顺序。
 */
export const distinctSnapshotIds = (
  references: readonly SnapshotEvidenceReference[],
): readonly string[] =>
  [...new Set(references.map((reference) => reference.evidence_snapshot_id))].sort();

/**
 * 验证「每条引用证据都能从快照恢复」。
 *
 * 判定顺序（任一失败即返回，不继续）：
 * 1. `no_references`：引用或种子为空（无法证明能力成立）。
 * 2. `seed_set_mismatch`：契约声明的快照 ID 集合与种子集合不一致。
 * 3. `snapshot_not_restorable`：某份种子恢复失败（含六项版本校验不过）。
 * 4. `snapshot_binding_mismatch`：某份快照内的证据对象自带 `evidence_snapshot_id` 且与快照键不一致。
 * 5. `missing_seed`：某条引用指向的 `evidence_snapshot_id` 不在种子内。
 * 6. `evidence_unresolved`：某条引用的 `evidence_id` 不在其快照的 `payload.evidence` 内。
 *
 * 范围一致性不在本函数重复实现：`EVIDENCE_LOOKUP` 的范围校验由查询服务负责
 * （`packages/db/src/query-service.ts` 在范围不一致时返回 `INVALID_FILTER`）。
 */
export const verifySnapshotRecovery = (
  references: readonly SnapshotEvidenceReference[],
  seeds: readonly EvidenceSnapshotSeed[],
  declaredSnapshotIds: readonly string[],
  store: EvidenceSnapshotStore,
  expected: SnapshotVersions,
): SnapshotRecoveryOutcome => {
  if (seeds.length === 0 || references.length === 0) {
    return { ok: false, reason: "no_references", detail: "empty" };
  }
  const seedIds = seeds.map((seed) => seed.evidence_snapshot_id).sort();
  const declared = [...declaredSnapshotIds].sort();
  if (seedIds.length !== declared.length || seedIds.some((id, index) => id !== declared[index])) {
    return { ok: false, reason: "seed_set_mismatch", detail: "declared vs seeds" };
  }

  const evidenceBySnapshot = new Map<string, ReadonlySet<string>>();
  for (const seed of seeds) {
    const restored = store.restore(seed.evidence_snapshot_id, expected);
    if (restored.status !== "restored") {
      return {
        ok: false,
        reason: "snapshot_not_restorable",
        detail: `${seed.evidence_snapshot_id}:${restored.status}`,
      };
    }
    const ids = new Set<string>();
    for (const item of restored.snapshot.payload.evidence) {
      // 快照内部一致性：V1.1 证据对象自带 `evidence_snapshot_id`，必须与快照键一致
      // （V1.0 对象不带该字段，跳过）。不一致即视为不可恢复。
      if (
        item.evidence_snapshot_id !== undefined &&
        item.evidence_snapshot_id !== seed.evidence_snapshot_id
      ) {
        return { ok: false, reason: "snapshot_binding_mismatch", detail: item.evidence_id };
      }
      ids.add(item.evidence_id);
    }
    evidenceBySnapshot.set(seed.evidence_snapshot_id, ids);
  }

  for (const reference of references) {
    const ids = evidenceBySnapshot.get(reference.evidence_snapshot_id);
    if (ids === undefined) {
      return { ok: false, reason: "missing_seed", detail: reference.evidence_id };
    }
    if (!ids.has(reference.evidence_id)) {
      return { ok: false, reason: "evidence_unresolved", detail: reference.evidence_id };
    }
  }
  return { ok: true, resolved_snapshot_ids: seedIds };
};
