import { describe, expect, it } from "vitest";

import type {
  DeterministicResultEnvelope,
  ManagementAnalysis,
  QueryIntent,
} from "@logiplan/contracts";

import {
  FAIL_CLOSED_TRIGGERS,
  allFailClosedDecisions,
  decideFailClosed,
} from "../gateway/fail-closed";
import { GATEWAY_ERROR_CODES, isGatewayErrorCode } from "../gateway/gateway-error-code";
import {
  MAX_SNAPSHOTS_PER_TAB,
  MAX_SNAPSHOT_BYTES,
  RESERVED_SNAPSHOT_ID,
  SNAPSHOT_KEY_PREFIX,
  SNAPSHOT_LRU_INDEX_KEY,
  EvidenceSnapshotStore,
  isReservedSnapshotId,
  snapshotByteLength,
  snapshotKey,
  type SessionStorageLike,
  type SnapshotClock,
} from "./snapshot-store";
import { SNAPSHOT_VERSION_FIELDS, type SnapshotVersions } from "./snapshot-versions";
import type { EvidenceSnapshot } from "./snapshot-payload";

/**
 * AC1.7：每标签页 20 份上限 + LRU 淘汰 + 单份 2 MB 上限；
 * 淘汰依据必须是**访问时间**，用访问序列证明。
 *
 * AC1.6（集成层）：六项版本校验任一不一致即不可恢复并丢弃快照。
 */

const QUERY_INTENT: QueryIntent = {
  question_type: "COUNTRY_VARIANCE_SUMMARY",
  scope: {
    period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
    comparison: "ACTUAL_VS_BUDGET",
    destination_country_ids: ["GB"],
    budget_version_id: "BUDGET_2026_V1",
    actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
    calculation_version: "D-092",
  },
  metrics: ["FULFILLMENT_VARIABLE_COST"],
  group_by: [],
  output_locale: "zh-CN",
  context_sources: ["FIXED_TEMPLATE"],
};

const DETERMINISTIC_RESULT: DeterministicResultEnvelope = {
  contract_version: "V1.0",
  query_intent: QUERY_INTENT,
  evidence: [],
  result_id: "Q-FIXTURE",
  scope_label: "英国",
  data_as_of: "2026-09-01T00:00:00.000Z",
  generated_at: "2026-09-01T00:00:00.000Z",
  reporting_currency: "CNY",
  precision: { calculation: "HIGH_PRECISION_DECIMAL", report_places: 4, display_places: 2 },
  payload: { variance: "574474.2232" },
  warnings: [],
};

const VERSIONS: SnapshotVersions = {
  contract_version: "V1.1",
  data_release_id: "LOGIPLAN_2026_DEMO_V2",
  provider: "PROVIDER_A",
  model: "MODEL_A",
  prompt_version: "PROMPT_V1",
  output_schema_version: "G2_ANSWER_V1_0",
};

const snapshot = (snapshotId: string, filler = ""): EvidenceSnapshot => ({
  snapshot_id: snapshotId,
  captured_at: "2026-09-01T00:00:00.000Z",
  versions: VERSIONS,
  payload: {
    query_intent: QUERY_INTENT,
    deterministic_result:
      filler === "" ? DETERMINISTIC_RESULT : { ...DETERMINISTIC_RESULT, payload: { filler } },
    evidence: [],
  },
});

class MemoryStorage implements SessionStorageLike {
  readonly #map = new Map<string, string>();
  #failOnWrite = false;
  #failOnRead = false;

