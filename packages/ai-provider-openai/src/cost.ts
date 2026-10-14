/**
 * 版本化美元成本估算（设计 §2「适配器内部职责」、§3.3）。
 *
 * ## 价格版本单一来源（本切片的关键设计选择）
 *
 * 版本化美元价格表**单一来源**在 `packages/ai/src/control-plane/pricing.ts`
 * （`PRICE_VERSION_V1 = "PRICE_2026_V1"`，含 `gpt-5.6-luna` / `gpt-5.6-terra`）。
 * 本包**不得** `import` `packages/ai`（§1.1 单向依赖，反向会成环），故采用**注入**方案：
 * 调用方传入美元价格查询函数 `CostLookup`，本包不持有价格表。这样价格表只有一份来源、
 * 无环，且本包不含任何成本控制策略（汇率、安全余量、月度阈值、预留/结算均属 `packages/ai`）。
 *
 * ## 未知模型 / 未知价格版本的失败关闭语义
 *
 * 注入函数对未知模型或未知价格版本应返回非有限值（`packages/ai` 的 `estimateCostUsd`
 * 约定返回 `Infinity`）。本包再做一次防御：任何非有限、负数或抛出的结果都归一为
 * `Number.POSITIVE_INFINITY`——**绝不当作零成本放行**。`Infinity` 使中立层的费用预留必然
 * 超过任何有限预算，从而失败关闭（与 `pricing.ts:87-93` 的既有约定一致）。
 */

import type { AdapterUsage } from "./contract";

export type CostLookup = (priceVersion: string, model: string, usage: AdapterUsage) => number;

/** 把任意价格查询结果归一为失败关闭语义：合法有限非负数原样返回，否则 `Infinity`。 */
export const toFailClosedCost = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;

/** 安全调用注入的价格查询函数：抛错也归一为 `Infinity`（失败关闭）。 */
export const estimateCostUsd = (
  lookup: CostLookup,
  priceVersion: string,
  model: string,
  usage: AdapterUsage,
): number => {
  try {
    return toFailClosedCost(lookup(priceVersion, model, usage));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
