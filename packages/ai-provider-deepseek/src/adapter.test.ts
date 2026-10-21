import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderAdapter as NeutralProviderAdapter } from "../../ai/src/adapter/adapter-contract";
import { defaultGatewayConfig, runGateway } from "../../ai/src/gateway/gateway";
import { createDeepSeekAdapter, DEEPSEEK_CAPABILITIES } from "./adapter";
import { isProviderInvocationError, ProviderInvocationError } from "./errors";
import type {
  AdapterRequest,
  DeepSeekResponseLike,
  DeepSeekResponsesClient,
  DeepSeekResponsesCreateParams,
} from "./types";

const request = (overrides: Partial<AdapterRequest> = {}): AdapterRequest => ({
  role: "management_analysis",
  model: "deepseek-v4-pro",
  systemPromptVersion: "analysis-v1",
  outputSchemaVersion: "schema-v1",
  input: "分析已注入的确定性证据。",
  evidenceWhitelist: ["E01"],
  reasoningEffort: "low",
  maxOutputTokens: 1200,
  timeoutMs: 20_000,
  ...overrides,
});

const response = (overrides: Partial<DeepSeekResponseLike> = {}): DeepSeekResponseLike => ({
  id: "resp_deepseek_1",
  model: "deepseek-v4-pro",
  status: "completed",
  output: [
    { type: "reasoning", summary: [] },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: '{"answer":"ok"}' }],
    },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 18,
  },
  ...overrides,
});

interface ClientDouble {
  readonly client: DeepSeekResponsesClient;
  readonly calls: DeepSeekResponsesCreateParams[];
  signal: AbortSignal | null;
}

const clientDouble = (
  create: (signal: AbortSignal) => Promise<DeepSeekResponseLike> = async () => response(),
): ClientDouble => {
  const state: ClientDouble = {
    calls: [],
    signal: null,
    client: {
      responses: {
        create: async (body, options) => {
          state.calls.push(body);
          state.signal = options.signal;
          return create(options.signal);
        },
      },
    },
  };
  return state;
};

