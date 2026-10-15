import { describe, expect, it, vi } from "vitest";

import {
  FIXED_EXAMPLE_SUPPORTED_NUMBERS,
  L1CircuitBreaker,
  allCapabilitiesGranted,
  buildFixedExampleAnalysis,
  deriveBudgetThreshold,
  FX_VERSION_V1,
  PRICE_VERSION_V1,
  reserveBudget,
  type EvidenceWhitelist,
} from "@logiplan/ai";
import { FixedClock, InMemoryRedisLike } from "@logiplan/ai/test-doubles";
import type {
  AnalysisScope,
  DeterministicResultEnvelope,
  EvidenceObject,
  QueryIntent,
} from "@logiplan/contracts";

import {
  AI_EVIDENCE_FAMILIES,
  buildNeutralEvidenceWhitelist,
  collectAnswerEvidenceIds,
  type AiEvidenceFamily,
} from "../app/lib/ai-model";

/**
 * 服务端装配层的**集成测试**（D-192）：网页 → 控制面 → 网关 → 适配器。
 *
 * `vi.mock` 替换 `./query-server`（真实数据库客户端）⇒ **不触库、不联网、不读密钥**；
 * 控制面用注入的替身运行时（`createRuntime` 接缝）与内存 Redis 替身。全程**零真实调用**。
 */

const state = vi.hoisted(() => ({
  data: null as unknown,
  failNext: false,
}));

vi.mock("../app/lib/query-server", () => ({
  loadAttributionData: async () => {
    if (state.failNext) throw new Error("deterministic source unavailable");
    return state.data;
  },
}));

const { answerManagementQuestion } = await import("../app/lib/ai-server");

const CLOCK_MS = 1_760_000_000_000;

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

