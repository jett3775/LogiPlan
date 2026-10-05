import { evidenceSnapshotIdSchema } from "@logiplan/contracts";

import type { EvidenceSnapshot } from "./snapshot-payload";
import {
  compareSnapshotVersions,
  snapshotVersionsSchema,
  type SnapshotVersionMismatch,
  type SnapshotVersions,
} from "./snapshot-versions";

/**
 * 证据快照存储（docs/gate2-design.md §4.1—§4.2、docs/decisions.md D-190 决策四）。
 *
 * D-190 决策四原文：
 * 「键名为 `logiplan.ai.snapshot.<snapshot_id>`；每标签页最多保留 20 份，超限时按
 * LRU（最久未访问先淘汰）淘汰；单份上限 2 MB，超限即拒绝写入该份并淘汰最久未访问的一份。」
 *
 * 存储与时钟都必须可注入：浏览器外（Node 测试环境）没有 `sessionStorage`，
 * 且 LRU 判定必须可由测试用确定时钟驱动。
 */

export const SNAPSHOT_KEY_PREFIX = "logiplan.ai.snapshot.";
/** LRU 访问索引键；同前缀但不是快照，枚举时按精确键名排除。 */
export const SNAPSHOT_LRU_INDEX_KEY = "logiplan.ai.snapshot.lru_index";
/** 每标签页快照份数上限（D-190 决策四）。 */
export const MAX_SNAPSHOTS_PER_TAB = 20;
/** 单份快照字节上限（D-190 决策四）。 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface SessionStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SnapshotClock {
  now(): number;
}

export interface SnapshotIndexEntry {
  readonly snapshot_id: string;
  readonly last_accessed_at: number;
}

export type SnapshotWriteResult =
  | { readonly status: "written"; readonly key: string; readonly evicted: readonly string[] }
  | { readonly status: "rejected_too_large"; readonly evicted: readonly string[] }
  | { readonly status: "rejected_reserved_id"; readonly snapshotId: string }
  | { readonly status: "rejected_invalid_id"; readonly snapshotId: string }
  | { readonly status: "storage_unavailable" };

export type SnapshotRestoreResult =
  | { readonly status: "restored"; readonly snapshot: EvidenceSnapshot }
  | { readonly status: "not_found" }
  | {
      readonly status: "version_mismatch";
      readonly mismatches: readonly SnapshotVersionMismatch[];
    }
  | { readonly status: "corrupt"; readonly reason: "unparseable" | "invalid_shape" };

export interface SnapshotStoreOptions {
  readonly storage: SessionStorageLike;
  readonly clock: SnapshotClock;
  readonly maxSnapshots?: number;
  readonly maxBytes?: number;
}

export const snapshotKey = (snapshotId: string): string => `${SNAPSHOT_KEY_PREFIX}${snapshotId}`;

/**
 * 保留的快照 ID：恰好等于 LRU 索引键名的那一份。
 *
 * `SNAPSHOT_LRU_INDEX_KEY` 落在 `SNAPSHOT_KEY_PREFIX` 之内（D-190 决策四的键名形态
 * `logiplan.ai.snapshot.<snapshot_id>`，并被既有测试锁定），因此「快照 ID 恰好是
 * `lru_index`」会让快照本体覆盖索引键：枚举时 `#listStoredIds` 按精确键名跳过它，
 * 结果是该份既不可恢复、又清空了 LRU 索引。
 *
 * 处理方式是**拒绝**该 ID 而不是换键：换键会与 D-190 冻结的键名形态脱钩，拒绝则
 * 只影响这一个取值，且失败关闭（调用方回到固定示例）比静默改键更安全。
 */
export const RESERVED_SNAPSHOT_ID = SNAPSHOT_LRU_INDEX_KEY.slice(SNAPSHOT_KEY_PREFIX.length);

/** 该快照 ID 是否会与 LRU 索引键撞名。 */
export const isReservedSnapshotId = (snapshotId: string): boolean =>
  snapshotKey(snapshotId) === SNAPSHOT_LRU_INDEX_KEY;

const textEncoder = new TextEncoder();
export const snapshotByteLength = (value: string): number => textEncoder.encode(value).byteLength;

const indexEntrySchema = (value: unknown): SnapshotIndexEntry | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.snapshot_id !== "string" || record.snapshot_id.length === 0) return null;
  if (typeof record.last_accessed_at !== "number" || !Number.isFinite(record.last_accessed_at)) {
    return null;
  }
  return { snapshot_id: record.snapshot_id, last_accessed_at: record.last_accessed_at };
};

const sortByAccessTime = (entries: readonly SnapshotIndexEntry[]): SnapshotIndexEntry[] =>
  // 稳定排序：访问时间相同时保持索引中既有先后（先访问的更久远）。
  [...entries].sort((left, right) => left.last_accessed_at - right.last_accessed_at);

export class EvidenceSnapshotStore {
  readonly #storage: SessionStorageLike;
  readonly #clock: SnapshotClock;
  readonly #maxSnapshots: number;
  readonly #maxBytes: number;