const adapter = (double: ClientDouble, costLookup: () => number = () => 0.0012) =>
  createDeepSeekAdapter({
    client: double.client,
    priceVersion: "DEEPSEEK_PRICE_TEST_V1",
    costLookup,
    resolveSystemPrompt: (version) => (version === "analysis-v1" ? "system" : null),
    resolveOutputSchema: (version) =>
      version === "schema-v1" ? { type: "object", additionalProperties: false } : null,
    hooks: {
      now: (() => {
        let value = 100;
        return () => (value += 7);
      })(),
    },
  });

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    name: "ProviderInvocationError",
    code,
    message: `provider invocation failed: ${code}`,
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe("DeepSeek Responses 协议映射", () => {
  it("映射结构化请求和已完成响应，且不发送 store、safety_identifier 或工具字段", async () => {
    const double = clientDouble();
    const result = await adapter(double).invoke(request());

    expect(double.calls).toEqual([
      {
        model: "deepseek-v4-pro",
        instructions: "system",
        input: "分析已注入的确定性证据。",
        max_output_tokens: 1200,
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            name: "logiplan_structured_output",
            schema: { type: "object", additionalProperties: false },
          },
        },
      },
    ]);
    expect(result).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      providerRequestId: "resp_deepseek_1",
      structuredOutput: { answer: "ok" },
      usage: { inputTokens: 10, outputTokens: 8 },
      finishReason: "stop",
      latencyMs: 7,
      costEstimate: {
        currency: "USD",
        amount: 0.0012,
        priceVersion: "DEEPSEEK_PRICE_TEST_V1",
      },
    });
    expect(double.signal?.aborted).toBe(false);
  });

  it("导出的错误守卫只接受本包标准化错误", () => {
    expect(isProviderInvocationError(new ProviderInvocationError("PROVIDER_UNAVAILABLE"))).toBe(
      true,
    );
    expect(isProviderInvocationError(new Error("raw provider body"))).toBe(false);
  });

  it("在类型层结构兼容中立 ProviderAdapter", () => {
    const compatible: NeutralProviderAdapter = adapter(clientDouble());
    expect(compatible.adapterVersion).toBe("deepseek-responses-1");
  });

  it.each([
    [429, "PROVIDER_RATE_LIMITED"],
    [400, "PROVIDER_REQUEST_INVALID"],
    [401, "PROVIDER_REQUEST_INVALID"],
    [500, "PROVIDER_UNAVAILABLE"],
    [undefined, "PROVIDER_UNAVAILABLE"],
  ] as const)("供应商 status=%s 映射为 %s 且不泄漏正文", async (status, code) => {
    const secret = "sk-must-not-leak";
    const double = clientDouble(async () => {
      throw Object.assign(new Error(`response body ${secret}`), { status });
    });
    try {
      await adapter(double).invoke(request());
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderInvocationError);
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("失败关闭：响应、用量与价格", () => {
  it.each([
    ["undefined response", undefined],
    ["null response", null],
    ["scalar response", "completed"],
    ["incomplete", response({ status: "incomplete" })],
    ["failed", response({ status: "failed" })],
    ["completed with error", response({ error: { code: "internal_error" } })],
    ["completed with incomplete details", response({ incomplete_details: { reason: "length" } })],
    ["model mismatch", response({ model: "deepseek-flash" })],
    ["empty output", response({ output: [] })],
    [
      "bad message role",
      response({
        output: [
          {
            type: "message",
            role: "user",
            status: "completed",
            content: [{ type: "output_text", text: '{"answer":"ok"}' }],
          },
        ],
      }),
    ],
    [
      "refusal content",
      response({
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "no" }],
          },
        ],
      }),
    ],
    [
      "tool output",
      response({
        output: [
          { type: "function_call", name: "forbidden" },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: '{"answer":"ok"}' }],
          },
        ],
      }),
    ],
    [
      "reasoning text only",
      response({
        output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "x" }] }],
      }),
    ],
    [
      "invalid JSON",
      response({
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "not-json" }],
          },
        ],
      }),
    ],
  ])("%s 不作为正常结果", async (_label, badResponse) => {
    const double = clientDouble();
    const invalidClient: DeepSeekResponsesClient = {
      responses: { create: async () => badResponse },
    };
    await expectCode(
      createDeepSeekAdapter({
        client: invalidClient,
        priceVersion: "DEEPSEEK_PRICE_TEST_V1",
        costLookup: () => 0.001,
        resolveSystemPrompt: () => "system",
        resolveOutputSchema: () => ({ type: "object" }),
      }).invoke(request()),
      "PROVIDER_UNAVAILABLE",
    );
    expect(double.calls).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["NaN", { input_tokens: Number.NaN, output_tokens: 1, total_tokens: 1 }],
    ["negative", { input_tokens: -1, output_tokens: 1, total_tokens: 0 }],
    ["fractional", { input_tokens: 1.5, output_tokens: 1, total_tokens: 2.5 }],
    ["inconsistent total", { input_tokens: 1, output_tokens: 1, total_tokens: 3 }],
    [
      "bad cached tokens",
      {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 2 },
      },
    ],
    [
      "missing cached tokens",
      {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: {},
      },
    ],
    [
      "bad reasoning tokens",
      {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    ],
    [
      "missing reasoning tokens",
      {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        output_tokens_details: {},
      },
    ],
  ])("用量 %s 不默认为零", async (_label, usage) => {
    await expectCode(
      adapter(clientDouble(async () => response({ usage }))).invoke(request()),
      "PROVIDER_UNAVAILABLE",
    );
  });

  it.each([
    ["NaN", () => Number.NaN],
    ["Infinity", () => Number.POSITIVE_INFINITY],
    ["negative", () => -0.01],
    [
      "throws",
      () => {
        throw new Error("price table detail");
      },
    ],
  ])("价格查询 %s 使用保守不可用值而非零", async (_label, lookup) => {
    const result = await adapter(clientDouble(), lookup).invoke(request());
    expect(result.costEstimate.amount).toBe(Number.POSITIVE_INFINITY);
  });

  it("请求与注册表版本非法时不调用客户端", async () => {
    const double = clientDouble();
    await expectCode(
      adapter(double).invoke(request({ maxOutputTokens: 0 })),
      "PROVIDER_REQUEST_INVALID",
    );
    await expectCode(
      adapter(double).invoke(request({ outputSchemaVersion: "unknown" })),
      "PROVIDER_REQUEST_INVALID",
    );
    expect(double.calls).toHaveLength(0);
  });

  it("客户端同步抛错也映射为中立错误", async () => {
    const client: DeepSeekResponsesClient = {
      responses: {
        create: () => {
          throw Object.assign(new Error("raw sync response"), { status: 503 });
        },
      },
    };
    const deepseek = createDeepSeekAdapter({
      client,
      priceVersion: "DEEPSEEK_PRICE_TEST_V1",
      costLookup: () => 0.001,
      resolveSystemPrompt: () => "system",
      resolveOutputSchema: () => ({ type: "object" }),
    });
    await expectCode(deepseek.invoke(request()), "PROVIDER_UNAVAILABLE");
  });

  it("空价格版本在构造时拒绝", () => {
    const double = clientDouble();
    expect(() =>
      createDeepSeekAdapter({
        client: double.client,
        priceVersion: " ",
        costLookup: () => 0,
        resolveSystemPrompt: () => "system",
        resolveOutputSchema: () => ({ type: "object" }),
      }),
    ).toThrow("DeepSeek adapter requires a non-blank priceVersion");
  });
});

describe("超时与正式角色能力门", () => {
  it("超时时中止 signal、清理计时器且不等待悬挂客户端", async () => {
    vi.useFakeTimers();
    const double = clientDouble(
      (signal) =>
        new Promise<DeepSeekResponseLike>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted supplier body")));
        }),
    );
    const invocation = adapter(double).invoke(request({ timeoutMs: 25 }));
    const rejection = expectCode(invocation, "PROVIDER_TIMEOUT");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(double.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("能力固定如实声明且不可覆盖", () => {
    expect(DEEPSEEK_CAPABILITIES).toEqual({
      structuredOutput: true,
      reasoningControl: true,
      dataRetentionToggle: false,
      safetyIdentifier: false,
      moderation: false,
    });
  });

  it.each(["intent_parse", "management_analysis", "fallback"] as const)(
    "正式角色 %s 在网关能力门失败关闭且客户端零调用",
    async (role) => {
      const double = clientDouble();
      const deepseek = adapter(double);
      const outcome = await runGateway(
        defaultGatewayConfig("test"),
        { adapter: deepseek },
        {
          request_id: `req-deepseek-capability-gate-${role}`,
          role,
          input: "不会到达供应商",
          scope_anchor: "scope-test",
          evidence: { scope_anchor: "scope-test", result_sets: [] },
          preflight: { liveCallPermitted: true, errorCode: null },
        },
      );
      expect(outcome.kind).toBe("fallback");
      if (outcome.kind === "fallback") {
        expect(outcome.errorCode).toBe("PROVIDER_REQUEST_INVALID");
        expect(outcome.spend.attempts).toBe(0);
      }
      expect(double.calls).toHaveLength(0);
    },
  );
});
