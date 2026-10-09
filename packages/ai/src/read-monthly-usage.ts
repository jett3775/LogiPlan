import { readMonthlyUsage, type MonthlyUsage } from "./control-plane/budget-ledger";
import {
  createControlPlaneFromEnvironment,
  type CreateControlPlaneOptions,
} from "./control-plane/server";

/**
 * 只读 CLI：打印当前自然月的累计用量（AC2.11，D-190 2026-10-04 补充②）。
 *
 * 运行：`pnpm --filter @logiplan/ai run usage`（脚本见 `packages/ai/package.json`）。
 * 输出：单行 JSON，字段恰为 `MonthlyUsage`（`month` / `used_cny` / `cap_cny` /
 * `price_version` / `fx_version`），机器可读，供人工核对月度花费。
 *
 * ## 只读性硬保证（AC2.11）
 *
 * 本模块**只**调用 `createControlPlaneFromEnvironment` 与 `readMonthlyUsage`：
 * - **不写 Redis**：不调用 `reserveBudget` / `settleBudget`（即不触发 `budgetReserve`
 *   / `budgetSettle`）；
 * - **不改变熔断状态**：不调用 `recordSuccess` / `recordTransientFailure` /
 *   `evaluateControlPlane` / `recordProviderAttemptOutcome`。
 * `readMonthlyUsage` 只做一次 `redis.budgetRead`（见 `budget-ledger.ts`），天然只读。
 *
 * ## 为什么不能从主 barrel 导出
 *
 * 本模块 import `./control-plane/server`（进而静态可达 Upstash 客户端）。主 barrel
 * `index.ts` 被**客户端组件**消费，导出本模块会把服务端基础设施打进浏览器包（P1-1）。
 * 因此 `index.ts` **不**导出本模块；`no-live-call.test.ts` 的静态可达性断言继续锁死。
 *
 * ## 受控失败
 *
 * 缺主密钥或缺 Redis 凭据时 `createControlPlaneFromEnvironment` 返回 `null`，本 CLI
 * 输出**固定**中文说明并以非零退出码结束；**不**回显任何连接串 / token / 密钥
 * （异常路径同样只打印同一固定文案，绝不透出底层错误信息）。
 */

/** 受控失败文案（固定；不含任何凭据信息）。 */
export const USAGE_UNAVAILABLE_MESSAGE_ZH =
  "无法读取月度用量：控制面未配置（缺少主密钥或 Redis 凭据）。";

/** 报告字段顺序（= `MonthlyUsage` 的字段集合；不多不少）。 */
export const MONTHLY_USAGE_FIELDS = [
  "month",
  "used_cny",
  "cap_cny",
  "price_version",
  "fx_version",
] as const;

/**
 * 纯函数：把 `MonthlyUsage` 渲染为单行 JSON。**显式逐字段**构造，保证字段集合稳定
 * ——即便 `MonthlyUsage` 将来新增字段，也不会顺带泄漏进报告。
 */
export const renderMonthlyUsageReport = (usage: MonthlyUsage): string =>
  JSON.stringify({
    month: usage.month,
    used_cny: usage.used_cny,
    cap_cny: usage.cap_cny,
    price_version: usage.price_version,
    fx_version: usage.fx_version,
  });

export type ReadMonthlyUsageOutcome =
  | { readonly ok: true; readonly usage: MonthlyUsage }
  | { readonly ok: false; readonly message_zh: string };

/**
 * 装配 → 只读读取。可注入 `redis` / `clock`（`CreateControlPlaneOptions`），使单测
 * 无需真实进程即可覆盖；未注入时走 `server.ts` 的进程级单例。
 *
 * `nowMs` 取自装配后的注入时钟：生产默认时钟即 `Date.now`（`server.ts`），故线上行为
 * 与「读当前自然月」一致；测试注入 `FixedClock` 后完全确定（避免跨月边界抖动）。
 */
export const runReadMonthlyUsage = async (
  environment: Record<string, string | undefined>,
  options: CreateControlPlaneOptions = {},
): Promise<ReadMonthlyUsageOutcome> => {
  const runtime = await createControlPlaneFromEnvironment(environment, options);
  if (runtime === null) {
    return { ok: false, message_zh: USAGE_UNAVAILABLE_MESSAGE_ZH };
  }
  const usage = await readMonthlyUsage(runtime.deps.redis, {
    threshold: runtime.config.threshold,
    nowMs: runtime.deps.clock.now(),
  });
  return { ok: true, usage };
};

/** 仅当作为脚本直接运行时执行；被 `import` 时不执行（单测导入纯函数即安全）。 */
const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.filename === entry;
};

if (isDirectRun()) {
  const outcome = await runReadMonthlyUsage(process.env).catch((): ReadMonthlyUsageOutcome => ({
    ok: false,
    message_zh: USAGE_UNAVAILABLE_MESSAGE_ZH,
  }));
  if (outcome.ok) {
    process.stdout.write(`${renderMonthlyUsageReport(outcome.usage)}\n`);
  } else {
    process.stderr.write(`${outcome.message_zh}\n`);
    process.exitCode = 1;
  }
}
