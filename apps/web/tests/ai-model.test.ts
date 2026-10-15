import { describe, expect, it } from "vitest";

import type {
  EvidenceObject,
  ManagementAnalysis,
  MoneyValue,
  QueryIntent,
} from "@logiplan/contracts";
import { EvidenceSnapshotStore, deriveAnonymousId, type SessionStorageLike } from "@logiplan/ai";

import {
  AI_EVIDENCE_FAMILIES,
  FIXED_EXAMPLE_SNAPSHOT_VERSIONS,
  bindAnswerToRealSnapshot,
  buildAnswerSnapshotSeeds,
  buildEvidenceWhitelist,
  buildNeutralEvidenceWhitelist,
  canonicalScopeAnchor,
  deriveSafetyIdentifier,
  parseAiRespondRequest,
  verifyAnswerRecovery,
  type AiAnswerBlock,
} from "../app/lib/ai-model";
import type {
  AttributionData,
  BridgePayload,
  CountryPayload,
  DeterministicResult,
  DiagnosticPayload,
  DrilldownPayload,
} from "../app/lib/model";

/**
 * D-191：**生产装配路径**的单元测试。
 *
 * 中立层 `verifySnapshotRecovery` 的单测用的是合成 fixture；这里补上「服务端如何决定
 * 下几份种子」这一层——`bindAnswerToRealSnapshot` 与 `buildAnswerSnapshotSeeds` 在
 * `apps/web/app/lib/ai-model.ts`，此前只有 Playwright 覆盖（需真实数据库，不在
 * `pnpm test` 内）。本文件把它拉进默认测试集，使「按族多份」这一性质在**本机**即可验证：
 * 若 `buildAnswerSnapshotSeeds` 退化为只下发 `country`，下面的用例会失败。
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

const SNAPSHOT_IDS = {
  country: "ES-11111111-1111-4111-8111-111111111111",
  bridge: "ES-22222222-2222-4222-8222-222222222222",
  diagnostics: "ES-33333333-3333-4333-8333-333333333333",
  drilldown: "ES-44444444-4444-4444-8444-444444444444",
} as const;

const EVIDENCE_IDS = {
  country: "E01-country",
  bridge: "E05-bridge",
  diagnostics: "E10-orders",
  drilldown: "ATTRIBUTION_DRILLDOWN:FC:DE_FC",
} as const;

const money = (value: string): MoneyValue => ({
  high_precision: value,
  report: value,
  display: value,
  currency: "CNY",
});

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

const resultOf = <T>(
  snapshotId: string,
  evidence: EvidenceObject[],
  payload: T,
): DeterministicResult<T> => ({
  contract_version: "V1.1",
  result_id: `Q-${snapshotId}`,
  query_intent: QUERY_INTENT,
  scope_label: "英国",
  data_as_of: "2026-09-01T00:00:00.000Z",
  generated_at: "2026-09-01T00:00:00.000Z",
  reporting_currency: "CNY",
  precision: { calculation: "HIGH_PRECISION_DECIMAL", report_places: 4, display_places: 2 },
  payload,
  evidence,
  warnings: [],
});

const attributionData = (): AttributionData => ({
  country: resultOf(
    SNAPSHOT_IDS.country,
    [evidenceObject(EVIDENCE_IDS.country, SNAPSHOT_IDS.country)],
    {
      destination_country_id: "GB",
      baseline: money("1.0000"),
      current: money("2.0000"),
      variance: money("1.0000"),
    } satisfies CountryPayload,
  ),
  bridge: resultOf(
    SNAPSHOT_IDS.bridge,
    [evidenceObject(EVIDENCE_IDS.bridge, SNAPSHOT_IDS.bridge)],
    {
      baseline: money("1.0000"),
      factors: [],
      current: money("2.0000"),
      reconciliation_delta: money("0.0000"),
      method: "CHAIN",
    } satisfies BridgePayload,
  ),
  diagnostics: resultOf(
    SNAPSHOT_IDS.diagnostics,
    [evidenceObject(EVIDENCE_IDS.diagnostics, SNAPSHOT_IDS.diagnostics)],
    {
      diagnostics: [],
      service_evaluation: {
        maturity_status: "NOT_FINAL",
        status_label_zh: "服务成熟度未定稿",
        on_time_denominator_policy_zh: "在途包裹不进入准时率分母",
        maturity_definition_zh: "服务成熟度定义",
      },
    } satisfies DiagnosticPayload,
  ),
  drilldown: resultOf(
    SNAPSHOT_IDS.drilldown,
    [evidenceObject(EVIDENCE_IDS.drilldown, SNAPSHOT_IDS.drilldown)],
    {
      rows: [],
      primary_contribution: "VARIANCE",
      method: "CHAIN",
    } satisfies DrilldownPayload,
  ),
});

/** 一个跨四族引用证据的回答（每族一条）。 */
const analysis = (evidenceBySection: {
  conclusion: string[];
  evidence: string[];
  impact: string[];
  recommendation: string[];
}): ManagementAnalysis => ({
  answer_id: "ANSWER_TEST_V1",
  answer_type: "FIXED_EXAMPLE",
  scope_label: "2026 年 8 月｜英国｜Actual vs Budget｜测试",
  conclusion: { text: "结论正文。", evidence_ids: evidenceBySection.conclusion },
  evidence: { text: "证据正文。", evidence_ids: evidenceBySection.evidence },
  impact: { text: "影响正文。", evidence_ids: evidenceBySection.impact },
  recommendations: [
    {
      text: "建议正文。",
      evidence_ids: evidenceBySection.recommendation,
      scenario_validation_status: "NOT_RUN",
      feasibility_status: "NOT_VALIDATED",
    },
  ],
  limitations: { text: "限制正文。", evidence_ids: [] },
  evidence_snapshot_ids: ["PLACEHOLDER"],
  evaluation_question_ids: ["E01"],
});

