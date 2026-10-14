import { describe, expect, it } from "vitest";

import type { DeterministicResultEnvelope, EvidenceObject, QueryIntent } from "@logiplan/contracts";

import type { EvidenceSnapshot, EvidenceSnapshotPayload } from "./snapshot-payload";
import {
  SNAPSHOT_RECOVERY_FAILURE_REASONS,
  distinctSnapshotIds,
  verifySnapshotRecovery,
  type EvidenceSnapshotSeed,
  type SnapshotEvidenceReference,
} from "./snapshot-recovery";
import { EvidenceSnapshotStore, type SessionStorageLike } from "./snapshot-store";
import type { SnapshotVersions } from "./snapshot-versions";

/**
 * D-191 决策四：把「页面恢复能力成立」做成**可机械判定**的性质——回答引用的**每一条**
 * 证据都能在已写入的快照中解析，且必须**跨族多份**。单份快照只能解析一族，正是本切片
 * 关闭的 P1 缺口，故第二条用例做反向对照。
 */

const VERSIONS: SnapshotVersions = {
  contract_version: "V1.1",
  data_release_id: "LOGIPLAN_2026_DEMO_V2",
  provider: "NOT_APPLIED_FIXED_EXAMPLE",
  model: "NOT_APPLIED_FIXED_EXAMPLE",
  prompt_version: "NOT_APPLIED_FIXED_EXAMPLE",
  output_schema_version: "G2_ANSWER_V2_0",
};

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

const evidenceObject = (evidenceId: string, snapshotId: string): EvidenceObject => ({
  evidence_id: evidenceId,
  evidence_snapshot_id: snapshotId,
  data_release_id: "LOGIPLAN_2026_DEMO_V2",
  metric: "国家履约变动成本差异",
  value: "574474.2232",
  unit: "CNY",
  period: { from: "2026-08", to: "2026-08" },
  comparison: "ACTUAL_VS_BUDGET",
  filters: {},
  group_by: [],
  versions: { budget: "BUDGET_2026_V1", actual: "ACTUAL_2026_08_CLOSE_V1", calculation: "D-092" },
  calculation_method: "CHAIN",
  source_result_id: `Q-${snapshotId}`,
  snapshot_generated_at: "2026-09-01T00:00:00.000Z",
  source_refs: [],
});

const resultEnvelope = (
  snapshotId: string,
  evidence: readonly EvidenceObject[],
): DeterministicResultEnvelope => ({
  contract_version: "V1.1",
  query_intent: QUERY_INTENT,
  evidence: [...evidence],
  result_id: `Q-${snapshotId}`,
  scope_label: "英国",
  data_as_of: "2026-09-01T00:00:00.000Z",
  generated_at: "2026-09-01T00:00:00.000Z",
  reporting_currency: "CNY",
  precision: { calculation: "HIGH_PRECISION_DECIMAL", report_places: 4, display_places: 2 },
  payload: { variance: "574474.2232" },
  warnings: [],
});

class MemoryStorage implements SessionStorageLike {
  readonly #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }
}

/** 四族各自的快照 ID；形态与数据库产出的 `ES-<uuid>` 一致。 */
const SNAPSHOT_IDS = {
  country: "ES-11111111-1111-4111-8111-111111111111",
  bridge: "ES-22222222-2222-4222-8222-222222222222",
  diagnostics: "ES-33333333-3333-4333-8333-333333333333",
  drilldown: "ES-44444444-4444-4444-8444-444444444444",
} as const;

interface Fixture {
  readonly store: EvidenceSnapshotStore;
  readonly seeds: readonly EvidenceSnapshotSeed[];
  readonly references: readonly SnapshotEvidenceReference[];
  readonly declared: readonly string[];
}

/** 四族各一份快照、各两条证据；引用覆盖全部四族。 */
const buildFixture = (): Fixture => {
  const store = new EvidenceSnapshotStore({
    storage: new MemoryStorage(),
    clock: { now: () => 1 },
  });
  const seeds: EvidenceSnapshotSeed[] = [];
  const references: SnapshotEvidenceReference[] = [];
  for (const [family, snapshotId] of Object.entries(SNAPSHOT_IDS)) {
    const evidence = [
      evidenceObject(`${family}-a`, snapshotId),
      evidenceObject(`${family}-b`, snapshotId),
    ];
    const payload: EvidenceSnapshotPayload = {
      query_intent: QUERY_INTENT,
      deterministic_result: resultEnvelope(snapshotId, evidence),
      evidence,
    };
    const snapshot: EvidenceSnapshot = {
      snapshot_id: snapshotId,
      captured_at: "2026-09-01T00:00:00.000Z",
      versions: VERSIONS,
      payload,
    };
    const written = store.write(snapshot);
    expect(written.status, `${family} 快照应写入成功`).toBe("written");
    seeds.push({ evidence_snapshot_id: snapshotId, payload });
    references.push(
      { evidence_id: `${family}-a`, evidence_snapshot_id: snapshotId },
      { evidence_id: `${family}-b`, evidence_snapshot_id: snapshotId },
    );
  }
  return { store, seeds, references, declared: Object.values(SNAPSHOT_IDS) };
};

