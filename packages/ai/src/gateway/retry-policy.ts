import type { AdapterResult } from "../adapter/adapter-contract";
import type { GatewayErrorCode } from "./gateway-error-code";

/**
 * 超时与重试策略（docs/gate2-design.md §2、D-190）。
 *
 * - **20 秒硬超时**：单次调用超过 20 秒即判定 `PROVIDER_TIMEOUT`。
 * - **仅 429 / 5xx 重试恰好 1 次**：`PROVIDER_RATE_LIMITED`（429）与
 *   `PROVIDER_UNAVAILABLE`（5xx）最多重试一次；其余错误码（含超时、4xx 参数错误、
 *   校验失败、预算熔断）**不重试**。
 *
 * 本模块不含任何供应商 SDK：调用入口以**注入的函数**给出，测试注入假适配器
 * （AC2.9）。真实网络传输无法在本机验证。
 *
 * ## 与确定性查询 10 秒超时的关系（供切片 3）
 *
 * `apps/web/app/api/v1/query/route.ts:12` 的 `QUERY_TIMEOUT_MS = 10_000` 是**确定性查询**
 * 的硬超时，作用于数据库往返，与本模块的 20 秒**供应商调用**超时是两条独立预算：确定性
 * 查询在模型调用之前完成，二者不叠加为同一条路径。切片 2 无真实调用，故无运行时冲突；
 * 切片 3 接入真实调用时须保证「确定性查询 10s + 模型调用 20s」不突破请求级总时限。
 */

/** 单次调用硬超时：20 秒。 */
export const HARD_TIMEOUT_MS = 20_000;
/** 总尝试次数：首次 + 1 次重试。 */
export const MAX_ATTEMPTS = 2;

/** 是否可重试：仅 429（`PROVIDER_RATE_LIMITED`）与 5xx（`PROVIDER_UNAVAILABLE`）。 */
export const isRetryableError = (code: GatewayErrorCode): boolean =>
  code === "PROVIDER_RATE_LIMITED" || code === "PROVIDER_UNAVAILABLE";

export type AttemptOutcome =
  | { readonly kind: "result"; readonly result: AdapterResult }
  | { readonly kind: "error"; readonly errorCode: GatewayErrorCode };

export type TimedResult<T> =
  { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

/** 用真实定时器施加硬超时；超时返回 `{ timedOut: true }`。 */
export const runWithHardTimeout = async <T>(
  task: () => Promise<T>,
  timeoutMs: number = HARD_TIMEOUT_MS,
): Promise<TimedResult<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      task().then((value): TimedResult<T> => ({ timedOut: false, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** 可注入的超时与退避钩子；测试用直通实现以确定地驱动重试计数。 */
export interface RetryHooks {
  readonly withHardTimeout: <T>(task: () => Promise<T>) => Promise<TimedResult<T>>;
  readonly backoff: (attempt: number) => Promise<void>;
}

export const defaultRetryHooks = (timeoutMs: number = HARD_TIMEOUT_MS): RetryHooks => ({
  withHardTimeout: (task) => runWithHardTimeout(task, timeoutMs),
  backoff: () => Promise.resolve(),
});

/**
 * 以「超时 + 至多一次重试」驱动一次调用。
 *
 * `attemptFn` 由调用方注入（切片 3 注入真实适配器；测试注入假适配器）。超时映射为
 * `PROVIDER_TIMEOUT`（不重试）；仅 429 / 5xx 会触发第二次尝试。
 */
export const invokeWithRetry = async (
  attemptFn: (attempt: number) => Promise<AttemptOutcome>,
  hooks: RetryHooks = defaultRetryHooks(),
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<AttemptOutcome> => {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const timed = await hooks.withHardTimeout(() => attemptFn(attempt));
    if (timed.timedOut) return { kind: "error", errorCode: "PROVIDER_TIMEOUT" };
    const outcome = timed.value;
    if (outcome.kind === "result") return outcome;
    if (attempt >= maxAttempts || !isRetryableError(outcome.errorCode)) return outcome;
    await hooks.backoff(attempt);
  }
};
