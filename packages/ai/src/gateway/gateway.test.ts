import { createOpenAiAdapter, type OpenAiResponsesClient } from "@logiplan/ai-provider-openai";
import { describe, expect, it } from "vitest";

import type { AdapterRequest, AdapterResult } from "../adapter/adapter-contract";
import { AI_AUDIT_FIELD_NAMES } from "../audit/audit-metadata";
import { resolveOutputSchema, resolveSystemPrompt } from "../config/registry";
import { AI_ROLE_ROUTES } from "../config/role-config";
import { buildFixedExampleAnalysis } from "../fixed-example/fixed-example";
import {
  defaultGatewayConfig,
  defaultGatewayRetryHooks,
  extractNeutralErrorCode,
  GATEWAY_BACKOFF_MIN_MS,
  runGateway,
  type GatewayRequest,
} from "./gateway";
import {
  adapterReturning,
  deterministicRetryHooks,
  fakeAdapter,
  gatewayConfig,
  gatewayRequest,
  liveAnalysis,
} from "./gateway-fixtures.test";

/**
 * 网关编排（切片 3b 执行步骤 3—5；AC3.2、AC3.5—AC3.9）。
 *
 * 全程注入假适配器 / 假客户端——**零真实调用、零付费、不读取任何密钥**。
 */

const fakeClock = (): (() => number) => {
  let t = 0;
  return () => (t += 5);
};

const run = (
  request: Partial<GatewayRequest> = {},
  invoke?: (req: AdapterRequest) => Promise<AdapterResult>,
) =>
  runGateway(
    gatewayConfig(),
    {
      adapter: invoke === undefined ? adapterReturning(liveAnalysis()) : fakeAdapter(invoke),
      retryHooks: deterministicRetryHooks(),
      now: fakeClock(),
    },
    gatewayRequest(request),
  );