const ALL_FAMILIES_ANALYSIS = analysis({
  conclusion: [EVIDENCE_IDS.country],
  evidence: [EVIDENCE_IDS.bridge],
  impact: [EVIDENCE_IDS.diagnostics],
  recommendation: [EVIDENCE_IDS.drilldown],
});

const sortedSnapshotIds = (): string[] => [...Object.values(SNAPSHOT_IDS)].sort();

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

describe("D-191 生产装配：按族多份种子 + 页面恢复", () => {
  it("绑定回答引用的**全部**快照（四族），而不是单一主证据的快照", () => {
    const binding = bindAnswerToRealSnapshot(
      ALL_FAMILIES_ANALYSIS,
      buildEvidenceWhitelist(attributionData()),
    );
    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error(`绑定失败：${binding.missing.join(",")}`);
    expect(binding.evidence_snapshot_ids).toEqual(sortedSnapshotIds());
    expect(binding.analysis.evidence_snapshot_ids).toEqual(sortedSnapshotIds());
  });

  it("为每个被引用族各产出一份种子（四份），载荷含该族证据", () => {
    const binding = bindAnswerToRealSnapshot(
      ALL_FAMILIES_ANALYSIS,
      buildEvidenceWhitelist(attributionData()),
    );
    if (!binding.ok) throw new Error("绑定应成功");
    const seeds = buildAnswerSnapshotSeeds(binding.cited, attributionData());
    expect(seeds).not.toBeNull();
    const list = seeds ?? [];
    expect([...list].map((seed) => seed.family).sort()).toEqual([...AI_EVIDENCE_FAMILIES].sort());
    expect([...list].map((seed) => seed.evidence_snapshot_id).sort()).toEqual(sortedSnapshotIds());
    for (const seed of list) {
      const citedInFamily = binding.cited.filter((entry) => entry.family === seed.family);
      expect(citedInFamily.length).toBeGreaterThan(0);
      for (const entry of citedInFamily) {
        expect(seed.payload.evidence.some((item) => item.evidence_id === entry.evidence_id)).toBe(
          true,
        );
      }
    }
  });

  it("写入四份种子后恢复成立：每条引用证据都可解析", () => {
    const binding = bindAnswerToRealSnapshot(
      ALL_FAMILIES_ANALYSIS,
      buildEvidenceWhitelist(attributionData()),
    );
    if (!binding.ok) throw new Error("绑定应成功");
    const seeds = buildAnswerSnapshotSeeds(binding.cited, attributionData()) ?? [];
    const store = new EvidenceSnapshotStore({
      storage: new MemoryStorage(),
      clock: { now: () => 1 },
    });
    const answer: AiAnswerBlock = {
      scope_label: binding.analysis.scope_label,
      answer_type: binding.analysis.answer_type,
      analysis: binding.analysis,
      evidence: binding.cited,
      snapshot_seeds: seeds,
    };
    for (const seed of seeds) {
      const written = store.write({
        snapshot_id: seed.evidence_snapshot_id,
        captured_at: "2026-09-01T00:00:00.000Z",
        versions: FIXED_EXAMPLE_SNAPSHOT_VERSIONS,
        payload: seed.payload,
      });
      expect(written.status, `${seed.family} 应写入成功`).toBe("written");
    }
    const recovery = verifyAnswerRecovery(answer, store, FIXED_EXAMPLE_SNAPSHOT_VERSIONS);
    expect(recovery.ok).toBe(true);
    if (!recovery.ok) throw new Error(`恢复失败：${recovery.reason}/${recovery.detail}`);
    expect(recovery.resolved_snapshot_ids).toEqual(sortedSnapshotIds());
  });

  it("反向对照：只引用 country 一族时只产出一份种子（证明按族分组真的生效）", () => {
    const countryOnly = analysis({
      conclusion: [EVIDENCE_IDS.country],
      evidence: [],
      impact: [],
      recommendation: [],
    });
    const binding = bindAnswerToRealSnapshot(
      countryOnly,
      buildEvidenceWhitelist(attributionData()),
    );
    if (!binding.ok) throw new Error("绑定应成功");
    expect(binding.evidence_snapshot_ids).toEqual([SNAPSHOT_IDS.country]);
    const seeds = buildAnswerSnapshotSeeds(binding.cited, attributionData()) ?? [];
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.family).toBe("country");
  });
});

