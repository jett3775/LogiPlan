/**
 * 供应商错误 / 网络错误 → 标准化 `GatewayErrorCode`（设计 §2「适配器内部职责」）。
 *
 * 只产出**适配器侧**码值（见 `./error-partition`）。映射依据 HTTP `status` 而非 `instanceof`：
 * 既避免把 SDK 错误类型泄漏进逻辑，也便于用假错误替身确定性地驱动测试。
 *
 * | 条件                     | 码值                       | 可重试 |
 * | ------------------------ | -------------------------- | ------ |
 * | 429                      | `PROVIDER_RATE_LIMITED`    | 是     |
 * | >= 500                   | `PROVIDER_UNAVAILABLE`     | 是     |
 * | 4xx（含 400/401/403/404）| `PROVIDER_REQUEST_INVALID` | 否     |
 * | 无 status（网络/连接错误）| `PROVIDER_UNAVAILABLE`    | 是     |
 *
 * 超时由本包自身的 20 秒硬超时判定为 `PROVIDER_TIMEOUT`（不重试），不依赖供应商的
 * 超时错误；故此处不额外识别 SDK 的超时错误名。
 */

import type { AdapterEmittedErrorCode } from "./error-partition";

/** 从任意错误对象中取出有限数字 `status`（SDK `APIError` 与假替身都适用）。 */
export const statusOfError = (error: unknown): number | undefined => {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return undefined;
};

export const mapProviderError = (error: unknown): AdapterEmittedErrorCode => {
  const status = statusOfError(error);
  if (status === undefined) return "PROVIDER_UNAVAILABLE";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  if (status >= 400) return "PROVIDER_REQUEST_INVALID";
  // 3xx / 1xx 等非预期状态：视为供应商不可用（失败关闭）。
  return "PROVIDER_UNAVAILABLE";
};
