/**
 * 中立标准化错误码（docs/gate2-design.md §1.3）。
 *
 * 约束：不含任何供应商专有错误文本或结构；供应商错误只能在
 * `packages/ai-provider-*` 内转换为这里的码值。
 *
 * 数组派生的联合类型让「新增错误码必须同时补齐中文映射」成为编译期要求。
 */
export const GATEWAY_ERROR_CODES = [
  "INPUT_REJECTED",
  "SCHEMA_VALIDATION_FAILED",
  "EVIDENCE_WHITELIST_VIOLATION",
  "NUMERIC_MISMATCH",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REQUEST_INVALID",
  "BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "CONTROL_PLANE_UNAVAILABLE",
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export const isGatewayErrorCode = (value: unknown): value is GatewayErrorCode =>
  typeof value === "string" && (GATEWAY_ERROR_CODES as readonly string[]).includes(value);