describe("成功路径：路由 → 适配器 → 三检 → 中文输出与审计", () => {
  it("三检通过 → kind=live，保留真实生成答案类型", async () => {
    const outcome = await run();
    expect(outcome.kind).toBe("live");
    if (outcome.kind === "live") {
      expect(outcome.analysis.answer_type).toBe("LIVE_GENERATED");
      expect(outcome.analysis.limitations.status_labels).toContain(
        "相关性不等于因果 · 不得推断未记录的经营因果",
      );
      expect(
        outcome.analysis.recommendations.every((r) => r.scenario_validation_status === "NOT_RUN"),
      ).toBe(true);
    }
  });

  it("AC3.9 审计元数据完整：六项版本 + 全部字段落在 D-138 白名单内", async () => {
    const outcome = await run();
    const audit = outcome.audit;
    for (const value of [
      audit.provider,
      audit.model,
      audit.adapter_version,
      audit.system_prompt_version,
      audit.output_schema_version,
      audit.price_version,
    ]) {
      expect(value.length).toBeGreaterThan(0);
    }
    expect(audit.provider).toBe("openai");
    expect(audit.model).toBe("gpt-5.6-terra");
    expect(audit.system_prompt_version).toBe("analysis-v1");
    expect(audit.output_schema_version).toBe("G2_ANSWER_V1_0");
    expect(audit.price_version).toBe("PRICE_2026_V1");
    expect(audit.input_tokens).toBe(111);
    expect(audit.output_tokens).toBe(55);
    expect(audit.error_code).toBeNull();
    expect(audit.fell_back_to_fixed_example).toBe(false);
    expect(Object.keys(audit).sort()).toEqual([...AI_AUDIT_FIELD_NAMES].sort());
  });

  it("真实适配器 + 假客户端 + 真实注册表：链路端到端成立（协调项 4 接线）", async () => {
    const client: OpenAiResponsesClient = {
      responses: {
        create: async () => ({
          id: "resp_integration_1",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(liveAnalysis()) }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
      moderations: { create: async () => ({ results: [{ flagged: false }] }) },
    };
    const adapter = createOpenAiAdapter({
      client,
      safetyIdentifier: "anon-integration",
      priceVersion: "PRICE_2026_V1",
      costLookup: () => 0.0007,
      resolveSystemPrompt,
      resolveOutputSchema,
      hooks: { withHardTimeout: async (task) => ({ timedOut: false, value: await task() }) },
    });
    const outcome = await runGateway(
      gatewayConfig(),
      { adapter, retryHooks: deterministicRetryHooks() },
      gatewayRequest(),
    );
    expect(outcome.kind).toBe("live");
    if (outcome.kind === "live") expect(outcome.audit.provider).toBe("openai");
  });
});

describe("失败关闭：任一检不过即整体丢弃并回落固定示例（AC3.5—AC3.8）", () => {
  const failing: readonly (readonly [string, unknown])[] = [
    [
      "模式校验失败（缺字段）",
      (() => {
        const clone = { ...(liveAnalysis() as Record<string, unknown>) };
        delete clone.impact;
        return clone;
      })(),
    ],
    [
      "模式校验失败（空文本）",
      { ...(liveAnalysis() as object), conclusion: { text: "", evidence_ids: [] } },
    ],
    [
      "未知证据",
      (() => {
        const a = liveAnalysis() as { conclusion: { evidence_ids: string[] } };
        return {
          ...(liveAnalysis() as object),
          conclusion: {
            ...a.conclusion,
            evidence_ids: [...a.conclusion.evidence_ids, "UNKNOWN:ID"],
          },
        };
      })(),
    ],
    [
      "额外数字",
      (() => {
        const a = liveAnalysis() as { impact: { text: string } };
        return {
          ...(liveAnalysis() as object),
          impact: { ...a.impact, text: `${a.impact.text} 另有 999,999.9999 CNY。` },
        };
      })(),
    ],
  ];

  for (const [label, output] of failing) {
    it(`${label} → fallback + 固定示例（AC3.7 整体丢弃）`, async () => {
      const outcome = await run({}, async (request) => ({
        provider: "openai",
        model: request.model,
        providerRequestId: "resp_x",
        structuredOutput: output,
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 3,
        costEstimate: { currency: "USD", amount: 0.0001, priceVersion: "PRICE_2026_V1" },
      }));
      expect(outcome.kind).toBe("fallback");
      // AC3.7：整体丢弃，返回**完整**固定示例（不是裁剪/修补后的部分输出）。
      expect(outcome.analysis).toEqual(buildFixedExampleAnalysis());
      expect(outcome.audit.fell_back_to_fixed_example).toBe(true);
      if (outcome.kind === "fallback") expect(outcome.statusZh.length).toBeGreaterThan(0);
    });
  }

  it("AC3.8：未通过三检时**不得**标为真实生成", async () => {
    const outcome = await run({}, async (request) => ({
      provider: "openai",
      model: request.model,
      providerRequestId: "resp_x",
      structuredOutput: { not: "a management analysis" },
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
      latencyMs: 3,
      costEstimate: { currency: "USD", amount: 0.0001, priceVersion: "PRICE_2026_V1" },
    }));
    expect(outcome.kind).toBe("fallback");
    expect(outcome.analysis.answer_type).toBe("FIXED_EXAMPLE");
    expect(outcome.analysis.answer_type).not.toBe("LIVE_GENERATED");
  });
});

describe("重试归属（切片 3b 协调项 2）", () => {
  it("429 一次后成功 → 恰好重试 1 次（共 2 次调用）", async () => {
    let calls = 0;
    const outcome = await run({}, async (request) => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new Error("rate limited"), { code: "PROVIDER_RATE_LIMITED" });
      return {
        provider: "openai",
        model: request.model,
        providerRequestId: "resp_retry",
        structuredOutput: liveAnalysis(),
        usage: { inputTokens: 2, outputTokens: 2 },
        finishReason: "stop",
        latencyMs: 4,
        costEstimate: { currency: "USD", amount: 0.0002, priceVersion: "PRICE_2026_V1" },
      };
    });
    expect(calls).toBe(2);
    expect(outcome.kind).toBe("live");
  });

  it("持续 429 → 恰好 2 次调用后回落固定示例", async () => {
    let calls = 0;
    const outcome = await run({}, async () => {
      calls += 1;
      throw Object.assign(new Error("rate limited"), { code: "PROVIDER_RATE_LIMITED" });
    });
    expect(calls).toBe(2);
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind === "fallback") expect(outcome.errorCode).toBe("PROVIDER_RATE_LIMITED");
  });

  it("超时不重试（恰好 1 次调用）", async () => {
    let calls = 0;
    const outcome = await run({}, async () => {
      calls += 1;
      throw Object.assign(new Error("timeout"), { code: "PROVIDER_TIMEOUT" });
    });
    expect(calls).toBe(1);
    if (outcome.kind === "fallback") expect(outcome.errorCode).toBe("PROVIDER_TIMEOUT");
  });
});

