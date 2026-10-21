import { mapProviderError, ProviderInvocationError } from "./errors";
import {
  ADAPTER_ROLES,
  type AdapterRequest,
  type AdapterResult,
  type AdapterUsage,
  type DeepSeekReasoningEffort,
  type DeepSeekResponsesClient,
  type DeepSeekResponsesCreateParams,
  type JsonSchema,
  type ProviderAdapter,
  type ProviderCapabilities,
} from "./types";

export const DEEPSEEK_PROVIDER_NAME = "deepseek";
export const DEEPSEEK_ADAPTER_VERSION = "deepseek-responses-1";
export const DEEPSEEK_CAPABILITIES: ProviderCapabilities = Object.freeze({
  structuredOutput: true,
  reasoningControl: true,
  dataRetentionToggle: false,
  safetyIdentifier: false,
  moderation: false,
});

export type CostLookup = (priceVersion: string, model: string, usage: AdapterUsage) => number;

type TimeoutResult<T> =
  { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

export type AbortTimeoutRunner = <T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
) => Promise<TimeoutResult<T>>;

export interface DeepSeekAdapterHooks {
  readonly now?: () => number;
  readonly withAbortTimeout?: AbortTimeoutRunner;
}

export interface DeepSeekAdapterOptions {
  readonly client: DeepSeekResponsesClient;
  readonly priceVersion: string;
  readonly costLookup: CostLookup;
  readonly resolveSystemPrompt: (version: string) => string | null;
  readonly resolveOutputSchema: (version: string) => JsonSchema | null;
  readonly adapterVersion?: string;
  readonly hooks?: DeepSeekAdapterHooks;
}

const runWithAbortTimeout: AbortTimeoutRunner = async (task, timeoutMs) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const taskResult = task(controller.signal).then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([taskResult, timeout]);
    if (result.kind === "timeout") return { timedOut: true };
    if (result.kind === "error") throw result.error;
    return { timedOut: false, value: result.value };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonBlank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isAdapterRole = (value: unknown): boolean =>
  typeof value === "string" && (ADAPTER_ROLES as readonly string[]).includes(value);

const ADAPTER_REASONING_EFFORTS = ["minimal", "low"] as const;

const isAdapterReasoningEffort = (value: unknown): boolean =>
  typeof value === "string" && (ADAPTER_REASONING_EFFORTS as readonly string[]).includes(value);

/**
 * 需求侧推理强度 → DeepSeek 档位（D-193）。
 *
 * DeepSeek 没有 `minimal`；把 `minimal` 映射为 `low` 会开启思考模式，而 `max_output_tokens`
 * 同时包含可见输出与推理 token，400 token 的预算会被推理占用，导致结构化输出被
 * 供应商以 `incomplete` 拒绝。因此 `minimal` 显式映射为 `none`（不思考），`low` 保持 `low`。
 */
const reasoningEffortForProvider = (
  effort: AdapterRequest["reasoningEffort"],
): DeepSeekReasoningEffort => (effort === "minimal" ? "none" : "low");

const validateRequest = (request: AdapterRequest): void => {
  if (
    !isAdapterRole(request.role) ||
    !isAdapterReasoningEffort(request.reasoningEffort) ||
    !isNonBlank(request.model) ||
    !isNonBlank(request.systemPromptVersion) ||
    !isNonBlank(request.outputSchemaVersion) ||
    typeof request.input !== "string" ||
    !Number.isInteger(request.maxOutputTokens) ||
    request.maxOutputTokens <= 0 ||
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0
  ) {
    throw new ProviderInvocationError("PROVIDER_REQUEST_INVALID");
  }
};

const buildRequest = (
  request: AdapterRequest,
  systemPrompt: string,
  outputSchema: JsonSchema,
): DeepSeekResponsesCreateParams => ({
  model: request.model,
  instructions: systemPrompt,
  input: request.input,
  max_output_tokens: request.maxOutputTokens,
  reasoning: { effort: reasoningEffortForProvider(request.reasoningEffort) },
  text: {
    format: {
      type: "json_schema",
      name: "logiplan_structured_output",
      schema: outputSchema,
    },
  },
});

