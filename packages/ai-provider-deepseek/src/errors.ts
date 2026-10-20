export type AdapterEmittedErrorCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REQUEST_INVALID";

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

const statusOf = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
};

export const mapProviderError = (error: unknown): AdapterEmittedErrorCode => {
  const status = statusOf(error);
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status !== undefined && status >= 400 && status < 500) {
    return "PROVIDER_REQUEST_INVALID";
  }
  return "PROVIDER_UNAVAILABLE";
};
