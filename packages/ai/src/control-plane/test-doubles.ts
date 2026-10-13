import type {
  BudgetReserveOutcome,
  BudgetSettleOutcome,
  CircuitSnapshot,
  CircuitState,
  RedisLike,
  SlidingWindowOutcome,
} from "./redis-like";

/**
 * 控制面测试替身（替身与故障注入，docs/multi-agent-workflow.md §8）。
 *
 * 这些替身**不是**生产代码路径：生产实现见 `upstash-redis.ts`。它们只用于在本机
 * 确定地验证调用方逻辑；真实 Redis 的并发原子性无法在本机验证（见 `redis-like.ts`）。
 */

/** 可手动推进的时钟，用于驱动 L1 窗口滑出与半开（AC2.7）。 */
export class FixedClock {
  #nowMs: number;

  constructor(nowMs = 0) {
    this.#nowMs = nowMs;
  }

  now(): number {
    return this.#nowMs;
  }

  set(nowMs: number): void {
    this.#nowMs = nowMs;
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

/**
 * 内存 `RedisLike` 替身。
 *
 * 每个方法在**返回 Promise 之前**同步完成全部读改写，因此并发调用（`Promise.all`）
 * 不会交错——这正是「单次脚本调用」的接口语义。AC2.2 由此在本机可验。
 */
export class InMemoryRedisLike implements RedisLike {
  readonly #windows = new Map<string, number[]>();
  readonly #totals = new Map<string, number>();
  readonly #reservations = new Map<string, Map<string, number>>();
  readonly #settled = new Map<string, Set<string>>();
  readonly #circuitFailures = new Map<string, number[]>();
  readonly #circuitOpened = new Map<string, number>();
  readonly calls = {
    slidingWindow: 0,
    budgetReserve: 0,
    budgetSettle: 0,
    budgetRead: 0,
    circuitRead: 0,
    circuitRecordFailure: 0,
    circuitRecordSuccess: 0,
  };

  slidingWindow(
    key: string,
    _member: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowOutcome> {
    this.calls.slidingWindow += 1;
    const cutoff = nowMs - windowMs;
    const kept = (this.#windows.get(key) ?? []).filter((at) => at > cutoff);
    const allowed = kept.length < limit;
    if (allowed) kept.push(nowMs);
    this.#windows.set(key, kept);
    return Promise.resolve({ allowed, count: kept.length, limit });
  }

  budgetReserve(
    ledgerKey: string,
    requestId: string,
    amountCny: number,
    capCny: number,
  ): Promise<BudgetReserveOutcome> {
    this.calls.budgetReserve += 1;
    const reservations = this.#reservations.get(ledgerKey) ?? new Map<string, number>();
    this.#reservations.set(ledgerKey, reservations);
    const total = this.#totals.get(ledgerKey) ?? 0;
    if (reservations.has(requestId)) {
      return Promise.resolve({ ok: true, totalCny: total, capCny, applied: false });
    }
    if (total + amountCny > capCny) {
      return Promise.resolve({ ok: false, totalCny: total, capCny, applied: false });
    }
    const next = total + amountCny;
    this.#totals.set(ledgerKey, next);
    reservations.set(requestId, amountCny);
    return Promise.resolve({ ok: true, totalCny: next, capCny, applied: true });
  }

  budgetSettle(
    ledgerKey: string,
    requestId: string,
    actualCny: number,
  ): Promise<BudgetSettleOutcome> {
    this.calls.budgetSettle += 1;
    const settled = this.#settled.get(ledgerKey) ?? new Set<string>();
    this.#settled.set(ledgerKey, settled);
    const total = this.#totals.get(ledgerKey) ?? 0;
    if (settled.has(requestId)) {
      return Promise.resolve({ totalCny: total, applied: false });
    }
    const reservations = this.#reservations.get(ledgerKey) ?? new Map<string, number>();
    const reserved = reservations.get(requestId) ?? 0;
    const next = total - reserved + actualCny;
    this.#totals.set(ledgerKey, next);
    reservations.delete(requestId);
    settled.add(requestId);
    return Promise.resolve({ totalCny: next, applied: true });
  }

  budgetRead(ledgerKey: string): Promise<number | null> {
    this.calls.budgetRead += 1;
    const total = this.#totals.get(ledgerKey);
    return Promise.resolve(total ?? null);
  }

  /**
   * L1 熔断的**纯读**：只用 GET 语义，不写任何键（与生产脚本一致）。
   *
   * 内存替身用数组保存故障时间戳，天然允许同一毫秒重复（不模拟 ZSET 成员唯一性）；
   * 「同一毫秒并发不漏计数」由门控集成测试打真实 Redis 验证。
   */
  circuitRead(key: string, nowMs: number, windowMs: number): Promise<CircuitSnapshot> {
    this.calls.circuitRead += 1;
    const cutoff = nowMs - windowMs;
    const failures = (this.#circuitFailures.get(key) ?? []).filter((at) => at > cutoff).length;
    const openedAt = this.#circuitOpened.get(key);
    let state: CircuitState = "closed";
    let opened: number | null = null;
    if (openedAt !== undefined) {
      opened = openedAt;
      state = nowMs - openedAt >= windowMs ? "half_open" : "open";
    }
    return Promise.resolve({ state, failures, openedAt: opened });
  }

  circuitRecordFailure(
    key: string,
    nowMs: number,
    windowMs: number,
    threshold: number,
  ): Promise<void> {
    this.calls.circuitRecordFailure += 1;
    const cutoff = nowMs - windowMs;
    const openedAt = this.#circuitOpened.get(key);
    const halfOpen = openedAt !== undefined && nowMs - openedAt >= windowMs;
    const kept = halfOpen ? [] : (this.#circuitFailures.get(key) ?? []).filter((at) => at > cutoff);
    const failures = [...kept, nowMs];
    this.#circuitFailures.set(key, failures);
    if (halfOpen || failures.length >= threshold) this.#circuitOpened.set(key, nowMs);
    return Promise.resolve();
  }

  circuitRecordSuccess(key: string): Promise<void> {
    this.calls.circuitRecordSuccess += 1;
    this.#circuitFailures.delete(key);
    this.#circuitOpened.delete(key);
    return Promise.resolve();
  }
}

/** 永远抛错：模拟 Upstash 连接失败（AC2.3）。 */
export class FailingRedisLike implements RedisLike {
  slidingWindow(): Promise<SlidingWindowOutcome> {
    return Promise.reject(new Error("connection refused"));
  }
  budgetReserve(): Promise<BudgetReserveOutcome> {
    return Promise.reject(new Error("connection refused"));
  }
  budgetSettle(): Promise<BudgetSettleOutcome> {
    return Promise.reject(new Error("connection refused"));
  }
  budgetRead(): Promise<number | null> {
    return Promise.reject(new Error("connection refused"));
  }
  circuitRead(): Promise<CircuitSnapshot> {
    return Promise.reject(new Error("connection refused"));
  }
  circuitRecordFailure(): Promise<void> {
    return Promise.reject(new Error("connection refused"));
  }
  circuitRecordSuccess(): Promise<void> {
    return Promise.reject(new Error("connection refused"));
  }
}

/** 永不落定：模拟 Upstash 超时（AC2.3）。 */
export class HangingRedisLike implements RedisLike {
  slidingWindow(): Promise<SlidingWindowOutcome> {
    return new Promise<SlidingWindowOutcome>(() => undefined);
  }
  budgetReserve(): Promise<BudgetReserveOutcome> {
    return new Promise<BudgetReserveOutcome>(() => undefined);
  }
  budgetSettle(): Promise<BudgetSettleOutcome> {
    return new Promise<BudgetSettleOutcome>(() => undefined);
  }
  budgetRead(): Promise<number | null> {
    return new Promise<number | null>(() => undefined);
  }
  circuitRead(): Promise<CircuitSnapshot> {
    return new Promise<CircuitSnapshot>(() => undefined);
  }
  circuitRecordFailure(): Promise<void> {
    return new Promise<void>(() => undefined);
  }
  circuitRecordSuccess(): Promise<void> {
    return new Promise<void>(() => undefined);
  }
}

/** 返回不确定结构：模拟 Upstash 返回意外状态（AC2.3）。 */
export class MalformedRedisLike implements RedisLike {
  slidingWindow(): Promise<SlidingWindowOutcome> {
    return Promise.resolve({
      allowed: "yes",
      count: 1,
      limit: 10,
    } as unknown as SlidingWindowOutcome);
  }
  budgetReserve(): Promise<BudgetReserveOutcome> {
    return Promise.resolve({} as unknown as BudgetReserveOutcome);
  }
  budgetSettle(): Promise<BudgetSettleOutcome> {
    return Promise.resolve({} as unknown as BudgetSettleOutcome);
  }
  budgetRead(): Promise<number | null> {
    return Promise.resolve(null);
  }
  circuitRead(): Promise<CircuitSnapshot> {
    return Promise.resolve({
      state: "bogus",
      failures: 1,
      openedAt: null,
    } as unknown as CircuitSnapshot);
  }
  circuitRecordFailure(): Promise<void> {
    return Promise.resolve();
  }
  circuitRecordSuccess(): Promise<void> {
    return Promise.resolve();
  }
}
