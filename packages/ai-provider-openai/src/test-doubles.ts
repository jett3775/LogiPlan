/**
 * 测试替身（**仅测试使用**）：假客户端、假时钟、假超时执行器与公共夹具。
 *
 * 全程**不发起任何网络请求**、不读取任何 API key。所有适配器行为均以这些替身确定性驱动。
 */

import { allCapabilitiesGranted, type ProviderCapabilities } from "./capabilities";
import { createOpenAiAdapter, type HardTimeoutRunner, type OpenAiAdapterOptions } from "./adapter";
import type {
  OpenAiModerationResponseLike,
  OpenAiResponseLike,
  OpenAiResponsesClient,
  OpenAiResponsesCreateParams,
} from "./client-types";
import type { AdapterRequest, JsonSchema, ProviderAdapter } from "./contract";
import type { CostLookup } from "./cost";

export interface RecordedCalls {
  readonly responses: OpenAiResponsesCreateParams[];
  readonly moderations: { readonly model: string; readonly input: string }[];
}

export interface FakeClient {
  readonly client: OpenAiResponsesClient;
  readonly calls: RecordedCalls;
}

export interface FakeClientOptions {
  /** 第 N 次（从 1 起）响应调用的返回；缺省抛「未配置」。 */
  readonly response?: (attempt: number) => Promise<OpenAiResponseLike>;
  /** 审核调用；缺省返回未命中。 */
  readonly moderation?: () => Promise<OpenAiModerationResponseLike>;
}

export const createFakeClient = (options: FakeClientOptions = {}): FakeClient => {
  const calls: RecordedCalls = { responses: [], moderations: [] };
  let responseAttempt = 0;
  const client: OpenAiResponsesClient = {
    responses: {
      async create(body): Promise<OpenAiResponseLike> {
        calls.responses.push(body);
        responseAttempt += 1;
        if (options.response === undefined) throw new Error("fake client: response not configured");
        return options.response(responseAttempt);
      },
    },
    moderations: {
      async create(body): Promise<OpenAiModerationResponseLike> {
        calls.moderations.push({ model: body.model, input: body.input });
        if (options.moderation === undefined) return { results: [{ flagged: false }] };
        return options.moderation();
      },
    },
  };
  return { client, calls };
};

/** 构造带 HTTP `status` 的错误（模拟供应商错误，不依赖 SDK 错误类型）。 */
export const httpStatusError = (status: number): Error =>
  Object.assign(new Error(`http ${status}`), { status });

export interface CompletedResponseOverrides {
  readonly id?: string;
  readonly status?: string;
  readonly incompleteReason?: string;
  readonly text?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly usagePresent?: boolean;
}

/** 构造一个 Responses API 响应替身。 */
export const fakeResponse = (overrides: CompletedResponseOverrides = {}): OpenAiResponseLike => {
  const {
    id = "resp_test_1",
    status = "completed",
    incompleteReason,
    text = '{"answer":"ok"}',
    inputTokens = 120,
    outputTokens = 40,
    usagePresent = true,
  } = overrides;
  return {
    id,
    model: "gpt-5.6-luna",
    status,
    incomplete_details: incompleteReason === undefined ? null : { reason: incompleteReason },
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: usagePresent ? { input_tokens: inputTokens, output_tokens: outputTokens } : null,
  };
};

/** 恒超时的硬超时执行器（驱动 `PROVIDER_TIMEOUT` 分支）。 */
export const timeoutEveryCall: HardTimeoutRunner = async () => ({ timedOut: true });

/**
 * 前 `n - 1` 次放行、第 `n` 次起恒超时（用于「审核通过但模型调用超时」）。
 * 超时时仍**启动**任务（模拟调用已发出但悬挂），故假客户端能记录到该次调用。
 */
export const timeoutFromCall = (n: number): HardTimeoutRunner => {
  let count = 0;
  return async (task) => {
    count += 1;
    const started = task();
    if (count >= n) {
      void started.catch(() => undefined);
      return { timedOut: true };
    }
    return { timedOut: false, value: await started };
  };
};

/** 恒放行（不施加真实超时），使重试计数确定。 */
export const passthroughTimeout: HardTimeoutRunner = async (task) => ({
  timedOut: false,
  value: await task(),
});

/** 确定性递增时钟；每次调用 +7，便于断言 `latencyMs`。 */
export const makeClock = (): (() => number) => {
  let t = 0;
  return () => {
    t += 7;
    return t;
  };
};

const DEFAULT_PROMPTS: Readonly<Record<string, string>> = {
  "intent-v1": "解析用户意图，输出结构化意图。",
  "analysis-v1": "生成受控的管理分析。",
  "fallback-v1": "生成受控回退文案。",
};

const DEFAULT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  "intent-schema-v1": { type: "object", properties: { intent: { type: "string" } } },
  "analysis-schema-v1": { type: "object", properties: { conclusion: { type: "string" } } },
};

/** 一个符合 D-180 默认值的请求夹具。 */
export const sampleRequest = (overrides: Partial<AdapterRequest> = {}): AdapterRequest => ({
  role: "intent_parse",
  model: "gpt-5.6-luna",
  systemPromptVersion: "intent-v1",
  outputSchemaVersion: "intent-schema-v1",
  input: "上个月成本最高的目的国是哪个？",
  evidenceWhitelist: ["E01-country", "E04-total"],
  maxOutputTokens: 400,
  timeoutMs: 20_000,
  ...overrides,
});

export interface MakeAdapterOptions {
  readonly client: OpenAiResponsesClient;
  readonly capabilities?: ProviderCapabilities;
  readonly costLookup?: CostLookup;
  readonly priceVersion?: string;
  readonly safetyIdentifier?: string;
  readonly withHardTimeout?: HardTimeoutRunner;
}

export interface AdapterHarness {
  readonly adapter: ProviderAdapter;
}

/** 用替身装配适配器；注入确定性时钟（重试已移至 `packages/ai`，故无退避睡眠）。 */
export const makeAdapter = (options: MakeAdapterOptions): AdapterHarness => {
  const adapterOptions: OpenAiAdapterOptions = {
    client: options.client,
    safetyIdentifier: options.safetyIdentifier ?? "anon-9f2c4a1b7e6d",
    priceVersion: options.priceVersion ?? "PRICE_2026_V1",
    costLookup: options.costLookup ?? (() => 0.000123),
    capabilities: options.capabilities ?? allCapabilitiesGranted,
    resolveSystemPrompt: (version) => DEFAULT_PROMPTS[version] ?? null,
    resolveOutputSchema: (version) => DEFAULT_SCHEMAS[version] ?? null,
    hooks: {
      now: makeClock(),
      withHardTimeout: options.withHardTimeout ?? passthroughTimeout,
    },
  };
  return { adapter: createOpenAiAdapter(adapterOptions) };
};
