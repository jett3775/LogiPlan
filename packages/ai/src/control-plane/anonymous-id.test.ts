import { describe, expect, it } from "vitest";

import {
  anonymousDayStamp,
  dailyAnonymousKey,
  deriveAnonymousId,
  digestUserAgent,
  normalizeIp,
} from "./anonymous-id";

/**
 * AC2.1：匿名标识为**不可逆派生值**（每日轮换密钥 + HMAC(规范化 IP ‖ UA 摘要)）；
 * 日志与存储中搜不到原始 IP 与完整 UA。
 */

const SECRET = "test-secret-只存在于服务端环境变量";
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-08T12:00:00.000Z");

const RAW_IP = "203.0.113.7";
const RAW_UA = "Mozilla/5.0 (Windows NT 10.0) LogiPlanTest/1.0";

describe("匿名标识派生", () => {
  it("同一天、同输入派生值稳定；不随调用次数变化", async () => {
    const input = { rawIp: RAW_IP, userAgent: RAW_UA, secret: SECRET, nowMs: T0 };
    const first = await deriveAnonymousId(input);
    const second = await deriveAnonymousId(input);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("每日轮换：跨日派生值不同（不可跨日关联）", async () => {
    const today = await deriveAnonymousId({
      rawIp: RAW_IP,
      userAgent: RAW_UA,
      secret: SECRET,
      nowMs: T0,
    });
    const tomorrow = await deriveAnonymousId({
      rawIp: RAW_IP,
      userAgent: RAW_UA,
      secret: SECRET,
      nowMs: T0 + DAY_MS,
    });
    expect(tomorrow).not.toBe(today);
    expect(await dailyAnonymousKey(SECRET, T0)).not.toBe(
      await dailyAnonymousKey(SECRET, T0 + DAY_MS),
    );
  });

  it("不同 IP / 不同 UA / 不同密钥派生值均不同", async () => {
    const base = { rawIp: RAW_IP, userAgent: RAW_UA, secret: SECRET, nowMs: T0 };
    const id = await deriveAnonymousId(base);
    expect(await deriveAnonymousId({ ...base, rawIp: "203.0.113.8" })).not.toBe(id);
    expect(await deriveAnonymousId({ ...base, userAgent: `${RAW_UA} extra` })).not.toBe(id);
    expect(await deriveAnonymousId({ ...base, secret: "other-secret" })).not.toBe(id);
  });

  it("派生值与 UA 摘要中都不出现原始 IP 或完整 UA", async () => {
    const id = await deriveAnonymousId({
      rawIp: RAW_IP,
      userAgent: RAW_UA,
      secret: SECRET,
      nowMs: T0,
    });
    const uaDigest = await digestUserAgent(RAW_UA);
    for (const artifact of [id, uaDigest]) {
      expect(artifact).not.toContain(RAW_IP);
      expect(artifact).not.toContain(RAW_UA);
      expect(artifact.toLowerCase()).not.toContain("mozilla");
    }
  });

  it("规范化 IP：去空白、小写、剥方括号与 zone", () => {
    expect(normalizeIp("  203.0.113.7  ")).toBe("203.0.113.7");
    expect(normalizeIp("[2001:DB8::1]")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  it("日戳按 UTC 计算", () => {
    expect(anonymousDayStamp(Date.parse("2026-10-08T23:59:59.999Z"))).toBe("2026-10-08");
    expect(anonymousDayStamp(Date.parse("2026-10-09T00:00:00.000Z"))).toBe("2026-10-09");
  });
});