describe("verifySnapshotRecovery（D-191 决策四）", () => {
  it("跨四族的多份快照：每条引用证据都可解析（核心性质）", () => {
    const { store, seeds, references, declared } = buildFixture();
    const outcome = verifySnapshotRecovery(references, seeds, declared, store, VERSIONS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.detail);
    expect(outcome.resolved_snapshot_ids).toEqual([...declared].sort());
  });

  it("反向对照：只保留 country 一份时，其他族的引用不可解析（正是被关闭的缺口）", () => {
    const { store, seeds, references } = buildFixture();
    const onlyCountry = seeds.filter((seed) => seed.evidence_snapshot_id === SNAPSHOT_IDS.country);
    const outcome = verifySnapshotRecovery(
      references,
      onlyCountry,
      [SNAPSHOT_IDS.country],
      store,
      VERSIONS,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("单份快照不应判定为可恢复");
    expect(outcome.reason).toBe("missing_seed");
  });

  it("引用的 evidence_id 不在其快照内 → evidence_unresolved", () => {
    const { store, seeds, references, declared } = buildFixture();
    const forged = [
      ...references,
      { evidence_id: "country-not-in-snapshot", evidence_snapshot_id: SNAPSHOT_IDS.country },
    ];
    const outcome = verifySnapshotRecovery(forged, seeds, declared, store, VERSIONS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("未知证据应判定不可恢复");
    expect(outcome.reason).toBe("evidence_unresolved");
    expect(outcome.detail).toBe("country-not-in-snapshot");
  });

  it("契约声明的快照集合与种子不一致 → seed_set_mismatch", () => {
    const { store, seeds, references, declared } = buildFixture();
    const outcome = verifySnapshotRecovery(
      references,
      seeds,
      [...declared, "ES-99999999-9999-4999-8999-999999999999"],
      store,
      VERSIONS,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("集合不一致应判定不可恢复");
    expect(outcome.reason).toBe("seed_set_mismatch");
  });

  it("六项版本任一不一致 → snapshot_not_restorable", () => {
    const { store, seeds, references, declared } = buildFixture();
    const outcome = verifySnapshotRecovery(references, seeds, declared, store, {
      ...VERSIONS,
      output_schema_version: "G2_ANSWER_V1_0",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("版本不一致应判定不可恢复");
    expect(outcome.reason).toBe("snapshot_not_restorable");
  });

  it("空引用或空种子 → no_references（不得判定能力成立）", () => {
    const { store, seeds, declared } = buildFixture();
    expect(verifySnapshotRecovery([], seeds, declared, store, VERSIONS)).toEqual({
      ok: false,
      reason: "no_references",
      detail: "empty",
    });
    expect(
      verifySnapshotRecovery(
        [{ evidence_id: "x", evidence_snapshot_id: "y" }],
        [],
        [],
        store,
        VERSIONS,
      ),
    ).toEqual({ ok: false, reason: "no_references", detail: "empty" });
  });

  it("快照内证据对象自带的快照 ID 与快照键不一致 → snapshot_binding_mismatch", () => {
    const store = new EvidenceSnapshotStore({
      storage: new MemoryStorage(),
      clock: { now: () => 1 },
    });
    const snapshotId = "ES-55555555-5555-4555-8555-555555555555";
    const evidence = [evidenceObject("country-x", "ES-somewhere-else")];
    const payload: EvidenceSnapshotPayload = {
      query_intent: QUERY_INTENT,
      deterministic_result: resultEnvelope(snapshotId, evidence),
      evidence,
    };
    expect(
      store.write({
        snapshot_id: snapshotId,
        captured_at: "2026-09-01T00:00:00.000Z",
        versions: VERSIONS,
        payload,
      }).status,
    ).toBe("written");
    const outcome = verifySnapshotRecovery(
      [{ evidence_id: "country-x", evidence_snapshot_id: snapshotId }],
      [{ evidence_snapshot_id: snapshotId, payload }],
      [snapshotId],
      store,
      VERSIONS,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("内部绑定不一致应判定不可恢复");
    expect(outcome.reason).toBe("snapshot_binding_mismatch");
  });

  it("失败原因枚举稳定（用于审计与测试）", () => {
    expect([...SNAPSHOT_RECOVERY_FAILURE_REASONS]).toEqual([
      "no_references",
      "seed_set_mismatch",
      "snapshot_not_restorable",
      "snapshot_binding_mismatch",
      "missing_seed",
      "evidence_unresolved",
    ]);
  });
});

describe("distinctSnapshotIds", () => {
  it("去重并按字典序稳定排序（集合语义，顺序可复现）", () => {
    expect(
      distinctSnapshotIds([
        { evidence_id: "b", evidence_snapshot_id: "ES-b" },
        { evidence_id: "a", evidence_snapshot_id: "ES-a" },
        { evidence_id: "b2", evidence_snapshot_id: "ES-b" },
      ]),
    ).toEqual(["ES-a", "ES-b"]);
  });

  it("空输入返回空列表", () => {
    expect(distinctSnapshotIds([])).toEqual([]);
  });
});