  constructor(options: SnapshotStoreOptions) {
    this.#storage = options.storage;
    this.#clock = options.clock;
    this.#maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS_PER_TAB;
    this.#maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
  }

  /**
   * 写入一份快照。
   *
   * - 快照 ID 不合格：拒绝写入该份。恢复侧 `readSnapshotEnvelope` 已按同一模式
   *   拒绝不合格 ID，若写入侧不校验，就会产生「能写入但永远无法恢复」的快照，
   *   白占一个 D-190 决策四的份数配额槽位。
   * - 快照 ID 与 LRU 索引键撞名：拒绝写入，既不覆盖索引也不产生不可恢复的快照。
   * - 单份超上限：拒绝写入该份，并按 D-190 决策四淘汰最久未访问的一份。
   * - 份数超上限：写入后按**访问时间**淘汰最久未访问的一份，直至回到上限。
   * - 存储不可用（配额、隐私模式等）：返回 `storage_unavailable`，由调用方回落固定示例。
   */
  write(snapshot: EvidenceSnapshot): SnapshotWriteResult {
    // 复用公共契约的 `evidenceSnapshotIdSchema`（1—240 字符、非空白、无首尾空格，
    // docs/query-contract.md §4.2），与恢复侧同一套规则，不在此重复实现。
    if (!evidenceSnapshotIdSchema.safeParse(snapshot.snapshot_id).success) {
      return { status: "rejected_invalid_id", snapshotId: snapshot.snapshot_id };
    }
    const key = snapshotKey(snapshot.snapshot_id);
    // 与 LRU 索引键撞名：拒绝写入，既不覆盖索引也不产生不可恢复的快照。
    if (isReservedSnapshotId(snapshot.snapshot_id)) {
      return { status: "rejected_reserved_id", snapshotId: snapshot.snapshot_id };
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      return { status: "storage_unavailable" };
    }
    if (snapshotByteLength(serialized) > this.#maxBytes) {
      return { status: "rejected_too_large", evicted: this.#evictLeastRecentlyUsed() };
    }
    try {
      this.#storage.setItem(key, serialized);
      const index = this.#touch(snapshot.snapshot_id, this.#clock.now());
      const evicted = this.#enforceSnapshotCap(index);
      const evictedSet = new Set(evicted);
      this.#writeIndex(
        this.#trimIndexToCap(index.filter((entry) => !evictedSet.has(entry.snapshot_id))),
      );
      return { status: "written", key, evicted };
    } catch {
      return { status: "storage_unavailable" };
    }
  }

  /**
   * 恢复快照。六项版本校验任一不一致即不可恢复并丢弃该份快照；
   * 不返回任何「部分可用」的结果。
   */
  restore(snapshotId: string, expected: SnapshotVersions): SnapshotRestoreResult {
    // 保留名永远不可能是已存快照：不得把 LRU 索引当成快照解析。
    if (isReservedSnapshotId(snapshotId)) return { status: "not_found" };
    const key = snapshotKey(snapshotId);
    let raw: string | null;
    try {
      raw = this.#storage.getItem(key);
    } catch {
      return { status: "not_found" };
    }
    if (raw === null) return { status: "not_found" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#discard(snapshotId);
      return { status: "corrupt", reason: "unparseable" };
    }
    const snapshot = readSnapshotEnvelope(parsed);
    if (snapshot === null) {
      this.#discard(snapshotId);
      return { status: "corrupt", reason: "invalid_shape" };
    }

    const mismatches = compareSnapshotVersions(snapshot.versions, expected);
    if (mismatches.length > 0) {
      this.#discard(snapshotId);
      return { status: "version_mismatch", mismatches };
    }

    this.#writeIndex(this.#trimIndexToCap(this.#touch(snapshotId, this.#clock.now())));
    return { status: "restored", snapshot };
  }

  /** 丢弃一份快照并同步 LRU 索引。 */
  discard(snapshotId: string): void {
    this.#discard(snapshotId);
  }

  /** 当前存储中的快照份数（不含 LRU 索引）。 */
  count(): number {
    return this.#listStoredIds().length;
  }

  /** 存储中的快照 ID，按访问时间由久到近排列。 */
  listByAccessTime(): readonly string[] {
    return sortByAccessTime(this.#readIndex()).map((entry) => entry.snapshot_id);
  }

  #listStoredIds(): string[] {
    const ids: string[] = [];
    for (let index = 0; index < this.#storage.length; index += 1) {
      const key = this.#storage.key(index);
      if (key === null || key === SNAPSHOT_LRU_INDEX_KEY) continue;
      if (!key.startsWith(SNAPSHOT_KEY_PREFIX)) continue;
      ids.push(key.slice(SNAPSHOT_KEY_PREFIX.length));
    }
    return ids;
  }

