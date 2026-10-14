import { describe, expect, it } from "vitest";

import { createOpenAiAdapter } from "./adapter";
import { isProviderInvocationError } from "./errors";
import { HARD_TIMEOUT_MS, runWithHardTimeout } from "./timeout";
import { createFakeClient, sampleRequest } from "./test-doubles";

/**
 * 硬超时的**默认实现**（真实定时器）：注入替身覆盖不到的路径。
 * 这里用极短超时（10ms）对永不兑现的 Promise，确定性足够。
 *
 * 重试已移至 `packages/ai` 的 `gateway/retry-policy.ts`（切片 3b 协调项 2），
 * 故本文件不再覆盖退避睡眠。
 */
describe("硬超时默认实现（真实定时器）", () => {
  it("常量符合 D-180：20 秒硬超时", () => {
    expect(HARD_TIMEOUT_MS).toBe(20_000);
  });

  it("任务悬挂 → { timedOut: true }", async () => {
    const result = await runWithHardTimeout(() => new Promise<never>(() => undefined), 10);
    expect(result).toEqual({ timedOut: true });
  });

  it("任务按时完成 → 返回其值", async () => {
    const result = await runWithHardTimeout(async () => "ok", 1000);
    expect(result).toEqual({ timedOut: false, value: "ok" });
  });

  it("适配器默认走真实硬超时：悬挂的供应商调用 → PROVIDER_TIMEOUT", async () => {
    const { client } = createFakeClient({
      response: () => new Promise<never>(() => undefined),
    });
    const adapter = createOpenAiAdapter({
      client,
      safetyIdentifier: "anon-x",
      priceVersion: "PRICE_2026_V1",
      costLookup: () => 0.001,
      resolveSystemPrompt: () => "prompt",
      resolveOutputSchema: () => ({ type: "object" }),
      // 不注入 hooks：使用真实定时器与默认 sleep。
    });
    let code: string | undefined;
    try {
      await adapter.invoke(sampleRequest({ timeoutMs: 10 }));
    } catch (error) {
      if (isProviderInvocationError(error)) code = error.code;
    }
    expect(code).toBe("PROVIDER_TIMEOUT");
  });
});