describe("AC3.2 穷尽性：11 个 GatewayErrorCode 都有转换路径", () => {
  const adapterCodes = [
    "INPUT_REJECTED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_REQUEST_INVALID",
  ] as const;

  for (const code of adapterCodes) {
    it(`适配器侧 ${code} → 原样回落`, async () => {
      const outcome = await run({}, async () => {
        throw Object.assign(new Error(code), { code });
      });
      expect(outcome.kind).toBe("fallback");
      if (outcome.kind === "fallback") expect(outcome.errorCode).toBe(code);
    });
  }

  it("中立层三检码：SCHEMA_VALIDATION_FAILED / EVIDENCE_WHITELIST_VIOLATION / NUMERIC_MISMATCH", async () => {
    const schema = await run({}, async (request) => ({
      provider: "openai",
      model: request.model,
      providerRequestId: "r",
      structuredOutput: {},
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
      latencyMs: 1,
      costEstimate: { currency: "USD", amount: 0, priceVersion: "PRICE_2026_V1" },
    }));
    expect(schema.kind === "fallback" && schema.errorCode).toBe("SCHEMA_VALIDATION_FAILED");

    const evidence = await run({}, async (request) => ({
      provider: "openai",
      model: request.model,
      providerRequestId: "r",
      structuredOutput: (() => {
        const a = liveAnalysis() as { conclusion: { evidence_ids: string[] } };
        return {
          ...(liveAnalysis() as object),
          conclusion: { ...a.conclusion, evidence_ids: ["X:Y"] },
        };
      })(),
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
      latencyMs: 1,
      costEstimate: { currency: "USD", amount: 0, priceVersion: "PRICE_2026_V1" },
    }));
    expect(evidence.kind === "fallback" && evidence.errorCode).toBe("EVIDENCE_WHITELIST_VIOLATION");

    const numeric = await run({}, async (request) => ({
      provider: "openai",
      model: request.model,
      providerRequestId: "r",
      structuredOutput: (() => {
        const a = liveAnalysis() as { impact: { text: string } };
        return {
          ...(liveAnalysis() as object),
          impact: { ...a.impact, text: `${a.impact.text} 1,234,567.8912 CNY。` },
        };
      })(),
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
      latencyMs: 1,
      costEstimate: { currency: "USD", amount: 0, priceVersion: "PRICE_2026_V1" },
    }));
    expect(numeric.kind === "fallback" && numeric.errorCode).toBe("NUMERIC_MISMATCH");
  });

  for (const code of ["RATE_LIMITED", "BUDGET_EXCEEDED", "CONTROL_PLANE_UNAVAILABLE"] as const) {
    it(`控制面 ${code} → 预检拒绝即不调用、原样回落`, async () => {
      let calls = 0;
      const outcome = await runGateway(
        gatewayConfig(),
        {
          adapter: fakeAdapter(async () => {
            calls += 1;
            throw new Error("should not be called");
          }),
          retryHooks: deterministicRetryHooks(),
        },
        gatewayRequest({ preflight: { liveCallPermitted: false, errorCode: code } }),
      );
      expect(calls).toBe(0);
      expect(outcome.kind).toBe("fallback");
      if (outcome.kind === "fallback") expect(outcome.errorCode).toBe(code);
    });
  }

  it("控制面拒绝但未给错误码（errorCode=null）→ CONTROL_PLANE_UNAVAILABLE 且零调用", async () => {
    let calls = 0;
    const outcome = await runGateway(
      gatewayConfig(),
      {
        adapter: fakeAdapter(async () => {
          calls += 1;
          throw new Error("should not be called");
        }),
        retryHooks: deterministicRetryHooks(),
      },
      gatewayRequest({ preflight: { liveCallPermitted: false, errorCode: null } }),
    );
    expect(calls).toBe(0);
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind === "fallback") expect(outcome.errorCode).toBe("CONTROL_PLANE_UNAVAILABLE");
  });

  it("未知角色 → PROVIDER_UNAVAILABLE（失败关闭，不静默降级）", async () => {
    const outcome = await run({ role: "not_a_role" as never });
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind === "fallback") expect(outcome.errorCode).toBe("PROVIDER_UNAVAILABLE");
  });

  it("适配器未声明的必需能力 → PROVIDER_REQUEST_INVALID，且不调用", async () => {
    let calls = 0;
    const outcome = await runGateway(
      gatewayConfig(),
      {
        adapter: fakeAdapter(
          async () => {
            calls += 1;
            throw new Error("should not be called");
          },
          {
            capabilities: {
              structuredOutput: false,
              reasoningControl: true,
              dataRetentionToggle: true,
              safetyIdentifier: true,
              moderation: true,
            },
          },
        ),
        retryHooks: deterministicRetryHooks(),
      },
      gatewayRequest(),
    );
    expect(calls).toBe(0);
    if (outcome.kind === "fallback") expect(outcome.errorCode).toBe("PROVIDER_REQUEST_INVALID");
  });
});

