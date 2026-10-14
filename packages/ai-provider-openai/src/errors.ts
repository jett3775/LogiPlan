/**
 * 适配器的标准化错误（本包自己的中立类型，非 SDK 错误类型）。
 *
 * 适配器失败时抛出本错误，只携带中立的 `GatewayErrorCode`（且只可能是适配器侧码值），
 * **不含任何供应商专有错误文本或结构**。`message` 只由中立码值构成，绝不包含密钥、
 * 用户原文或供应商响应正文。
 */

import type { AdapterEmittedErrorCode } from "./error-partition";

export class ProviderInvocationError extends Error {
  readonly code: AdapterEmittedErrorCode;

  constructor(code: AdapterEmittedErrorCode) {
    super(`provider invocation failed: ${code}`);
    this.name = "ProviderInvocationError";
    this.code = code;
  }
}

export const isProviderInvocationError = (value: unknown): value is ProviderInvocationError =>
  value instanceof ProviderInvocationError;
