import type { DeterministicResultEnvelope, EvidenceObject, QueryIntent } from "@logiplan/contracts";

import type { SnapshotVersions } from "./snapshot-versions";

/**
 * 快照内容与结构（docs/gate2-design.md §4.1）。
 *
 * 快照 = 结构化查询意图 + 确定性结果 + 证据对象 + 版本信息的不可变副本。
 * 默认只保存在 `sessionStorage`，不写入共享业务数据库（D-181）。
 */

export interface EvidenceSnapshotPayload {
  readonly query_intent: QueryIntent;
  readonly deterministic_result: DeterministicResultEnvelope;
  readonly evidence: readonly EvidenceObject[];
}

export interface EvidenceSnapshot {
  readonly snapshot_id: string;
  readonly captured_at: string;
  readonly versions: SnapshotVersions;
  readonly payload: EvidenceSnapshotPayload;
}