const parseUsage = (value: unknown): AdapterUsage => {
  if (!isRecord(value)) throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
  const input = value.input_tokens;
  const output = value.output_tokens;
  const total = value.total_tokens;
  if (
    !isTokenCount(input) ||
    !isTokenCount(output) ||
    !isTokenCount(total) ||
    total !== input + output
  ) {
    throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
  }
  const inputDetails = value.input_tokens_details;
  if (inputDetails !== undefined) {
    if (!isRecord(inputDetails) || !isTokenCount(inputDetails.cached_tokens)) {
      throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
    }
    if (inputDetails.cached_tokens > input)
      throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
  }
  const outputDetails = value.output_tokens_details;
  if (outputDetails !== undefined) {
    if (!isRecord(outputDetails) || !isTokenCount(outputDetails.reasoning_tokens)) {
      throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
    }
    if (outputDetails.reasoning_tokens > output) {
      throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
    }
  }
  return { inputTokens: input, outputTokens: output };
};

const parseStructuredOutput = (value: unknown): unknown => {
  if (!Array.isArray(value)) throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
  const messages = value.filter((item) => isRecord(item) && item.type === "message");
  const unsupported = value.some(
    (item) => !isRecord(item) || (item.type !== "message" && item.type !== "reasoning"),
  );
  if (unsupported || messages.length !== 1) {
    throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
  }
  const message = messages[0];
  if (
    !isRecord(message) ||
    message.role !== "assistant" ||
    message.status !== "completed" ||
    !Array.isArray(message.content) ||
    message.content.length === 0
  ) {
    throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
  }
  const texts: string[] = [];
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== "output_text" || !isNonBlank(part.text)) {
      throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
    }
    texts.push(part.text);
  }
  try {
    const parsed: unknown = JSON.parse(texts.join(""));
    if (!isRecord(parsed)) throw new Error("structured output must be an object");
    return parsed;
  } catch {
    throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
  }
};

const mapResponse = (
  response: unknown,
  expectedModel: string,
): { readonly id: string; readonly output: unknown; readonly usage: AdapterUsage } => {
  if (
    !isRecord(response) ||
    !isNonBlank(response.id) ||
    response.status !== "completed" ||
    response.model !== expectedModel ||
    (response.error !== undefined && response.error !== null) ||
    (response.incomplete_details !== undefined && response.incomplete_details !== null)
  ) {
    throw new ProviderInvocationError("PROVIDER_UNAVAILABLE");
  }
  return {
    id: response.id,
    output: parseStructuredOutput(response.output),
    usage: parseUsage(response.usage),
  };
};

const estimateCost = (
  lookup: CostLookup,
  priceVersion: string,
  model: string,
  usage: AdapterUsage,
): number => {
  try {
    const cost = lookup(priceVersion, model, usage);
    return Number.isFinite(cost) && cost >= 0 ? cost : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const createDeepSeekAdapter = (options: DeepSeekAdapterOptions): ProviderAdapter => {
  if (!isNonBlank(options.priceVersion)) {
    throw new Error("DeepSeek adapter requires a non-blank priceVersion");
  }
  const now = options.hooks?.now ?? Date.now;
  const withAbortTimeout = options.hooks?.withAbortTimeout ?? runWithAbortTimeout;

  return {
    adapterVersion: options.adapterVersion ?? DEEPSEEK_ADAPTER_VERSION,
    capabilities: DEEPSEEK_CAPABILITIES,
    invoke: async (request): Promise<AdapterResult> => {
      validateRequest(request);
      const systemPrompt = options.resolveSystemPrompt(request.systemPromptVersion);
      const outputSchema = options.resolveOutputSchema(request.outputSchemaVersion);
      if (systemPrompt === null || outputSchema === null) {
        throw new ProviderInvocationError("PROVIDER_REQUEST_INVALID");
      }
      const body = buildRequest(request, systemPrompt, outputSchema);
      const startedAt = now();
      let timed: TimeoutResult<unknown>;
      try {
        timed = await withAbortTimeout(
          (signal) => options.client.responses.create(body, { signal }),
          request.timeoutMs,
        );
      } catch (error) {
        throw new ProviderInvocationError(mapProviderError(error));
      }
      if (timed.timedOut) throw new ProviderInvocationError("PROVIDER_TIMEOUT");
      const mapped = mapResponse(timed.value, request.model);
      const latencyMs = now() - startedAt;
      return {
        provider: DEEPSEEK_PROVIDER_NAME,
        model: request.model,
        providerRequestId: mapped.id,
        structuredOutput: mapped.output,
        usage: mapped.usage,
        finishReason: "stop",
        latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
        costEstimate: {
          currency: "USD",
          amount: estimateCost(
            options.costLookup,
            options.priceVersion,
            request.model,
            mapped.usage,
          ),
          priceVersion: options.priceVersion,
        },
      };
    },
  };
};
