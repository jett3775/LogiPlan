import { describe, expect, it } from "vitest";

import {
  allCapabilitiesGranted,
  noCapabilitiesGranted,
  PROVIDER_CAPABILITY_NAMES,
  type ProviderCapabilities,
} from "./capabilities";
import { OPENAI_ADAPTER_VERSION, PROVIDER_NAME, createOpenAiAdapter } from "./adapter";
import { MODERATION_MODEL } from "./moderation";
import { isProviderInvocationError } from "./errors";
import type { AdapterRequest, ProviderAdapter } from "./contract";
import {
  createFakeClient,
  fakeResponse,
  httpStatusError,
  makeAdapter,
  sampleRequest,
  timeoutEveryCall,
  timeoutFromCall,
} from "./test-doubles";

/** 取出并断言至少存在一条记录。 */
const first = <T>(items: readonly T[]): T => {
  const [head] = items;
  if (head === undefined) throw new Error("expected at least one recorded call");
  return head;
};

/** 断言适配器以指定标准化码值失败（且确为本包的中立错误类型）。 */
const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (isProviderInvocationError(error)) return error.code;
    throw error;
  }
  throw new Error("expected adapter.invoke to reject");
};

describe("能力缺失即失败关闭（AC3.1）", () => {
  for (const name of PROVIDER_CAPABILITY_NAMES) {
    it(`能力 ${name} 为 false 时返回标准化错误且完全不调用供应商`, async () => {
      const { client, calls } = createFakeClient({ response: async () => fakeResponse() });
      const capabilities: ProviderCapabilities = { ...allCapabilitiesGranted, [name]: false };
      const { adapter } = makeAdapter({ client, capabilities });
      expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("PROVIDER_REQUEST_INVALID");
      expect(calls.responses).toHaveLength(0);
      expect(calls.moderations).toHaveLength(0);
    });
  }

  it("全能力缺失同样失败关闭（不静默降级为自由文本）", async () => {
    const { client, calls } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client, capabilities: noCapabilitiesGranted });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("PROVIDER_REQUEST_INVALID");
    expect(calls.responses).toHaveLength(0);
  });

  it("adapter.capabilities 如实暴露能力声明，adapterVersion 为中立常量", () => {
    const { client } = createFakeClient();
    const { adapter } = makeAdapter({ client });
    expect(adapter.capabilities).toEqual(allCapabilitiesGranted);
    expect(adapter.adapterVersion).toBe(OPENAI_ADAPTER_VERSION);
  });
});

describe("请求字段（D-180 冻结）确实被设置", () => {
  it("store:false / 非流式 / 无工具 / safety_identifier / 推理强度 / 输出上限", async () => {
    const { client, calls } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client, safetyIdentifier: "anon-deadbeef" });
    const result = await adapter.invoke(
      sampleRequest({
        role: "management_analysis",
        model: "gpt-5.6-terra",
        systemPromptVersion: "analysis-v1",
        outputSchemaVersion: "analysis-schema-v1",
        maxOutputTokens: 1200,
      }),
    );

    const params = first(calls.responses);
    expect(params.store).toBe(false);
    expect("stream" in params).toBe(false);
    expect("tools" in params).toBe(false);
    expect("tool_choice" in params).toBe(false);
    expect(params.safety_identifier).toBe("anon-deadbeef");
    expect(params.reasoning.effort).toBe("low");
    expect(params.max_output_tokens).toBe(1200);
    expect(params.model).toBe("gpt-5.6-terra");
    expect(params.text.format.type).toBe("json_schema");

    // 审核使用冻结模型，且只审核用户输入。
    expect(first(calls.moderations)).toEqual({
      model: MODERATION_MODEL,
      input: sampleRequest().input,
    });

    expect(result.provider).toBe(PROVIDER_NAME);
    expect(result.model).toBe("gpt-5.6-terra");
    expect(result.providerRequestId).toBe("resp_test_1");
    expect(result.structuredOutput).toEqual({ answer: "ok" });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(result.finishReason).toBe("stop");
    expect(result.latencyMs).toBe(7);
  });

  it("意图解析角色取最低推理", async () => {
    const { client, calls } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client });
    await adapter.invoke(sampleRequest({ role: "intent_parse" }));
    expect(first(calls.responses).reasoning.effort).toBe("minimal");
  });
});

