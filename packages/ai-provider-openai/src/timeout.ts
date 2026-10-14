/**
 * 硬超时（设计 §2、D-180）。
 *
 * - **单次调用硬超时 20 秒**：超过即判定 `PROVIDER_TIMEOUT`。
 *
 * ## 重试不属本包（切片 3b 协调项 2）
 *
 * 本包**只做单次尝试**；429 / 5xx 的「恰好重试 1 次」由中立层
 * `packages/ai/src/gateway/retry-policy.ts` 承担（AC2.9 已验收）。原 3a 在适配器内也实现了
 * 重试，与中立层叠加会变成最多 4 次尝试，故本切片**删除适配器侧重试**，只保留单次尝试的
 * 硬超时——重试策略因此只有一份来源，不会漂移。
 *
 * 时间源可注入，测试据此确定性地驱动超时分支（不依赖真实定时器）。
 */

/** 单次调用硬超时：20 秒。 */
export const HARD_TIMEOUT_MS = 20_000;

export type TimedResult<T> =
  { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

/** 用真实定时器施加硬超时；超时返回 `{ timedOut: true }`。 */
export const runWithHardTimeout = async <T>(
  task: () => Promise<T>,
  timeoutMs: number,
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
