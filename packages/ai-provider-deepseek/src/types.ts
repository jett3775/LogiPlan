export const ADAPTER_ROLES = ["intent_parse", "management_analysis", "fallback"] as const;
export type AdapterRole = (typeof ADAPTER_ROLES)[number];

export interface ProviderCapabilities {
  readonly structuredOutput: boolean;
  readonly reasoningControl: boolean;
  readonly dataRetentionToggle: boolean;
  readonly safetyIdentifier: boolean;
  readonly moderation: boolean;
}

/** 需求侧推理强度：本包只接收 D-180 冻结的两档（最低 / 低）。 */
export type AdapterReasoningEffort = "minimal" | "low";

export interface AdapterRequest {
  readonly role: AdapterRole;
  readonly model: string;
  readonly systemPromptVersion: string;
  readonly outputSchemaVersion: string;
  readonly input: string;
  readonly evidenceWhitelist: readonly string[];
  /** 需求侧推理强度；本适配器映射为供应商档位（D-193）。 */
  readonly reasoningEffort: AdapterReasoningEffort;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface AdapterUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AdapterCostEstimate {
  readonly currency: "USD";
  readonly amount: number;
  readonly priceVersion: string;
}

export interface AdapterResult {
  readonly provider: string;
  readonly model: string;
  readonly providerRequestId: string;
  readonly structuredOutput: unknown;
  readonly usage: AdapterUsage;
  readonly finishReason: string;
  readonly latencyMs: number;
  readonly costEstimate: AdapterCostEstimate;
}

export interface ProviderAdapter {
  readonly adapterVersion: string;
  readonly capabilities: ProviderCapabilities;
  invoke(request: AdapterRequest): Promise<AdapterResult>;
}

export type JsonSchema = Readonly<Record<string, unknown>>;
export type DeepSeekReasoningEffort = "none" | "low" | "high" | "max";

export interface DeepSeekResponsesCreateParams {
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly max_output_tokens: number;
  readonly reasoning: { readonly effort: DeepSeekReasoningEffort };
  readonly text: {
    readonly format: {
      readonly type: "json_schema";
      readonly name: string;
      readonly schema: JsonSchema;
    };
  };
}

export interface DeepSeekResponseLike {
  readonly id?: unknown;
  readonly model?: unknown;
  readonly status?: unknown;
  readonly error?: unknown;
  readonly incomplete_details?: unknown;
  readonly output?: unknown;
  readonly usage?: unknown;
}

export interface DeepSeekResponsesClient {
  readonly responses: {
    create(
      body: DeepSeekResponsesCreateParams,
      options: { readonly signal: AbortSignal },
    ): Promise<unknown>;
  };
}