  /**
   * 读取访问序索引（数组位置越靠后＝访问时间越近）。
   *
   * 存储键集合是「是否存在」的真相，索引只是访问时间的真相：两者不一致时
   * 以存储为准补齐缺失条目（访问时间记为 0＝最久远），并丢弃已不存在的条目。
   * 因此索引损坏或残缺都不会让快照失去淘汰资格，更不会静默失败。
   */
  #readIndex(): readonly SnapshotIndexEntry[] {
    const stored = this.#listStoredIds();
    const parsed = this.#parseIndex();
    if (parsed === null) return this.#rebuildIndex(stored);
    const known = new Set(parsed.map((entry) => entry.snapshot_id));
    const kept = parsed.filter((entry) => stored.includes(entry.snapshot_id));
    const restored = stored
      .filter((id) => !known.has(id))
      .map<SnapshotIndexEntry>((id) => ({ snapshot_id: id, last_accessed_at: 0 }));
    return sortByAccessTime([...kept, ...restored]);
  }

  #parseIndex(): readonly SnapshotIndexEntry[] | null {
    let raw: string | null;
    try {
      raw = this.#storage.getItem(SNAPSHOT_LRU_INDEX_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const entries = parsed.map(indexEntrySchema);
      if (entries.some((entry) => entry === null)) return null;
      return entries as SnapshotIndexEntry[];
    } catch {
      return null;
    }
  }

  #rebuildIndex(stored: readonly string[] = this.#listStoredIds()): readonly SnapshotIndexEntry[] {
    return [...stored]
      .sort()
      .map((snapshotId) => ({ snapshot_id: snapshotId, last_accessed_at: 0 }));
  }

  #writeIndex(entries: readonly SnapshotIndexEntry[]): void {
    try {
      this.#storage.setItem(SNAPSHOT_LRU_INDEX_KEY, JSON.stringify(entries));
    } catch {
      // 索引写入失败不改变快照本体；最坏情况退化为按写入顺序淘汰。
    }
  }

  /** 记一次访问：更新访问时间并重新排序。 */
  #touch(snapshotId: string, at: number): SnapshotIndexEntry[] {
    const rest = this.#readIndex().filter((entry) => entry.snapshot_id !== snapshotId);
    return sortByAccessTime([...rest, { snapshot_id: snapshotId, last_accessed_at: at }]);
  }

  /**
   * 把索引裁剪到份数上限后再落盘：保留访问时间最近的若干条。
   *
   * 索引必须先裁剪再写，否则「写入后再淘汰」这一路径会让索引条目数比存储多一条，
   * 索引自身就会无界增长。裁剪只影响索引体积，不改变任何快照的淘汰判定。
   */
  #trimIndexToCap(entries: readonly SnapshotIndexEntry[]): readonly SnapshotIndexEntry[] {
    const sorted = sortByAccessTime(entries);
    return sorted.length <= this.#maxSnapshots
      ? sorted
      : sorted.slice(sorted.length - this.#maxSnapshots);
  }

  /** 把份数压回上限，返回被淘汰的快照 ID（按访问时间由久到近）。 */
  #enforceSnapshotCap(entries: readonly SnapshotIndexEntry[]): string[] {
    const kept = sortByAccessTime(entries);
    const evicted: string[] = [];
    while (kept.length > this.#maxSnapshots) {
      const victim = kept.shift();
      if (victim === undefined) break;
      this.#remove(snapshotKey(victim.snapshot_id));
      evicted.push(victim.snapshot_id);
    }
    return evicted;
  }

  #evictLeastRecentlyUsed(): string[] {
    const index = sortByAccessTime(this.#readIndex());
    const victim = index[0];
    if (victim === undefined) return [];
    this.#remove(snapshotKey(victim.snapshot_id));
    this.#writeIndex(index.slice(1));
    return [victim.snapshot_id];
  }

  #remove(key: string): void {
    try {
      this.#storage.removeItem(key);
    } catch {
      // 存储不可用时判定不变；下一致性由后续操作修复。
    }
  }

  #discard(snapshotId: string): void {
    this.#remove(snapshotKey(snapshotId));
    this.#writeIndex(this.#readIndex().filter((entry) => entry.snapshot_id !== snapshotId));
  }
}

const readSnapshotEnvelope = (value: unknown): EvidenceSnapshot | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // 复用公共契约的 `evidenceSnapshotIdSchema`（含 `.trim() === value` 精化），
  // 不在这里重复实现「非空且无首尾空格」的判定。
  if (!evidenceSnapshotIdSchema.safeParse(record.snapshot_id).success) return null;
  if (typeof record.captured_at !== "string" || record.captured_at.length === 0) return null;
  const versions = snapshotVersionsSchema.safeParse(record.versions);
  if (!versions.success) return null;
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const payloadRecord = payload as Record<string, unknown>;
  if (!("query_intent" in payloadRecord)) return null;
  if (!("deterministic_result" in payloadRecord)) return null;
  if (!("evidence" in payloadRecord)) return null;
  return value as EvidenceSnapshot;
};
