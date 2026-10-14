import type { GatewayErrorCode } from "./gateway-error-code";

/**
 * `GatewayErrorCode` 的产出侧划分（AC3.2 基础）。
 *
 * 设计 §1.3 的 11 个码值分属两层：**适配器侧**由本包产出（供应商错误 / 本地超时 /
 * 审核结果），**中立层侧**由 `packages/ai` 产出（输出三检、限流、预算、控制面）。
 *
 * 本常量把这条边界写成**可测试的显式划分**：穷尽性测试断言两侧之并恰为全部 11 个码值，
 * 且两侧无交集。切片 3b 据此实现「适配器错误 → 网关错误」的接线与 AC3.2 的穷尽性验收。
 *
 * ## 本包可产出的码值（适配器侧）
 *
 * | 码值                       | 触发                                                     |
 * | -------------------------- | -------------------------------------------------------- |
 * | `INPUT_REJECTED`           | `omni-moderation-latest` 命中，或审核服务异常（D-180）   |
 * | `PROVIDER_TIMEOUT`         | 单次调用超过 20 秒硬超时                                 |
 * | `PROVIDER_RATE_LIMITED`    | 供应商 429                                               |
 * | `PROVIDER_UNAVAILABLE`     | 供应商 5xx、网络错误、无可用的供应商响应                 |
 * | `PROVIDER_REQUEST_INVALID` | 供应商 4xx 参数错误；能力缺失；未知提示词/模式版本       |
 *
 * ## 只能由中立层产出的码值
 *
 * `SCHEMA_VALIDATION_FAILED` / `EVIDENCE_WHITELIST_VIOLATION` / `NUMERIC_MISMATCH`
 * 属输出三检（设计 §4.3），`BUDGET_EXCEEDED` / `RATE_LIMITED` / `CONTROL_PLANE_UNAVAILABLE`
 * 属限流、预算与两级熔断（设计 §3）。这些业务规则**不得**出现在本包（§1.1 硬约束）。
 */

export const ADAPTER_EMITTED_ERROR_CODES = [
  "INPUT_REJECTED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REQUEST_INVALID",
] as const satisfies readonly GatewayErrorCode[];

export const NEUTRAL_LAYER_ERROR_CODES = [
  "SCHEMA_VALIDATION_FAILED",
  "EVIDENCE_WHITELIST_VIOLATION",
  "NUMERIC_MISMATCH",
  "BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "CONTROL_PLANE_UNAVAILABLE",
] as const satisfies readonly GatewayErrorCode[];

export type AdapterEmittedErrorCode = (typeof ADAPTER_EMITTED_ERROR_CODES)[number];
export type NeutralLayerErrorCode = (typeof NEUTRAL_LAYER_ERROR_CODES)[number];

/** 适配器侧码值集合；用于断言「本包不产出中立层码值」。 */
export const ADAPTER_EMITTED_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  ADAPTER_EMITTED_ERROR_CODES,
);

/** 某码值是否由适配器（本包）产出。 */
export const isAdapterEmittedErrorCode = (code: GatewayErrorCode): boolean =>
  ADAPTER_EMITTED_ERROR_CODE_SET.has(code);
