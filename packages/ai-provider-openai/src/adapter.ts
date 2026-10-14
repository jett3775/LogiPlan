/**
 * OpenAI 适配器入口（设计 §1.3、§2；D-180）。
 *
 * 向上只暴露一个中立调用入口 `invoke` 与能力声明 `capabilities`；供应商的请求字段、
 * 响应结构、错误与用量在本包内全部标准化。**不含任何业务规则**（限流、预算、证据白名单、
 * 数值校验均在 `packages/ai`）。失败以 `ProviderInvocationError`（携带中立码值）抛出。
 *
 * ## 本切片（3a）不发起任何真实调用
 *
 * 客户端由调用方注入：本切片注入**假客户端**；切片 3b 在门 C 开启后才注入真实 SDK 客户端。
 * 本包不读取任何 API key、不联网。
 *
 * ## 单次尝试（切片 3b 协调项 2）
 *
 * `invoke` 只做**一次**供应商调用（外加一次调用前的审核）。429 / 5xx 的「恰好重试 1 次」
 * 由中立层 `packages/ai/src/gateway/retry-policy.ts` 承担——本包不再重试，避免两套重试
 * 策略叠加成最多 4 次尝试。
 */

import {
  allCapabilitiesGranted,
  capabilityGate,
  requiredCapabilitiesForRole,
  type ProviderCapabilities,
} from "./capabilities";
import type { OpenAiResponsesClient } from "./client-types";
import type { AdapterRequest, AdapterResult, JsonSchema, ProviderAdapter } from "./contract";
import { estimateCostUsd, type CostLookup } from "./cost";
import type { AdapterEmittedErrorCode } from "./error-partition";
import { mapProviderError } from "./error-mapping";
import { ProviderInvocationError } from "./errors";
import { moderateInput } from "./moderation";
import { buildResponsesRequest } from "./request-mapping";
import { isUsableResponseStatus, mapResponse, type NormalizedResponse } from "./response-mapping";
import { isAdapterRole } from "./roles";
import { runWithHardTimeout, type TimedResult } from "./timeout";

export const PROVIDER_NAME = "openai";
export const OPENAI_ADAPTER_VERSION = "openai-responses-1";

/** 可注入的硬超时执行器；测试用直通 / 恒超时实现确定性地驱动超时分支。 */
export type HardTimeoutRunner = <T>(
  task: () => Promise<T>,
  timeoutMs: number,
) => Promise<TimedResult<T>>;

export interface OpenAiAdapterHooks {
  readonly now?: () => number;
  readonly withHardTimeout?: HardTimeoutRunner;
}

export interface OpenAiAdapterOptions {
  /** 供应商客户端（本切片注入假客户端；切片 3b 注入真实 SDK 客户端）。 */
  readonly client: OpenAiResponsesClient;
  /** 仅匿名派生值；不得传原始 IP 或 User-Agent（D-138、D-181）。 */
  readonly safetyIdentifier: string;
  /** 价格版本（进入成本估算与审计）；价格表单一来源在 `packages/ai`。 */
  readonly priceVersion: string;
  /** 注入的美元价格查询函数（单一来源方案 a）；未知模型 / 版本应返回非有限值。 */
  readonly costLookup: CostLookup;
  /** 提示词版本 → 系统提示词文本；未知版本返回 `null`（失败关闭）。 */
  readonly resolveSystemPrompt: (version: string) => string | null;
  /** 输出模式版本 → 中立 JSON Schema；未知版本返回 `null`（失败关闭）。 */
  readonly resolveOutputSchema: (version: string) => JsonSchema | null;
  readonly capabilities?: ProviderCapabilities;
  readonly adapterVersion?: string;
  readonly hooks?: OpenAiAdapterHooks;
}

