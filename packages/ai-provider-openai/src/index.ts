/**
 * `@logiplan/ai-provider-openai`：首个供应商适配器（docs/gate2-design.md §1.3、§2；D-180）。
 *
 * 导出面**只有本包自己的中立类型**，不含任何供应商 SDK 类型、供应商错误类型或供应商
 * 响应结构。本包只被 `packages/ai` 依赖，**不得**从 `packages/ai` 的 barrel 导出
 * （避免进浏览器包）。
 */

export { ADAPTER_ROLES, isAdapterRole, type AdapterRole } from "./roles";
export {
  PROVIDER_CAPABILITY_NAMES,
  allCapabilitiesGranted,
  noCapabilitiesGranted,
  capabilityGate,
  missingRequiredCapabilities,
  requiredCapabilitiesForRole,
  type CapabilityGate,
  type ProviderCapabilities,
  type ProviderCapabilityName,
} from "./capabilities";
export type {
  AdapterCostEstimate,
  AdapterRequest,
  AdapterResult,
  AdapterUsage,
  JsonSchema,
  ProviderAdapter,
} from "./contract";
export {
  GATEWAY_ERROR_CODES,
  isGatewayErrorCode,
  type GatewayErrorCode,
} from "./gateway-error-code";
export {
  ADAPTER_EMITTED_ERROR_CODES,
  ADAPTER_EMITTED_ERROR_CODE_SET,
  NEUTRAL_LAYER_ERROR_CODES,
  isAdapterEmittedErrorCode,
  type AdapterEmittedErrorCode,
  type NeutralLayerErrorCode,
} from "./error-partition";
export { ProviderInvocationError, isProviderInvocationError } from "./errors";
export { mapProviderError, statusOfError } from "./error-mapping";
export { MODERATION_MODEL, moderateInput, type ModerationDecision } from "./moderation";
export {
  OUTPUT_FORMAT_NAME,
  buildResponsesRequest,
  reasoningEffortForRole,
  type ResolvedPromptAndSchema,
} from "./request-mapping";
export {
  extractStructuredOutput,
  isUsableResponseStatus,
  mapResponse,
  normalizeFinishReason,
  type NormalizedResponse,
} from "./response-mapping";
export { estimateCostUsd, toFailClosedCost, type CostLookup } from "./cost";
export { HARD_TIMEOUT_MS, runWithHardTimeout, type TimedResult } from "./timeout";
export {
  OPENAI_ADAPTER_VERSION,
  PROVIDER_NAME,
  createOpenAiAdapter,
  type HardTimeoutRunner,
  type OpenAiAdapterHooks,
  type OpenAiAdapterOptions,
} from "./adapter";
export type {
  AdapterReasoningEffort,
  OpenAiModerationCreateParams,
  OpenAiModerationResponseLike,
  OpenAiResponseLike,
  OpenAiResponseOutputItem,
  OpenAiResponsesClient,
  OpenAiResponsesCreateParams,
} from "./client-types";