describe("浏览器输入边界（D-174）", () => {
  it("顶层 evidence_snapshot_ids 也按证据 ID 类受控拒绝", () => {
    const parsed = parseAiRespondRequest({
      question: "英国 2026 年 8 月为什么超支？",
      page_address: "/attribution",
      evidence_snapshot_ids: ["ES-1"],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("应拒绝");
    expect(parsed.category).toBe("evidence_id");
  });
});

describe("D-192 装配边界：中立证据白名单与匿名标识", () => {
  it("范围锚点剔除 factor_id，且与键的书写顺序无关", () => {
    const base = attributionData().country.query_intent.scope;
    const withFactor = { ...base, factor_id: "MIX" as const };
    expect(canonicalScopeAnchor(withFactor)).toBe(canonicalScopeAnchor(base));

    // 同一范围的字段换个书写顺序，锚点不变（键按字典序规范化）。
    const left = {
      comparison: "ACTUAL_VS_BUDGET" as const,
      period: { from: "2026-08", to: "2026-08", grain: "MONTH" as const },
      budget_version_id: "BUDGET_2026_V1",
      calculation_version: "D-092",
    };
    const right = {
      calculation_version: "D-092",
      budget_version_id: "BUDGET_2026_V1",
      period: { from: "2026-08", to: "2026-08", grain: "MONTH" as const },
      comparison: "ACTUAL_VS_BUDGET" as const,
    };
    expect(canonicalScopeAnchor(left)).toBe(canonicalScopeAnchor(right));
  });

  it("四族同范围 → 单范围白名单：锚点一致、四份结果集、证据与数字来自结果本身", () => {
    const whitelist = buildNeutralEvidenceWhitelist(attributionData());
    expect(whitelist).not.toBeNull();
    const list = whitelist ?? { scope_anchor: "", result_sets: [] };
    expect(list.result_sets).toHaveLength(4);
    for (const set of list.result_sets) expect(set.scope_anchor).toBe(list.scope_anchor);
    const ids = new Set(list.result_sets.flatMap((set) => set.evidence_ids));
    for (const id of Object.values(EVIDENCE_IDS)) expect(ids.has(id)).toBe(true);
    expect(list.result_sets.some((set) => set.numbers.includes("574474.2232"))).toBe(true);
  });

  it("drilldown 带 factor_id（页面选了因素）仍判为单范围——锚点剔除 factor_id 的直接效果", () => {
    const base = attributionData();
    const withFactor = {
      ...base,
      drilldown: {
        ...base.drilldown,
        query_intent: {
          ...base.drilldown.query_intent,
          scope: { ...base.drilldown.query_intent.scope, factor_id: "MIX" as const },
        },
      },
    };
    const whitelist = buildNeutralEvidenceWhitelist(withFactor as never);
    expect(whitelist).not.toBeNull();
    expect(whitelist?.result_sets).toHaveLength(4);
    for (const set of whitelist?.result_sets ?? []) {
      expect(set.scope_anchor).toBe(whitelist?.scope_anchor);
    }
  });

  it("四族范围不一致 → 返回 null（失败关闭，不组装多范围白名单）", () => {
    const base = attributionData();
    const divergent = {
      ...base,
      diagnostics: {
        ...base.diagnostics,
        query_intent: {
          ...base.diagnostics.query_intent,
          scope: {
            ...base.diagnostics.query_intent.scope,
            period: { from: "2026-09", to: "2026-09", grain: "MONTH" as const },
          },
        },
      },
    };
    expect(buildNeutralEvidenceWhitelist(divergent)).toBeNull();
  });

  it("匿名标识：缺主密钥 → null；有主密钥 → 与控制面按同组输入派生的值一致", async () => {
    const inputs = { rawIp: "203.0.113.7", userAgent: "vitest/1.0", nowMs: 1_760_000_000_000 };
    expect(await deriveSafetyIdentifier({ environment: {}, ...inputs })).toBeNull();
    const derived = await deriveSafetyIdentifier({
      environment: { LOGIPLAN_AI_ANON_SECRET: "test-secret" },
      ...inputs,
    });
    const controlPlaneValue = await deriveAnonymousId({ ...inputs, secret: "test-secret" });
    expect(derived).not.toBeNull();
    expect(derived).toBe(controlPlaneValue);
  });
});
