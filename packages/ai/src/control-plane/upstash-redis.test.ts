import { describe, expect, it } from "vitest";

import { ControlPlaneUnavailableError, type RedisLike } from "./redis-like";
import { InMemoryRedisLike } from "./test-doubles";
import {
  createLazyUpstashRedisLike,
  UpstashRedisLike,
  type RedisScriptClient,
} from "./upstash-redis";

/**
 * `UpstashRedisLike` 的**脚本返回值 → 结果对象**映射与错误处理（默认运行，无需凭据）。
 *
 * 用最小可注入客户端（`RedisScriptClient`）替身驱动：既不加载 `@upstash/redis`、也不联网，
 * 因此本文件在 `pnpm test` 默认运行下即覆盖生产适配器的全部分支。真实 Redis 的**原子性**与
 * **跨实例一致性**由门控集成测试（`*.integration.test.ts`）验证——替身不模拟 Lua 语义。
 */

/** 记录调用并按队列返回预设响应的最小客户端替身。 */
class FakeScriptClient implements RedisScriptClient {
  readonly evals: { script: string; keys: string[]; args: unknown[] }[] = [];
  readonly gets: string[] = [];
  readonly #responses: unknown[] = [];

  queue(...responses: unknown[]): void {
    this.#responses.push(...responses);
  }