describe("中立错误码结构提取（不导入适配器包）", () => {
  it("只接受 11 个中立码值；其余归一为 null（调用方回落 PROVIDER_UNAVAILABLE）", () => {
    expect(extractNeutralErrorCode({ code: "PROVIDER_TIMEOUT" })).toBe("PROVIDER_TIMEOUT");
    expect(extractNeutralErrorCode({ code: "ENOENT" })).toBeNull();
    expect(extractNeutralErrorCode(new Error("x"))).toBeNull();
    expect(extractNeutralErrorCode(null)).toBeNull();
  });

  it("无中立码的抛出 → 回落 PROVIDER_UNAVAILABLE", async () => {
    const outcome = await run({}, async () => {
      throw new Error("no neutral code");
    });
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind === "fallback") expect(outcome.errorCode).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("默认装配（defaultGatewayConfig / defaultGatewayRetryHooks）", () => {
  it("defaultGatewayConfig 取受版本控制的价格与角色配置", () => {
    const config = defaultGatewayConfig("production");
    expect(config.environment).toBe("production");
    expect(config.priceVersion).toBe("PRICE_2026_V1");
    expect(config.routes).toBe(AI_ROLE_ROUTES);
  });

  it("默认重试钩子：直通超时（每次尝试的硬超时由适配器施加）+ 短随机退避", async () => {
    const hooks = defaultGatewayRetryHooks(() => 0);
    await expect(hooks.withHardTimeout(async () => "ok")).resolves.toEqual({
      timedOut: false,
      value: "ok",
    });
    const startedAt = Date.now();
    await hooks.backoff(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(GATEWAY_BACKOFF_MIN_MS - 20);
  });
});
