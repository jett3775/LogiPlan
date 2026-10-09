import { describe, expect, it } from "vitest";

import { checkRateLimit, rateLimitKey, RATE_LIMIT_MAX_PER_WINDOW } from "./rate-limit";
import { InMemoryRedisLike } from "./test-doubles";

/**
 * AC2.2（限流侧）与 AC2.4：滑动窗口在**单次调用**内完成计数与判定；
 * 并发请求下计数不超发；限流命中即返回不允许。
 */

const T0 = Date.parse("2026-10-08T12:00:00.000Z");

describe("滑动窗口限流", () => {
  it("键形态为 rl:{scope}:{role}:{day}", () => {
    expect(rateLimitKey("abc123", "management_analysis", T0)).toBe(
      "rl:abc123:management_analysis:2026-10-08",
    );
  });

  it("每次判定只发起一次存储调用（单次脚本调用语义）", async () => {
    const redis = new InMemoryRedisLike();
    await checkRateLimit(redis, {
      scope: "s",
      role: "intent_parse",
      requestId: "r1",
      nowMs: T0,
      limit: 5,
    });
    expect(redis.calls.slidingWindow).toBe(1);
  });

  it("并发请求下计数不超发：limit 内全部放行，超出即拒绝", async () => {
    const redis = new InMemoryRedisLike();
    const limit = 5;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        checkRateLimit(redis, {
          scope: "s",
          role: "management_analysis",
          requestId: `req-${index}`,
          nowMs: T0,
          limit,
          windowMs: 60_000,
        }),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(limit);
    expect(results.filter((result) => !result.allowed)).toHaveLength(12 - limit);
    // 每次判定各一次调用，共 12 次——不存在「读一次再写一次」的多次往返。
    expect(redis.calls.slidingWindow).toBe(12);
  });

  it("窗口滑出后重新放行", async () => {
    const redis = new InMemoryRedisLike();
    const limit = 1;
    const input = {
      scope: "s",
      role: "intent_parse" as const,
      requestId: "r",
      limit,
      windowMs: 1_000,
    };
    expect((await checkRateLimit(redis, { ...input, nowMs: T0 })).allowed).toBe(true);
    expect((await checkRateLimit(redis, { ...input, nowMs: T0 + 500 })).allowed).toBe(false);
    expect((await checkRateLimit(redis, { ...input, nowMs: T0 + 1_001 })).allowed).toBe(true);
  });

  it("剩余额度按窗口内已计入数计算", async () => {
    const redis = new InMemoryRedisLike();
    const first = await checkRateLimit(redis, {
      scope: "s",
      role: "fallback",
      requestId: "r1",
      nowMs: T0,
      limit: RATE_LIMIT_MAX_PER_WINDOW,
    });
    expect(first.remaining).toBe(RATE_LIMIT_MAX_PER_WINDOW - 1);
  });
});