const SNAPSHOT_IDS: Readonly<Record<AiEvidenceFamily, string>> = {
  country: "ES-11111111-1111-4111-8111-111111111111",
  bridge: "ES-22222222-2222-4222-8222-222222222222",
  diagnostics: "ES-33333333-3333-4333-8333-333333333333",
  drilldown: "ES-44444444-4444-4444-8444-444444444444",
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

const resultOf = (
  family: AiEvidenceFamily,
  evidence: EvidenceObject[],
  scope: AnalysisScope = QUERY_INTENT.scope,
): DeterministicResultEnvelope => {
  const snapshotId = SNAPSHOT_IDS[family];
  return {
    contract_version: "V1.1",
    query_intent: { ...QUERY_INTENT, scope },
    evidence,
    result_id: `Q-${snapshotId}`,
    scope_label: "英国",
    data_as_of: "2026-09-01T00:00:00.000Z",
    generated_at: "2026-09-01T00:00:00.000Z",
    reporting_currency: "CNY",
    precision: { calculation: "HIGH_PRECISION_DECIMAL", report_places: 4, display_places: 2 },
    // 该结果集「支持」的数字宇宙：取固定示例的已校验数字，使三检的数值回指可通过。
    payload: { supported_numbers: [...FIXED_EXAMPLE_SUPPORTED_NUMBERS] },
    warnings: [],
  };
};

/** 固定示例引用的全部证据 ID 按族轮流分配到四个结果集（形状合法即可）。 */
const buildData = () => {
  const cited = collectAnswerEvidenceIds(buildFixedExampleAnalysis());
  const byFamily = new Map<AiEvidenceFamily, EvidenceObject[]>(
    AI_EVIDENCE_FAMILIES.map((family) => [family, []]),
  );
  cited.forEach((evidenceId, index) => {
    const family = AI_EVIDENCE_FAMILIES[index % AI_EVIDENCE_FAMILIES.length];
    if (family === undefined) return;
    byFamily.get(family)?.push(evidenceObject(evidenceId, SNAPSHOT_IDS[family]));
  });
  return {
    country: resultOf("country", byFamily.get("country") ?? []),
    bridge: resultOf("bridge", byFamily.get("bridge") ?? []),
    diagnostics: resultOf("diagnostics", byFamily.get("diagnostics") ?? []),
    drilldown: resultOf("drilldown", byFamily.get("drilldown") ?? []),
  };
};

/** 合法真实生成输出（形状与固定示例一致，仅答案类型不同）。 */
const liveOutput = () => ({ ...buildFixedExampleAnalysis(), answer_type: "LIVE_GENERATED" });

const fakeAdapter = (structuredOutput: unknown) => ({
  adapterVersion: "fake-adapter-1",
  capabilities: { ...allCapabilitiesGranted },
  invoke: async () => ({
    provider: "openai",
    model: "gpt-5.6-terra",
    providerRequestId: "resp_fake_1",
    structuredOutput,
    usage: { inputTokens: 111, outputTokens: 55 },
    finishReason: "stop",
    latencyMs: 12,
    costEstimate: { currency: "USD" as const, amount: 0.00042, priceVersion: PRICE_VERSION_V1 },
  }),
});

const runtimeFor = (redis: InMemoryRedisLike) => ({
  deps: { redis, breaker: new L1CircuitBreaker(redis), clock: new FixedClock(CLOCK_MS) },
  config: {
    environment: "test",
    secret: "test-secret",
    threshold: deriveBudgetThreshold(PRICE_VERSION_V1, FX_VERSION_V1),
    currentPriceVersion: PRICE_VERSION_V1,
    currentFxVersion: FX_VERSION_V1,
    rateLimitWindowMs: 60_000,
    rateLimitLimit: 10,
    controlPlaneTimeoutMs: 2_000,
    roleCostProfiles: {
      intent_parse: { model: "gpt-5.6-luna", maxOutputTokens: 400 },
      management_analysis: { model: "gpt-5.6-terra", maxOutputTokens: 1200 },
      fallback: { model: "gpt-5.6-luna", maxOutputTokens: 400 },
    },
  },
});

const options = (overrides: Record<string, unknown> = {}) => ({
  environment: { NODE_ENV: "test" } as Record<string, string | undefined>,
  adapter: null as unknown,
  rawIp: "203.0.113.7",
  userAgent: "vitest/1.0",
  ...overrides,
});

const PAGE = "/attribution?destination=GB&period=2026-08";
const QUESTION = "英国 2026 年 8 月为什么超支？";

describe("D-192 服务端装配：网页 → 控制面 → 网关 → 适配器", () => {
  it("① 无适配器（门 C 未开启）→ 固定示例，且**完全不进入控制面**（不写账本、不写限流窗口）", async () => {
    state.data = buildData();
    state.failNext = false;
    const redis = new InMemoryRedisLike();
    let runtimeCalls = 0;
    const outcome = await answerManagementQuestion(
      PAGE,
      QUESTION,
      "req-1",
      options({
        createRuntime: async () => {
          runtimeCalls += 1;
          return runtimeFor(redis) as never;
        },
      }) as never,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message_zh);
    expect(outcome.status).toBe("FIXED_EXAMPLE");
    expect(outcome.answer.analysis.answer_type).toBe("FIXED_EXAMPLE");
    // 快照种子按族多份（D-191），与 evidence_snapshot_ids 一一对应。
    expect(outcome.answer.snapshot_seeds.length).toBeGreaterThan(0);
    expect(runtimeCalls).toBe(0);
    expect(redis.calls.budgetReserve).toBe(0);
    expect(redis.calls.slidingWindow).toBe(0);
  });

  it("② 有适配器 + 三检通过 → LIVE_GENERATED，且预留被结算为实际成本", async () => {
    state.data = buildData();
    const redis = new InMemoryRedisLike();
    const outcome = await answerManagementQuestion(
      PAGE,
      QUESTION,
      "req-2",
      options({
        adapter: fakeAdapter(liveOutput()),
        createRuntime: async () => runtimeFor(redis) as never,
      }) as never,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message_zh);
    expect(outcome.status).toBe("LIVE_GENERATED");
    expect(outcome.answer.analysis.answer_type).toBe("LIVE_GENERATED");
    expect(redis.calls.budgetSettle).toBe(1);
    expect(redis.calls.circuitRecordSuccess).toBe(1);
  });

  it("③ 预算不足（账本已达上限）→ 回落固定示例，零结算", async () => {
    state.data = buildData();
    const redis = new InMemoryRedisLike();
    const runtime = runtimeFor(redis);
    const seeded = await reserveBudget(redis, {
      threshold: runtime.config.threshold,
      nowMs: CLOCK_MS,
      requestId: "seed",
      amountCny: runtime.config.threshold.monthly_budget_cny - 0.01,
      currentPriceVersion: PRICE_VERSION_V1,
      currentFxVersion: FX_VERSION_V1,
    });
    expect(seeded.ok).toBe(true);
    const settlesBefore = redis.calls.budgetSettle;

    const outcome = await answerManagementQuestion(
      PAGE,
      QUESTION,
      "req-3",
      options({
        adapter: fakeAdapter(liveOutput()),
        createRuntime: async () => runtime as never,
      }) as never,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message_zh);
    expect(outcome.status).toBe("FIXED_EXAMPLE");
    expect(redis.calls.budgetSettle).toBe(settlesBefore);
  });

  it("④ 输出越界（凭空数字）→ 回落固定示例；供应商已响应 ⇒ 照样结算实际成本", async () => {
    state.data = buildData();
    const redis = new InMemoryRedisLike();
    const fixed = buildFixedExampleAnalysis();
    const bogus = {
      ...fixed,
      answer_type: "LIVE_GENERATED",
      conclusion: { ...fixed.conclusion, text: "凭空多出 999,999.9999 CNY 的不利差异。" },
    };
    const outcome = await answerManagementQuestion(
      PAGE,
      QUESTION,
      "req-4",
      options({
        adapter: fakeAdapter(bogus),
        createRuntime: async () => runtimeFor(redis) as never,
      }) as never,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message_zh);
    expect(outcome.status).toBe("FIXED_EXAMPLE");
    expect(redis.calls.budgetSettle).toBe(1);
  });

  it("⑤ 证据结果集不属于同一范围 → 整体丢弃（EVIDENCE_WHITELIST_VIOLATION）", async () => {
    const data = buildData();
    state.data = {
      ...data,
      diagnostics: resultOf("diagnostics", data.diagnostics.evidence, {
        ...QUERY_INTENT.scope,
        period: { from: "2026-09", to: "2026-09", grain: "MONTH" },
      }),
    };
    const outcome = await answerManagementQuestion(
      PAGE,
      QUESTION,
      "req-5",
      options({
        adapter: fakeAdapter(liveOutput()),
        createRuntime: async () => runtimeFor(new InMemoryRedisLike()) as never,
      }) as never,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("应整体丢弃");
    expect(outcome.status).toBe("EVIDENCE_WHITELIST_VIOLATION");
  });

  it("⑥ 确定性查询不可用 → 受控不可用，且**不进入控制面**", async () => {
    state.failNext = true;
    let runtimeCalls = 0;
    const outcome = await answerManagementQuestion(
      PAGE,
      QUESTION,
      "req-6",
      options({
        adapter: fakeAdapter(liveOutput()),
        createRuntime: async () => {
          runtimeCalls += 1;
          return runtimeFor(new InMemoryRedisLike()) as never;
        },
      }) as never,
    );
    state.failNext = false;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("应受控不可用");
    expect(outcome.status).toBe("DETERMINISTIC_SOURCE_UNAVAILABLE");
    expect(runtimeCalls).toBe(0);
  });

  it("夹具自证：四族同范围 ⇒ 单范围白名单四份结果集", () => {
    const whitelist: EvidenceWhitelist | null = buildNeutralEvidenceWhitelist(buildData() as never);
    expect(whitelist).not.toBeNull();
    expect(whitelist?.result_sets).toHaveLength(4);
  });
});