describe("内容审核（命中或异常 → INPUT_REJECTED，不重试）", () => {
  it("审核命中 → INPUT_REJECTED，不调用模型", async () => {
    const { client, calls } = createFakeClient({
      moderation: async () => ({ results: [{ flagged: true }] }),
      response: async () => fakeResponse(),
    });
    const { adapter } = makeAdapter({ client });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("INPUT_REJECTED");
    expect(calls.responses).toHaveLength(0);
    expect(calls.moderations).toHaveLength(1);
  });

  it("审核服务异常（抛错）→ INPUT_REJECTED，不调用模型", async () => {
    const { client, calls } = createFakeClient({
      moderation: async () => {
        throw httpStatusError(503);
      },
      response: async () => fakeResponse(),
    });
    const { adapter } = makeAdapter({ client });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("INPUT_REJECTED");
    expect(calls.responses).toHaveLength(0);
  });

  it("审核服务超时 → INPUT_REJECTED", async () => {
    const { client, calls } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client, withHardTimeout: timeoutEveryCall });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("INPUT_REJECTED");
    expect(calls.responses).toHaveLength(0);
  });
});

describe("单次尝试：重试由 packages/ai 的 retry-policy 承担（切片 3b 协调项 2）", () => {
  it("429 → PROVIDER_RATE_LIMITED，仅 1 次调用（不在适配器内重试）", async () => {
    const { client, calls } = createFakeClient({
      response: async () => {
        throw httpStatusError(429);
      },
    });
    const { adapter } = makeAdapter({ client });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("PROVIDER_RATE_LIMITED");
    expect(calls.responses).toHaveLength(1);
  });

  it("5xx → PROVIDER_UNAVAILABLE，仅 1 次调用", async () => {
    const { client, calls } = createFakeClient({
      response: async () => {
        throw httpStatusError(500);
      },
    });
    const { adapter } = makeAdapter({ client });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("PROVIDER_UNAVAILABLE");
    expect(calls.responses).toHaveLength(1);
  });

  it("4xx 参数错误 → PROVIDER_REQUEST_INVALID，仅 1 次调用", async () => {
    const { client, calls } = createFakeClient({
      response: async () => {
        throw httpStatusError(400);
      },
    });
    const { adapter } = makeAdapter({ client });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("PROVIDER_REQUEST_INVALID");
    expect(calls.responses).toHaveLength(1);
  });

  it("模型调用硬超时 → PROVIDER_TIMEOUT，仅 1 次调用", async () => {
    const { client, calls } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client, withHardTimeout: timeoutFromCall(2) });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("PROVIDER_TIMEOUT");
    expect(calls.responses).toHaveLength(1);
  });

  it("响应状态不可用（failed）→ PROVIDER_UNAVAILABLE，仅 1 次调用", async () => {
    const { client, calls } = createFakeClient({
      response: async () => fakeResponse({ status: "failed" }),
    });
    const { adapter } = makeAdapter({ client });
    expect(await rejectionCode(adapter.invoke(sampleRequest()))).toBe("PROVIDER_UNAVAILABLE");
    expect(calls.responses).toHaveLength(1);
  });
});