const isNonBlank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** 请求级前置校验：不合法即 `PROVIDER_REQUEST_INVALID`（4xx 类，不重试）。 */
const requestValidationError = (request: AdapterRequest): AdapterEmittedErrorCode | null => {
  if (!isAdapterRole(request.role)) return "PROVIDER_REQUEST_INVALID";
  if (!isNonBlank(request.model)) return "PROVIDER_REQUEST_INVALID";
  if (!isNonBlank(request.systemPromptVersion) || !isNonBlank(request.outputSchemaVersion)) {
    return "PROVIDER_REQUEST_INVALID";
  }
  if (typeof request.input !== "string") return "PROVIDER_REQUEST_INVALID";
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
    return "PROVIDER_REQUEST_INVALID";
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    return "PROVIDER_REQUEST_INVALID";
  }
  return null;
};

export const createOpenAiAdapter = (options: OpenAiAdapterOptions): ProviderAdapter => {
  const { client, safetyIdentifier, priceVersion, costLookup } = options;
  if (!isNonBlank(safetyIdentifier)) {
    throw new Error("OpenAI adapter requires a non-blank anonymous safetyIdentifier");
  }
  if (!isNonBlank(priceVersion)) {
    throw new Error("OpenAI adapter requires a non-blank priceVersion");
  }

  const capabilities = options.capabilities ?? allCapabilitiesGranted;
  const adapterVersion = options.adapterVersion ?? OPENAI_ADAPTER_VERSION;
  const now = options.hooks?.now ?? ((): number => Date.now());
  const withHardTimeout = options.hooks?.withHardTimeout ?? runWithHardTimeout;

  const buildResult = (
    normalized: NormalizedResponse,
    model: string,
    latencyMs: number,
  ): AdapterResult => ({
    provider: PROVIDER_NAME,
    model,
    providerRequestId: normalized.providerRequestId,
    structuredOutput: normalized.structuredOutput,
    usage: normalized.usage,
    finishReason: normalized.finishReason,
    latencyMs,
    costEstimate: {
      currency: "USD",
      amount: estimateCostUsd(costLookup, priceVersion, model, normalized.usage),
      priceVersion,
    },
  });

  const invoke = async (request: AdapterRequest): Promise<AdapterResult> => {
    const validationError = requestValidationError(request);
    if (validationError !== null) throw new ProviderInvocationError(validationError);

    // 能力缺失即失败关闭：不得静默降级为自由文本。
    const gate = capabilityGate(capabilities, requiredCapabilitiesForRole(request.role));
    if (!gate.ok) throw new ProviderInvocationError("PROVIDER_REQUEST_INVALID");

    const systemPrompt = options.resolveSystemPrompt(request.systemPromptVersion);
    const outputSchema = options.resolveOutputSchema(request.outputSchemaVersion);
    if (systemPrompt === null || outputSchema === null) {
      throw new ProviderInvocationError("PROVIDER_REQUEST_INVALID");
    }

    const decision = await moderateInput(client, request.input, withHardTimeout, request.timeoutMs);
    if (decision === "rejected") throw new ProviderInvocationError("INPUT_REJECTED");

    const params = buildResponsesRequest(request, { systemPrompt, outputSchema }, safetyIdentifier);

    // 单次尝试（切片 3b 协调项 2）：重试由 `packages/ai` 的 `gateway/retry-policy.ts` 承担，
    // 本包不再重试——两处重试叠加会变成最多 4 次尝试。
    const startedAt = now();
    const timed = await withHardTimeout(async () => {
      try {
        return { ok: true as const, response: await client.responses.create(params) };
      } catch (error) {
        return { ok: false as const, error };
      }
    }, request.timeoutMs);

    if (timed.timedOut) throw new ProviderInvocationError("PROVIDER_TIMEOUT");

    if (timed.value.ok && isUsableResponseStatus(timed.value.response.status)) {
      return buildResult(mapResponse(timed.value.response), request.model, now() - startedAt);
    }
    const code: AdapterEmittedErrorCode = timed.value.ok
      ? "PROVIDER_UNAVAILABLE"
      : mapProviderError(timed.value.error);
    throw new ProviderInvocationError(code);
  };

  return { adapterVersion, capabilities, invoke };
};