  eval(script: string, keys: string[], args: unknown[]): Promise<unknown> {
    this.evals.push({ script, keys, args });
    return Promise.resolve(this.#responses.shift());
  }

  get(key: string): Promise<unknown> {
    this.gets.push(key);
    return Promise.resolve(this.#responses.shift());
  }

  lastScript(): string {
    return this.evals.at(-1)?.script ?? "";
  }
}

const makeLike = (): { like: UpstashRedisLike; client: FakeScriptClient } => {
  const client = new FakeScriptClient();
  return { like: new UpstashRedisLike(client), client };
};

const NOW = 1_700_000_000_000;
const WINDOW = 300_000;

describe("UpstashRedisLike 限流与账本映射", () => {
  it("slidingWindow：允许时返回 count+1，并传入 [key] / [now, window, limit, member]", async () => {
    const { like, client } = makeLike();
    client.queue([1, 3]);
    const outcome = await like.slidingWindow("rl:k", "req-1", NOW, 60_000, 10);
    expect(outcome).toEqual({ allowed: true, count: 3, limit: 10 });
    expect(client.evals[0]?.keys).toEqual(["rl:k"]);
    expect(client.evals[0]?.args).toEqual([NOW, 60_000, 10, "req-1"]);
    expect(client.lastScript()).toContain("ZREMRANGEBYSCORE");
  });

  it("slidingWindow：拒绝时 allowed=false", async () => {
    const { like, client } = makeLike();
    client.queue([0, 10]);
    expect(await like.slidingWindow("rl:k", "req-2", NOW, 60_000, 10)).toEqual({
      allowed: false,
      count: 10,
      limit: 10,
    });
  });

  it("slidingWindow：返回值形状不对 → ControlPlaneUnavailableError", async () => {
    const { like, client } = makeLike();
    client.queue("nope");
    await expect(like.slidingWindow("rl:k", "r", NOW, 1, 1)).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
    client.queue([1]);
    await expect(like.slidingWindow("rl:k", "r", NOW, 1, 1)).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
  });

  it("budgetReserve：金额以字符串返回仍精确映射", async () => {
    const { like, client } = makeLike();
    client.queue([1, "1.5", 1]);
    const outcome = await like.budgetReserve("budget:v1:v1:2026-10", "req-1", 1.5, 30);
    expect(outcome).toEqual({ ok: true, totalCny: 1.5, capCny: 30, applied: true });
    expect(client.evals[0]?.keys).toEqual([
      "budget:v1:v1:2026-10:total",
      "budget:v1:v1:2026-10:reservations",
    ]);
  });

  it("budgetReserve：超上限 → ok=false；形状不对 → 抛错", async () => {
    const { like, client } = makeLike();
    client.queue([0, "30", 0]);
    expect(await like.budgetReserve("b", "req-1", 1.5, 30)).toEqual({
      ok: false,
      totalCny: 30,
      capCny: 30,
      applied: false,
    });
    client.queue([1, "1.5"]);
    await expect(like.budgetReserve("b", "r", 1, 30)).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
  });

  it("budgetSettle：结算与幂等重放", async () => {
    const { like, client } = makeLike();
    client.queue(["3.5", 1]);
    expect(await like.budgetSettle("b", "req-1", 3.5)).toEqual({ totalCny: 3.5, applied: true });
    expect(client.evals[0]?.keys).toEqual(["b:total", "b:reservations", "b:settled"]);
    client.queue(["3.5", 0]);
    expect(await like.budgetSettle("b", "req-1", 3.5)).toEqual({ totalCny: 3.5, applied: false });
    client.queue({});
    await expect(like.budgetSettle("b", "r", 1)).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
  });

  it("budgetRead：数值 / 缺失 / 非数值", async () => {
    const { like, client } = makeLike();
    client.queue("3.5");
    expect(await like.budgetRead("b")).toBe(3.5);
    expect(client.gets).toEqual(["b:total"]);
    client.queue(null, undefined);
    expect(await like.budgetRead("b")).toBeNull();
    expect(await like.budgetRead("b")).toBeNull();
    client.queue("abc");
    await expect(like.budgetRead("b")).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });
});

describe("UpstashRedisLike 熔断映射", () => {
  it("circuitRead：闭合 / 打开 / 半开三态映射，且 openedAt<0 归为 null", async () => {
    const { like, client } = makeLike();
    client.queue(["closed", 0, -1]);
    expect(await like.circuitRead("circuit:role", NOW, WINDOW)).toEqual({
      state: "closed",
      failures: 0,
      openedAt: null,
    });
    expect(client.evals[0]?.keys).toEqual(["circuit:role:failures", "circuit:role:opened"]);
    expect(client.evals[0]?.args).toEqual([NOW, WINDOW]);

    client.queue(["open", 5, NOW]);
    expect(await like.circuitRead("circuit:role", NOW, WINDOW)).toEqual({
      state: "open",
      failures: 5,
      openedAt: NOW,
    });

    client.queue(["half_open", 5, NOW]);
    expect((await like.circuitRead("circuit:role", NOW, WINDOW)).state).toBe("half_open");
  });

  it("circuitRead 的脚本是**纯读**：不含任何写命令", async () => {
    const { like, client } = makeLike();
    client.queue(["closed", 0, -1]);
    await like.circuitRead("circuit:role", NOW, WINDOW);
    const script = client.lastScript();
    expect(script).toContain("ZCOUNT");
    for (const write of ["ZADD", "ZREMRANGEBYSCORE", "SET", "DEL", "INCR", "PEXPIRE"]) {
      expect(script, write).not.toContain(write);
    }
  });

  it("circuitRead：形状或状态非法 → ControlPlaneUnavailableError", async () => {
    const { like, client } = makeLike();
    client.queue("nope");
    await expect(like.circuitRead("k", NOW, WINDOW)).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
    client.queue(["closed", 0]);
    await expect(like.circuitRead("k", NOW, WINDOW)).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
    client.queue(["bogus", 1, -1]);
    await expect(like.circuitRead("k", NOW, WINDOW)).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
  });

  it("circuitRecordFailure：用唯一成员（INCR）与 TTL（PEXPIRE），键含 failures/opened/seq", async () => {
    const { like, client } = makeLike();
    client.queue(1);
    await like.circuitRecordFailure("circuit:role", NOW, WINDOW, 5);
    expect(client.evals[0]?.keys).toEqual([
      "circuit:role:failures",
      "circuit:role:opened",
      "circuit:role:seq",
    ]);
    expect(client.evals[0]?.args).toEqual([NOW, WINDOW, 5]);
    const script = client.lastScript();
    // 唯一成员：同一毫秒的并发故障不得互相覆盖（漏计数）。
    expect(script).toContain("INCR");
    expect(script).toContain("ZADD");
    expect(script).toContain("PEXPIRE");
    expect(script).toContain("ZCARD");
  });

  it("circuitRecordSuccess：DEL 三个子键（闭合）", async () => {
    const { like, client } = makeLike();
    client.queue(1);
    await like.circuitRecordSuccess("circuit:role");
    expect(client.evals[0]?.keys).toEqual([
      "circuit:role:failures",
      "circuit:role:opened",
      "circuit:role:seq",
    ]);
    expect(client.evals[0]?.args).toEqual([]);
    expect(client.lastScript()).toContain("DEL");
  });
});

describe("createLazyUpstashRedisLike", () => {
  it("实现全部 RedisLike 方法，且首次调用才构造、后续复用同一实例", async () => {
    let constructions = 0;
    const inner = new InMemoryRedisLike();
    const like = createLazyUpstashRedisLike(
      { url: "https://example.invalid", token: "token" },
      () => {
        constructions += 1;
        return Promise.resolve<RedisLike>(inner);
      },
    );
    for (const method of [
      "slidingWindow",
      "budgetReserve",
      "budgetSettle",
      "budgetRead",
      "circuitRead",
      "circuitRecordFailure",
      "circuitRecordSuccess",
    ] as const) {
      expect(typeof like[method], method).toBe("function");
    }
    // 构造时不加载客户端。
    expect(constructions).toBe(0);

    expect((await like.circuitRead("circuit:role", NOW, WINDOW)).state).toBe("closed");
    expect(constructions).toBe(1);
    await like.circuitRecordFailure("circuit:role", NOW, WINDOW, 5);
    expect((await like.circuitRead("circuit:role", NOW, WINDOW)).failures).toBe(1);
    await like.circuitRecordSuccess("circuit:role");
    await like.slidingWindow("rl:k", "m", NOW, 1_000, 1);
    await like.budgetReserve("b", "r", 1, 30);
    await like.budgetSettle("b", "r", 1);
    await like.budgetRead("b");
    // 后续调用复用同一内部实例（不再构造）。
    expect(constructions).toBe(1);
  });
});