describe("版本解析与请求校验（失败关闭）", () => {
  it("未知提示词版本 → PROVIDER_REQUEST_INVALID，不调用供应商", async () => {
    const { client, calls } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client });
    expect(
      await rejectionCode(adapter.invoke(sampleRequest({ systemPromptVersion: "unknown" }))),
    ).toBe("PROVIDER_REQUEST_INVALID");
    expect(calls.moderations).toHaveLength(0);
  });

  it("未知输出模式版本 → PROVIDER_REQUEST_INVALID", async () => {
    const { client } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client });
    expect(
      await rejectionCode(adapter.invoke(sampleRequest({ outputSchemaVersion: "unknown" }))),
    ).toBe("PROVIDER_REQUEST_INVALID");
  });

  it("非法 maxOutputTokens / timeoutMs / 空 model → PROVIDER_REQUEST_INVALID", async () => {
    const { client } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client });
    expect(await rejectionCode(adapter.invoke(sampleRequest({ maxOutputTokens: 0 })))).toBe(
      "PROVIDER_REQUEST_INVALID",
    );
    expect(await rejectionCode(adapter.invoke(sampleRequest({ timeoutMs: -1 })))).toBe(
      "PROVIDER_REQUEST_INVALID",
    );
    expect(await rejectionCode(adapter.invoke(sampleRequest({ model: "  " })))).toBe(
      "PROVIDER_REQUEST_INVALID",
    );
  });

  it("运行时非法 role → PROVIDER_REQUEST_INVALID", async () => {
    const { client } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client });
    const badRole = { ...sampleRequest(), role: "not_a_role" } as unknown as AdapterRequest;
    expect(await rejectionCode(adapter.invoke(badRole))).toBe("PROVIDER_REQUEST_INVALID");
  });

  it("空提示词版本 / 非字符串输入 → PROVIDER_REQUEST_INVALID", async () => {
    const { client } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({ client });
    expect(await rejectionCode(adapter.invoke(sampleRequest({ systemPromptVersion: "   " })))).toBe(
      "PROVIDER_REQUEST_INVALID",
    );
    expect(await rejectionCode(adapter.invoke(sampleRequest({ outputSchemaVersion: "" })))).toBe(
      "PROVIDER_REQUEST_INVALID",
    );
    const nonStringInput = { ...sampleRequest(), input: 42 } as unknown as AdapterRequest;
    expect(await rejectionCode(adapter.invoke(nonStringInput))).toBe("PROVIDER_REQUEST_INVALID");
  });
});

describe("成本估算进入结果（价格版本单一来源 + 失败关闭）", () => {
  it("costEstimate 形如 { currency: USD, amount, priceVersion }", async () => {
    const { client } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({
      client,
      costLookup: () => 0.00042,
      priceVersion: "PRICE_2026_V1",
    });
    const result = await adapter.invoke(sampleRequest());
    expect(result.costEstimate).toEqual({
      currency: "USD",
      amount: 0.00042,
      priceVersion: "PRICE_2026_V1",
    });
  });

  it("未知模型 / 未知版本 → amount 为 Infinity（失败关闭，绝不当零成本放行）", async () => {
    const { client } = createFakeClient({ response: async () => fakeResponse() });
    const { adapter } = makeAdapter({
      client,
      costLookup: () => Number.POSITIVE_INFINITY,
      priceVersion: "PRICE_UNKNOWN",
    });
    const result = await adapter.invoke(sampleRequest({ model: "unknown-model" }));
    expect(result.costEstimate.amount).toBe(Number.POSITIVE_INFINITY);
    expect(result.costEstimate.amount).not.toBe(0);
    expect(result.costEstimate.priceVersion).toBe("PRICE_UNKNOWN");
  });
});

describe("构造期校验（失败关闭）", () => {
  const base = { client: createFakeClient().client };

  it("空 safetyIdentifier 或空 priceVersion → 构造即抛错", () => {
    expect(() => makeAdapter({ ...base, safetyIdentifier: "   " })).toThrow();
    expect(() => makeAdapter({ ...base, priceVersion: "" })).toThrow();
  });

  it("capabilities 可注入（用于能力门测试）", () => {
    const adapter: ProviderAdapter = makeAdapter({
      ...base,
      capabilities: { ...allCapabilitiesGranted, moderation: false },
    }).adapter;
    expect(adapter.capabilities.moderation).toBe(false);
    expect(createOpenAiAdapter).toBeTypeOf("function");
  });
});
