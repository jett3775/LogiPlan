import { describe, expect, it } from "vitest";

import type { AdapterResult } from "../adapter/adapter-contract";
import type { GatewayErrorCode } from "./gateway-error-code";
import {
  HARD_TIMEOUT_MS,
  invokeWithRetry,
  isRetryableError,
  MAX_ATTEMPTS,
  runWithHardTimeout,
  type AttemptOutcome,
  type RetryHooks,
} from "./retry-policy";

/**
 * AC2.9：20 秒硬超时；429/5xx **重试恰好 1 次**；其余错误码不重试。
 * 用假适配器（注入的 `attemptFn`）驱动；真实网络传输不可验。
 */

const RESULT: AdapterResult = {
  provider: "PROVIDER_A",
  model: "MODEL_A",
  providerRequestId: "PR-1",
  structuredOutput: null,
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: "stop",
  latencyMs: 1,
  costEstimate: { currency: "USD", amount: 0.0001, priceVersion: "PRICE_2026_V1" },
};

const passthroughHooks: RetryHooks = {
  withHardTimeout: (task) => task().then((value) => ({ timedOut: false, value })),
  backoff: () => Promise.resolve(),
};

const errorOutcome = (errorCode: GatewayErrorCode): AttemptOutcome => ({
  kind: "error",
  errorCode,
});

describe("超时与重试策略", () => {
  it("硬超时为 20 秒，最多尝试 2 次", () => {
    expect(HARD_TIMEOUT_MS).toBe(20_000);
    expect(MAX_ATTEMPTS).toBe(2);
  });

  it("仅 429 / 5xx 可重试", () => {
    expect(isRetryableError("PROVIDER_RATE_LIMITED")).toBe(true);
    expect(isRetryableError("PROVIDER_UNAVAILABLE")).toBe(true);
    expect(isRetryableError("PROVIDER_TIMEOUT")).toBe(false);
    expect(isRetryableError("PROVIDER_REQUEST_INVALID")).toBe(false);
    expect(isRetryableError("SCHEMA_VALIDATION_FAILED")).toBe(false);
    expect(isRetryableError("BUDGET_EXCEEDED")).toBe(false);
  });

  it("429 重试恰好 1 次（共 2 次尝试）", async () => {
    let calls = 0;
    const outcome = await invokeWithRetry(async () => {
      calls += 1;
      return errorOutcome("PROVIDER_RATE_LIMITED");
    }, passthroughHooks);
    expect(calls).toBe(2);
    expect(outcome).toEqual({ kind: "error", errorCode: "PROVIDER_RATE_LIMITED" });
  });

  it("5xx 重试恰好 1 次（共 2 次尝试）", async () => {
    let calls = 0;
    await invokeWithRetry(async () => {
      calls += 1;
      return errorOutcome("PROVIDER_UNAVAILABLE");
    }, passthroughHooks);
    expect(calls).toBe(2);
  });

  it("4xx 参数错误不重试（仅 1 次尝试）", async () => {
    let calls = 0;
    await invokeWithRetry(async () => {
      calls += 1;
      return errorOutcome("PROVIDER_REQUEST_INVALID");
    }, passthroughHooks);
    expect(calls).toBe(1);
  });

  it("超时不重试（仅 1 次尝试）", async () => {
    let calls = 0;
    await invokeWithRetry(async () => {
      calls += 1;
      return errorOutcome("PROVIDER_TIMEOUT");
    }, passthroughHooks);
    expect(calls).toBe(1);
  });

  it("首次 429、第二次成功 → 返回结果，共 2 次", async () => {
    let calls = 0;
    const outcome = await invokeWithRetry(async () => {
      calls += 1;
      return calls === 1
        ? errorOutcome("PROVIDER_RATE_LIMITED")
        : { kind: "result", result: RESULT };
    }, passthroughHooks);
    expect(calls).toBe(2);
    expect(outcome).toEqual({ kind: "result", result: RESULT });
  });

  it("硬超时生效：超时任务返回 timedOut，并被映射为 PROVIDER_TIMEOUT", async () => {
    const timed = await runWithHardTimeout(() => new Promise<never>(() => undefined), 5);
    expect(timed).toEqual({ timedOut: true });

    const outcome = await invokeWithRetry(() => new Promise<AttemptOutcome>(() => undefined), {
      withHardTimeout: (task) => runWithHardTimeout(task, 5),
      backoff: () => Promise.resolve(),
    });
    expect(outcome).toEqual({ kind: "error", errorCode: "PROVIDER_TIMEOUT" });
  });

  it("任务在超时前完成则返回其值", async () => {
    const timed = await runWithHardTimeout(() => Promise.resolve(42), 1_000);
    expect(timed).toEqual({ timedOut: false, value: 42 });
  });
});
