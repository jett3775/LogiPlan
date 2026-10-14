/**
 * 中立标准化错误码（docs/gate2-design.md §1.3）。
 *
 * 本包是供应商适配器，**只**产出其中一部分码值；其余由 `packages/ai` 中立层产出。
 * 两侧的显式划分见 `./error-partition`，并由穷尽性测试锁定（AC3.2 基础）。
 *
 * 约束：不含任何供应商专有错误文本或结构。供应商错误只能在本包内转换为这里的码值。
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
