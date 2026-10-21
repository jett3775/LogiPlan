import { describe, expect, it } from "vitest";

import type { AdapterRequest, AdapterResult, ProviderAdapter } from "../adapter/adapter-contract";
import { allCapabilitiesGranted } from "../adapter/provider-capabilities";
import { AI_ROLE_ROUTES } from "../config/role-config";
import { PRICE_VERSION_V2 } from "../control-plane/pricing";
import { FIXED_EXAMPLE_SUPPORTED_NUMBERS } from "../fixed-example/evaluation-baseline";
import { buildFixedExampleAnalysis } from "../fixed-example/fixed-example";
import type { GatewayConfig, GatewayRequest } from "./gateway";
import type { EvidenceWhitelist } from "./evidence-port";
import type { RetryHooks } from "./retry-policy";

/**
 * 网关测试夹具（**仅测试使用**）。文件名以 `.test.ts` 结尾，故不进入生产源码扫描面
 * （`neutral-boundary.test.ts` / `no-live-call.test.ts`），且**不发起任何网络请求**。
 */

/** 固定示例对应的范围锚点（测试用的确定性标识，与真实 `canonicalScope` 形状无关）。 */
export const FIXED_EXAMPLE_SCOPE_ANCHOR = "SCOPE|GB|2026-08|ACTUAL_VS_BUDGET";

/** 固定示例引用的全部证据 ID。 */
export const fixedExampleEvidenceIds = (): readonly string[] => {
  const analysis = buildFixedExampleAnalysis();
  return [
    ...new Set([
      ...analysis.conclusion.evidence_ids,
      ...analysis.evidence.evidence_ids,
      ...analysis.impact.evidence_ids,
      ...analysis.limitations.evidence_ids,
      ...analysis.recommendations.flatMap((recommendation) => recommendation.evidence_ids),
    ]),
  ];
};

/** 与固定示例一致的注入白名单（单范围、单结果集）。 */
export const fixedExampleWhitelist = (): EvidenceWhitelist => ({
  scope_anchor: FIXED_EXAMPLE_SCOPE_ANCHOR,
  result_sets: [
    {
      result_id: "RESULT_GB_2026_08",
      scope_anchor: FIXED_EXAMPLE_SCOPE_ANCHOR,
      evidence_ids: fixedExampleEvidenceIds(),
      numbers: [...FIXED_EXAMPLE_SUPPORTED_NUMBERS],
    },
  ],
});

/** 合法的**真实生成**输出（形状与固定示例一致，仅答案类型与标识不同）。 */
export const liveAnalysis = (overrides: Record<string, unknown> = {}): unknown => ({
  ...buildFixedExampleAnalysis(),
  answer_id: "ANSWER_LIVE_GB_2026_08_V1",
  answer_type: "LIVE_GENERATED",
  ...overrides,
});

export const gatewayConfig = (overrides: Partial<GatewayConfig> = {}): GatewayConfig => ({
  environment: "test",
  priceVersion: PRICE_VERSION_V2,
  routes: AI_ROLE_ROUTES,
  ...overrides,
});

export const gatewayRequest = (overrides: Partial<GatewayRequest> = {}): GatewayRequest => ({
  request_id: "req-test-1",
  role: "management_analysis",
  input: "上个月英国履约变动成本为什么上升？",
  scope_anchor: FIXED_EXAMPLE_SCOPE_ANCHOR,
  evidence: fixedExampleWhitelist(),
  // 控制面结论必填：默认「允许调用」；拒绝场景由各用例覆盖。
  preflight: { liveCallPermitted: true, errorCode: null },
  ...overrides,
});

/** 确定性重试钩子：直通超时 + 零退避（不依赖真实定时器）。 */
export const deterministicRetryHooks = (): RetryHooks => ({
  withHardTimeout: async (task) => ({ timedOut: false, value: await task() }),
  backoff: async () => undefined,
});

/** 用注入函数装配假适配器（不联网、不读密钥）。 */
export const fakeAdapter = (
  invoke: (request: AdapterRequest) => Promise<AdapterResult>,
  overrides: Partial<ProviderAdapter> = {},
): ProviderAdapter => ({
  adapterVersion: "fake-adapter-1",
  capabilities: { ...allCapabilitiesGranted },
  invoke,
  ...overrides,
});

/** 返回固定结构化输出的假适配器。 */
export const adapterReturning = (structuredOutput: unknown): ProviderAdapter =>
  fakeAdapter(async (request) => ({
    provider: "deepseek",
    model: request.model,
    providerRequestId: "resp_fake_1",
    structuredOutput,
    usage: { inputTokens: 111, outputTokens: 55 },
    finishReason: "stop",
    latencyMs: 12,
    costEstimate: { currency: "USD", amount: 0.00042, priceVersion: PRICE_VERSION_V2 },
  }));

/** 抛中立错误码的假适配器。 */
export const adapterThrowing = (code: string): ProviderAdapter =>
  fakeAdapter(async () => {
    throw Object.assign(new Error(`fake provider failure: ${code}`), { code });
  });

describe("网关测试夹具自证", () => {
  it("固定示例白名单覆盖固定示例引用的全部证据与数字", () => {
    const whitelist = fixedExampleWhitelist();
    const ids = new Set(whitelist.result_sets.flatMap((set) => set.evidence_ids));
    for (const id of fixedExampleEvidenceIds()) expect(ids.has(id)).toBe(true);
    expect(whitelist.result_sets[0]?.numbers).toEqual([...FIXED_EXAMPLE_SUPPORTED_NUMBERS]);
  });

  it("合法真实生成输出保留固定示例的必需限制标签与 NOT_RUN 状态", () => {
    const analysis = liveAnalysis() as {
      recommendations: readonly { scenario_validation_status: string }[];
    };
    expect(analysis.recommendations.every((r) => r.scenario_validation_status === "NOT_RUN")).toBe(
      true,
    );
  });
});
