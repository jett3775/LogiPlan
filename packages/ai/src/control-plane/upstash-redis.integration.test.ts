import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Redis } from "@upstash/redis";
import { afterAll, describe, expect, it } from "vitest";

import { UpstashRedisLike } from "./upstash-redis";

/**
 * 真实 Upstash Redis 上的账本返回值精度回归（D-138 `budget_used_cny` 白名单字段）。
 *
 * 复现的缺陷：Redis 把 Lua 脚本返回值里的 Lua number 转成 RESP integer 并**截断小数**，
 * 而 `SET` 的参数转换保留小数。于是 `budgetReserve(1.5)` 返回 `totalCny=1`，但随后
 * `budgetRead` 得到 `1.5`——审计字段少报。内存替身返回精确浮点，**不模拟 RESP 截断**，
 * 因此这个缺陷必须打真实 Redis 才能抓住（docs/multi-agent-workflow.md §8）。
 *
 * 门控：**同时**要求显式 opt-in `LOGIPLAN_UPSTASH_INTEGRATION=1` 与真实凭据，避免日常
 * `pnpm test` 自动联网；跳过原因写在 describe 名称里（同 `packages/db/src/evidence-snapshot.test.ts:457`）。
 *
 * 隔离：只使用测试专用前缀 `logiplan-test-<random>:*` 的键，跑完清理，绝不触碰生产账本键。
 * 本文件不打印任何凭据值。
 */

// 仓库根 `.env`（若存在）在本地提供凭据；不覆盖已显式设置的环境变量，不打印任何值。
const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // `.env` 不可读时忽略：此时凭据缺失，用例照常跳过。
  }
}

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const enabled =
  process.env.LOGIPLAN_UPSTASH_INTEGRATION === "1" &&
  typeof url === "string" &&
  url.length > 0 &&
  typeof token === "string" &&
  token.length > 0;

const SKIP_REASON =
  "requires LOGIPLAN_UPSTASH_INTEGRATION=1 plus UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN (real Upstash REST); skipped so default `pnpm test` never hits the network";

const runId = `logiplan-test-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
const ledgers: string[] = [];

/** 新建一个测试专用账本键（不与生产账本共享任何前缀）。 */
const newLedger = (name: string): string => {
  const key = `${runId}:${name}`;
  ledgers.push(key);
  return key;
};

const redis = enabled ? new Redis({ url: url as string, token: token as string }) : null;
const like = redis === null ? null : new UpstashRedisLike(redis);

afterAll(async () => {
  if (redis === null) return;
  const keys = ledgers.flatMap((key) => [`${key}:total`, `${key}:reservations`, `${key}:settled`]);
  if (keys.length > 0) await redis.del(...keys);
});

describe.skipIf(!enabled)(
  `budget ledger value precision on real Upstash Redis (${SKIP_REASON})`,
  () => {
    const CAP = 30;

    it("budgetReserve(1.5) 返回的 totalCny 与 budgetRead 完全相等（修复前被截断为 1）", async () => {
      const ledger = newLedger("reserve-1.5");
      const outcome = await like!.budgetReserve(ledger, "req-1.5", 1.5, CAP);
      expect(outcome.ok).toBe(true);
      expect(outcome.applied).toBe(true);
      expect(outcome.totalCny).toBe(1.5);
      expect(await like!.budgetRead(ledger)).toBe(outcome.totalCny);
    });

    it("连续 budgetReserve(0.4) 两次得到 0.8（修复前第二次返回 0）", async () => {
      const ledger = newLedger("reserve-0.4-twice");
      await like!.budgetReserve(ledger, "req-a", 0.4, CAP);
      const second = await like!.budgetReserve(ledger, "req-b", 0.4, CAP);
      expect(second.totalCny).toBe(0.8);
      expect(await like!.budgetRead(ledger)).toBe(second.totalCny);
    });

    it("budgetSettle(3.5)（先 reserve 5）返回的 totalCny 与 budgetRead 完全相等（修复前为 3）", async () => {
      const ledger = newLedger("settle-3.5");
      await like!.budgetReserve(ledger, "req-s", 5, CAP);
      const settled = await like!.budgetSettle(ledger, "req-s", 3.5);
      expect(settled.applied).toBe(true);
      expect(settled.totalCny).toBe(3.5);
      expect(await like!.budgetRead(ledger)).toBe(settled.totalCny);
    });

    it("幂等重放不改账本：重复 reserve / settle 返回 applied=false 且 totalCny 一致", async () => {
      const ledger = newLedger("idempotent");
      const first = await like!.budgetReserve(ledger, "req-1", 2.5, CAP);
      const reserveAgain = await like!.budgetReserve(ledger, "req-1", 2.5, CAP);
      expect(reserveAgain.applied).toBe(false);
      expect(reserveAgain.totalCny).toBe(first.totalCny);
      const settled = await like!.budgetSettle(ledger, "req-1", 2.5);
      const settleAgain = await like!.budgetSettle(ledger, "req-1", 2.5);
      expect(settleAgain.applied).toBe(false);
      expect(settleAgain.totalCny).toBe(settled.totalCny);
      expect(await like!.budgetRead(ledger)).toBe(settleAgain.totalCny);
    });

    it("超过 cap 的预留被拒绝，且 totalCny 与 budgetRead 一致（未被截断）", async () => {
      const ledger = newLedger("cap");
      await like!.budgetReserve(ledger, "req-seed", 29.5, CAP);
      const blocked = await like!.budgetReserve(ledger, "req-over", 1.5, CAP);
      expect(blocked.ok).toBe(false);
      expect(blocked.applied).toBe(false);
      expect(blocked.totalCny).toBe(29.5);
      expect(await like!.budgetRead(ledger)).toBe(blocked.totalCny);
    });
  },
);