  get length(): number {
    return this.#map.size;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    if (this.#failOnRead) throw new Error("storage read blocked");
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.#failOnWrite) throw new Error("quota exceeded");
    this.#map.set(key, value);
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  failWrites(): void {
    this.#failOnWrite = true;
  }

  failReads(): void {
    this.#failOnRead = true;
  }

  raw(): ReadonlyMap<string, string> {
    return this.#map;
  }

  /** 直接写入底层条目，用于构造损坏或被外部改写的存储状态。 */
  put(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

class TestClock implements SnapshotClock {
  #now: number;

  constructor(start = 1_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }
}

const newStore = (
  options: { maxSnapshots?: number; maxBytes?: number } = {},
): { store: EvidenceSnapshotStore; storage: MemoryStorage; clock: TestClock } => {
  const storage = new MemoryStorage();
  const clock = new TestClock();
  const store = new EvidenceSnapshotStore({ storage, clock, ...options });
  return { store, storage, clock };
};

const snapshotId = (index: number): string => `SNAPSHOT_${String(index).padStart(2, "0")}`;

describe("快照键名与常量", () => {
  it("键名遵循 D-190 决策四", () => {
    expect(snapshotKey("ABC")).toBe("logiplan.ai.snapshot.ABC");
    expect(SNAPSHOT_KEY_PREFIX).toBe("logiplan.ai.snapshot.");
    expect(SNAPSHOT_LRU_INDEX_KEY.startsWith(SNAPSHOT_KEY_PREFIX)).toBe(true);
    expect(MAX_SNAPSHOTS_PER_TAB).toBe(20);
    expect(MAX_SNAPSHOT_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("写入与枚举", () => {
  it("写入后可按 ID 恢复，且键名不含索引键", () => {
    const { store, storage, clock } = newStore();
    clock.advance(10);
    expect(store.write(snapshot("A"))).toEqual({
      status: "written",
      key: snapshotKey("A"),
      evicted: [],
    });
    expect(storage.raw().has(snapshotKey("A"))).toBe(true);
    expect(storage.raw().has(SNAPSHOT_LRU_INDEX_KEY)).toBe(true);
    expect(store.count()).toBe(1);
    const restored = store.restore("A", VERSIONS);
    expect(restored.status).toBe("restored");
    if (restored.status === "restored") {
      expect(restored.snapshot.snapshot_id).toBe("A");
      expect(restored.snapshot.versions).toEqual(VERSIONS);
    }
    expect(store.restore("MISSING", VERSIONS)).toEqual({ status: "not_found" });
  });

  it("存储不可用时失败关闭，不抛错", () => {
    const { store, storage } = newStore();
    storage.failWrites();
    expect(store.write(snapshot("A"))).toEqual({ status: "storage_unavailable" });
    storage.failReads();
    expect(store.restore("A", VERSIONS)).toEqual({ status: "not_found" });
  });

  it("序列化失败按存储不可用处理", () => {
    const { store } = newStore();
    const circular: Record<string, unknown> = { snapshot_id: "A" };
    circular.self = circular;
    expect(store.write(circular as unknown as EvidenceSnapshot)).toEqual({
      status: "storage_unavailable",
    });
  });
});

describe("AC1.7 每标签页 20 份上限与 LRU 淘汰", () => {
  it("第 21 份触发淘汰，且淘汰对象是最久未访问者而非最早写入者", () => {
    const { store, storage, clock } = newStore();
    for (let index = 1; index <= MAX_SNAPSHOTS_PER_TAB; index += 1) {
      clock.advance(1_000);
      expect(store.write(snapshot(snapshotId(index))).status).toBe("written");
    }
    expect(store.count()).toBe(MAX_SNAPSHOTS_PER_TAB);

    // 访问序列：只回看最早写入的两份，中间与最新的一份从不访问。
    clock.advance(1_000);
    expect(store.restore(snapshotId(1), VERSIONS).status).toBe("restored");
    clock.advance(1_000);
    expect(store.restore(snapshotId(2), VERSIONS).status).toBe("restored");

    clock.advance(1_000);
    const written = store.write(snapshot(snapshotId(21)));
    // FIFO 会淘汰 S01；LRU 必须淘汰 S03。
    expect(written.status).toBe("written");
    if (written.status !== "written") throw new Error("写入应成功");
    expect(written.evicted).toEqual([snapshotId(3)]);
    expect(store.count()).toBe(MAX_SNAPSHOTS_PER_TAB);
    expect(storage.raw().has(snapshotKey(snapshotId(1)))).toBe(true);
    expect(storage.raw().has(snapshotKey(snapshotId(2)))).toBe(true);
    expect(storage.raw().has(snapshotKey(snapshotId(3)))).toBe(false);
    expect(storage.raw().has(snapshotKey(snapshotId(21)))).toBe(true);
    expect(store.listByAccessTime()).toEqual([
      ...Array.from({ length: 17 }, (_unused, index) => snapshotId(index + 4)),
      snapshotId(1),
      snapshotId(2),
      snapshotId(21),
    ]);
  });

  it("无访问时按写入顺序淘汰，说明上限本身生效", () => {
    const { store, clock } = newStore();
    for (let index = 1; index <= MAX_SNAPSHOTS_PER_TAB; index += 1) {
      clock.advance(1_000);
      store.write(snapshot(snapshotId(index)));
    }
    clock.advance(1_000);
    const written = store.write(snapshot(snapshotId(21)));
    if (written.status !== "written") throw new Error("写入应成功");
    expect(written.evicted).toEqual([snapshotId(1)]);
    expect(store.listByAccessTime()).toHaveLength(MAX_SNAPSHOTS_PER_TAB);
    expect(store.restore(snapshotId(1), VERSIONS).status).toBe("not_found");
  });

  it("连续写入超过上限时逐份淘汰最久未访问者", () => {
    // 上限设为 4，让 3 份存量 + 2 次写入即可跨过上限。
    const { store, clock } = newStore({ maxSnapshots: 4 });
    for (let index = 1; index <= 3; index += 1) {
      clock.advance(1_000);
      store.write(snapshot(snapshotId(index)));
    }
    clock.advance(1_000);
    store.restore(snapshotId(1), VERSIONS);
    clock.advance(1_000);
    store.restore(snapshotId(2), VERSIONS);
    clock.advance(1_000);
    store.write(snapshot(snapshotId(4)));
    expect(store.count()).toBe(4);
    clock.advance(1_000);
    const second = store.write(snapshot(snapshotId(5)));
    if (second.status !== "written") throw new Error("写入应成功");
    expect(second.evicted).toEqual([snapshotId(3)]);
    expect(store.listByAccessTime()).toEqual([
      snapshotId(1),
      snapshotId(2),
      snapshotId(4),
      snapshotId(5),
    ]);
  });

  it("相同访问时间时退化为先访问者先淘汰，仍保持确定性", () => {
    const storage = new MemoryStorage();
    const store = new EvidenceSnapshotStore({
      storage,
      clock: { now: () => 5_000 },
      maxSnapshots: 2,
    });
    store.write(snapshot("A"));
    store.write(snapshot("B"));
    store.write(snapshot("C"));
    expect(store.listByAccessTime()).toEqual(["B", "C"]);
  });

  it("LRU 索引损坏或残缺时按存储键重建，不丢快照也不静默失败", () => {
    const { store, storage, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("B"));
    clock.advance(1_000);
    store.write(snapshot("A"));
    storage.put(SNAPSHOT_LRU_INDEX_KEY, "{ not json");
    expect([...store.listByAccessTime()].sort()).toEqual(["A", "B"]);
    clock.advance(1_000);
    store.write(snapshot("C"));
    expect(store.count()).toBe(3);
    // 残缺索引：存储里有的 B、C 必须被补回，否则它们将永远不被淘汰。
    storage.put(SNAPSHOT_LRU_INDEX_KEY, JSON.stringify([{ snapshot_id: "A" }]));
    expect([...store.listByAccessTime()].sort()).toEqual(["A", "B", "C"]);
    storage.put(SNAPSHOT_LRU_INDEX_KEY, JSON.stringify(["A", 7]));
    expect([...store.listByAccessTime()].sort()).toEqual(["A", "B", "C"]);
    // 已不存在的条目必须被丢弃，否则索引会无限增长。
    storage.put(SNAPSHOT_LRU_INDEX_KEY, JSON.stringify([{ snapshot_id: "GONE" }]));
    expect([...store.listByAccessTime()].sort()).toEqual(["A", "B", "C"]);
  });

  it("显式丢弃会同时删除快照与索引条目", () => {
    const { store, storage, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("A"));
    clock.advance(1_000);
    store.write(snapshot("B"));
    store.discard("A");
    expect(store.listByAccessTime()).toEqual(["B"]);
    expect(storage.raw().has(snapshotKey("A"))).toBe(false);
  });
});

describe("AC1.7 单份 2 MB 上限", () => {
  it("超过 2 MB 的快照被拒绝写入，并淘汰最久未访问的一份", () => {
    const { store, storage, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("KEEP"));
    clock.advance(1_000);
    const oversized = snapshot("TOO_LARGE", "填".repeat(700_000));
    expect(snapshotByteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
    const rejected = store.write(oversized);
    expect(rejected.status).toBe("rejected_too_large");
    if (rejected.status !== "rejected_too_large") throw new Error("应被拒绝");
    expect(rejected.evicted).toEqual(["KEEP"]);
    expect(storage.raw().has(snapshotKey("TOO_LARGE"))).toBe(false);
    expect(store.listByAccessTime()).toEqual([]);
    expect(store.restore("TOO_LARGE", VERSIONS).status).toBe("not_found");
  });

  it("恰好等于上限可写入，超一字节即拒绝（上限按 UTF-8 字节计）", () => {
    const base = snapshot("EDGE");
    const bytes = snapshotByteLength(JSON.stringify(base));
    expect(bytes).toBeGreaterThan(JSON.stringify(base).length);
    const { store } = newStore({ maxBytes: bytes });
    expect(store.write(base)).toEqual({
      status: "written",
      key: snapshotKey("EDGE"),
      evicted: [],
    });
    const exact = newStore({ maxBytes: bytes - 1 });
    expect(exact.store.write(base)).toEqual({ status: "rejected_too_large", evicted: [] });
  });

  it("空存储下的超限写入不产生任何淘汰记录", () => {
    const { store } = newStore();
    expect(store.write(snapshot("TOO_LARGE", "填".repeat(700_000)))).toEqual({
      status: "rejected_too_large",
      evicted: [],
    });
  });
});

describe("AC1.6 恢复时的六项版本校验", () => {
  it.each([...SNAPSHOT_VERSION_FIELDS])("%s 不一致即不可恢复并丢弃快照", (field) => {
    const { store, storage, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("A"));
    const expectedVersions: SnapshotVersions = { ...VERSIONS, [field]: "OTHER" };
    const restored = store.restore("A", expectedVersions);
    expect(restored.status).toBe("version_mismatch");
    if (restored.status !== "version_mismatch") throw new Error("应判定不可恢复");
    expect(restored.mismatches).toEqual([{ field, stored: VERSIONS[field], expected: "OTHER" }]);
    expect(JSON.stringify(restored)).not.toContain("restored");
    expect(storage.raw().has(snapshotKey("A"))).toBe(false);
    expect(store.listByAccessTime()).toEqual([]);
  });

  it("六项全部不一致时整体丢弃，不返回部分内容", () => {
    const { store, storage, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("A"));
    const restored = store.restore("A", {
      contract_version: "V1.0",
      data_release_id: "LOGIPLAN_2026_DEMO_V1",
      provider: "PROVIDER_B",
      model: "MODEL_B",
      prompt_version: "PROMPT_V2",
      output_schema_version: "G2_ANSWER_V0_9",
    });
    expect(restored.status).toBe("version_mismatch");
    if (restored.status !== "version_mismatch") throw new Error("应判定不可恢复");
    expect(restored.mismatches.map((mismatch) => mismatch.field)).toEqual([
      ...SNAPSHOT_VERSION_FIELDS,
    ]);
    expect(storage.raw().has(snapshotKey("A"))).toBe(false);
  });

  it("损坏的快照按不可恢复处理并丢弃", () => {
    const { store, storage, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("A"));
    storage.put(snapshotKey("A"), "{ not json");
    expect(store.restore("A", VERSIONS)).toEqual({ status: "corrupt", reason: "unparseable" });
    expect(storage.raw().has(snapshotKey("A"))).toBe(false);

    clock.advance(1_000);
    store.write(snapshot("B"));
    storage.put(
      snapshotKey("B"),
      JSON.stringify({ snapshot_id: "B", captured_at: "2026-09-01T00:00:00.000Z" }),
    );
    expect(store.restore("B", VERSIONS)).toEqual({ status: "corrupt", reason: "invalid_shape" });
    expect(storage.raw().has(snapshotKey("B"))).toBe(false);

    clock.advance(1_000);
    store.write(snapshot("C"));
    storage.put(
      snapshotKey("C"),
      JSON.stringify({
        snapshot_id: "C",
        captured_at: "2026-09-01T00:00:00.000Z",
        versions: { ...VERSIONS, extra: "x" },
        payload: {
          query_intent: QUERY_INTENT,
          deterministic_result: DETERMINISTIC_RESULT,
          evidence: [],
        },
      }),
    );
    expect(store.restore("C", VERSIONS).status).toBe("corrupt");

    clock.advance(1_000);
    store.write(snapshot("D"));
    storage.put(
      snapshotKey("D"),
      JSON.stringify({
        snapshot_id: "D",
        captured_at: "2026-09-01T00:00:00.000Z",
        versions: VERSIONS,
        payload: {},
      }),
    );
    expect(store.restore("D", VERSIONS)).toEqual({ status: "corrupt", reason: "invalid_shape" });

    clock.advance(1_000);
    store.write(snapshot("E"));
    storage.put(snapshotKey("E"), JSON.stringify({ snapshot_id: "", versions: VERSIONS }));
    expect(store.restore("E", VERSIONS)).toEqual({ status: "corrupt", reason: "invalid_shape" });
  });

  it("成功恢复会刷新访问时间，使该份不再是最久未访问者", () => {
    const { store, clock } = newStore({ maxSnapshots: 2 });
    clock.advance(1_000);
    store.write(snapshot("A"));
    clock.advance(1_000);
    store.write(snapshot("B"));
    clock.advance(1_000);
    expect(store.restore("A", VERSIONS).status).toBe("restored");
    clock.advance(1_000);
    store.write(snapshot("C"));
    expect(store.listByAccessTime()).toEqual(["A", "C"]);
    expect(store.restore("B", VERSIONS).status).toBe("not_found");
  });
});

describe("保留快照 ID 与索引裁剪", () => {
  it("快照 ID 恰好是保留名时拒绝写入，不覆盖 LRU 索引", () => {
    const { store, storage, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("KEEP"));
    expect(isReservedSnapshotId(RESERVED_SNAPSHOT_ID)).toBe(true);
    expect(snapshotKey(RESERVED_SNAPSHOT_ID)).toBe(SNAPSHOT_LRU_INDEX_KEY);
    expect(RESERVED_SNAPSHOT_ID).toBe("lru_index");

    const rejected = store.write(snapshot(RESERVED_SNAPSHOT_ID));
    expect(rejected).toEqual({ status: "rejected_reserved_id", snapshotId: RESERVED_SNAPSHOT_ID });
    // 索引仍是索引（不是快照正文），既有快照不受影响。
    expect(JSON.parse(storage.raw().get(SNAPSHOT_LRU_INDEX_KEY) ?? "[]")).toEqual([
      { snapshot_id: "KEEP", last_accessed_at: 2_000 },
    ]);
    expect(store.count()).toBe(1);
    expect(store.restore(RESERVED_SNAPSHOT_ID, VERSIONS)).toEqual({ status: "not_found" });
    expect(store.restore("KEEP", VERSIONS).status).toBe("restored");
    expect(isReservedSnapshotId("KEEP")).toBe(false);
    expect(isReservedSnapshotId("lru_index_extra")).toBe(false);
  });

  it("索引落盘前裁剪到上限，索引条目数不会超过存储份数上限", () => {
    const { store, storage, clock } = newStore({ maxSnapshots: 2 });
    const indexLength = (): number =>
      (JSON.parse(storage.raw().get(SNAPSHOT_LRU_INDEX_KEY) ?? "[]") as unknown[]).length;
    for (const id of ["A", "B", "C", "D", "E"]) {
      clock.advance(1_000);
      expect(store.write(snapshot(id)).status).toBe("written");
      expect(indexLength()).toBeLessThanOrEqual(2);
    }
    expect(store.count()).toBe(2);
    expect(indexLength()).toBe(2);
    // 裁剪只动索引体积：最近访问的两份仍在，淘汰判定不变。
    expect(store.listByAccessTime()).toEqual(["D", "E"]);
    clock.advance(1_000);
    expect(store.restore("D", VERSIONS).status).toBe("restored");
    expect(indexLength()).toBe(2);
  });

  it("快照 ID 含首尾空格或全为空白时判为损坏（复用公共契约精化）", () => {
    const { store, storage, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("A"));
    clock.advance(1_000);
    store.write(snapshot("B"));
    for (const [id, body] of [
      ["PADDED", JSON.stringify({ ...snapshot("PADDED"), snapshot_id: " PADDED " })],
      ["BLANK", JSON.stringify({ ...snapshot("BLANK"), snapshot_id: "   " })],
    ] as const) {
      storage.put(snapshotKey(id), body);
      expect(store.restore(id, VERSIONS), id).toEqual({
        status: "corrupt",
        reason: "invalid_shape",
      });
      expect(storage.raw().has(snapshotKey(id)), id).toBe(false);
    }
  });
});

describe("恢复失败时回落固定示例", () => {
  it("快照不可用时调用方拿到的仍是固定示例出口", () => {
    const { store, clock } = newStore();
    clock.advance(1_000);
    store.write(snapshot("A"));
    const restored = store.restore("A", {
      ...VERSIONS,
      model: "MODEL_OTHER",
    });
    const decision = decideFailClosed(
      restored.status === "version_mismatch"
        ? "SCHEMA_VALIDATION_FAILED"
        : "CONTROL_PLANE_UNAVAILABLE",
    );
    const analysis: ManagementAnalysis = {
      answer_id: "ANSWER_FIXED_GB_2026_08_V1",
      answer_type: "FIXED_EXAMPLE",
      scope_label: "2026 年 8 月｜英国｜Actual vs Budget｜固定示例",
      conclusion: { text: "固定示例", evidence_ids: ["country_summary|ACTUAL|2026-08|GB"] },
      evidence: { text: "固定示例", evidence_ids: ["country_summary|ACTUAL|2026-08|GB"] },
      impact: { text: "固定示例", evidence_ids: ["country_summary|ACTUAL|2026-08|GB"] },
      recommendations: [
        {
          text: "固定示例建议",
          evidence_ids: ["country_summary|ACTUAL|2026-08|GB"],
          scenario_validation_status: "NOT_RUN",
          feasibility_status: "NOT_VALIDATED",
        },
      ],
      limitations: { text: "固定示例", evidence_ids: ["country_summary|ACTUAL|2026-08|GB"] },
      evidence_snapshot_id: "SNAPSHOT_GB_2026_08_V1",
      evaluation_question_ids: ["E01"],
    };
    expect(decision.answerType).toBe("FIXED_EXAMPLE");
    expect(decision.liveCallAllowed).toBe(false);
    expect(analysis.answer_type).toBe("FIXED_EXAMPLE");
    expect(FAIL_CLOSED_TRIGGERS.length).toBeGreaterThan(0);
    expect(isGatewayErrorCode(decision.errorCode)).toBe(true);
    expect(GATEWAY_ERROR_CODES.length).toBeGreaterThan(0);
    expect(allFailClosedDecisions()).toHaveLength(GATEWAY_ERROR_CODES.length);
  });
});
