/**
 * 版本化价格、保守汇率与月度预算阈值换算（docs/gate2-design.md §3.3、D-181、D-190）。
 *
 * D-181：「月度人民币预算由**版本化美元价格**、**保守汇率**和额外 **10% 安全余量**
 * 换算，价格或汇率版本变化后重新验证阈值。」
 * D-190：「30 元是在给定价格版本下的预算上限参数……价格或汇率版本变化后必须重新推导
 * 并重新验证阈值，**不得沿用旧阈值**。」
 *
 * 本模块只做纯计算，不接触存储与网络；阈值对象自带 `price_version` / `fx_version`，
 * 由 `isThresholdCurrent` 判定是否过期（AC2.6）。
 */

export interface ModelPrice {
  readonly input_usd_per_million: number;
  readonly output_usd_per_million: number;
}

/** 价格版本标识；进入阈值对象与审计记录。 */
export const PRICE_VERSION_V1 = "PRICE_2026_V1";
/** 汇率版本标识；进入阈值对象与审计记录。 */
export const FX_VERSION_V1 = "FX_2026_V1";

/** 保守汇率：取高于即期的高位，宁可高估成本也不低估（D-181）。 */
export const USD_CNY_RATE_V1 = 7.4;
/** 安全余量：成本估算统一放大 10%，使阈值更早触发（D-181）。 */
export const SAFETY_MARGIN = 1.1;
/** 月度预算上限（人民币，D-190 决策一）。 */
export const MONTHLY_BUDGET_CNY = 30;
/** 单次调用输入 token 上界估算（用户自然语言 ≤500 字符 + 服务端证据，取保守值）。 */
export const MAX_INPUT_TOKENS = 4_000;

const PRICE_TABLES: Readonly<Record<string, Readonly<Record<string, ModelPrice>>>> = {
  [PRICE_VERSION_V1]: {
    "gpt-5.6-luna": { input_usd_per_million: 0.15, output_usd_per_million: 0.6 },
    "gpt-5.6-terra": { input_usd_per_million: 0.5, output_usd_per_million: 1.5 },
  },
};

const FX_RATES: Readonly<Record<string, number>> = {
  [FX_VERSION_V1]: USD_CNY_RATE_V1,
};

export const priceTableFor = (priceVersion: string): Readonly<Record<string, ModelPrice>> | null =>
  PRICE_TABLES[priceVersion] ?? null;

export const fxRateFor = (fxVersion: string): number | null => FX_RATES[fxVersion] ?? null;

/**
 * 月度预算阈值：由价格版本、汇率版本、安全余量与 30 元上限共同**推导**而来。
 * 任何一项变化都会使该对象过期，必须重新推导。
 */
export interface BudgetThreshold {
  readonly price_version: string;
  readonly fx_version: string;
  readonly safety_margin: number;
  readonly monthly_budget_cny: number;
  /** 折算出的美元额度：`30 / (汇率 × 余量)`，比即期更小，故更保守。 */
  readonly monthly_budget_usd: number;
}

export const deriveBudgetThreshold = (priceVersion: string, fxVersion: string): BudgetThreshold => {
  const fx = fxRateFor(fxVersion);
  if (fx === null || priceTableFor(priceVersion) === null) {
    throw new Error(`unknown price/fx version: ${priceVersion}/${fxVersion}`);
  }
  return {
    price_version: priceVersion,
    fx_version: fxVersion,
    safety_margin: SAFETY_MARGIN,
    monthly_budget_cny: MONTHLY_BUDGET_CNY,
    monthly_budget_usd: MONTHLY_BUDGET_CNY / (fx * SAFETY_MARGIN),
  };
};

/** 阈值是否仍对应当前价格/汇率版本；false 即「旧阈值必须重新推导」。 */
export const isThresholdCurrent = (
  threshold: BudgetThreshold,
  priceVersion: string,
  fxVersion: string,
): boolean => threshold.price_version === priceVersion && threshold.fx_version === fxVersion;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * 美元成本估算。未知模型或未知价格版本返回 `Infinity`：
 * 预留必然超过上限，从而**失败关闭**，而不是当作零成本放行。
 */
export const estimateCostUsd = (priceVersion: string, model: string, usage: TokenUsage): number => {
  const price = priceTableFor(priceVersion)?.[model];
  if (price === undefined) return Number.POSITIVE_INFINITY;
  return (
    (usage.inputTokens / 1_000_000) * price.input_usd_per_million +
    (usage.outputTokens / 1_000_000) * price.output_usd_per_million
  );
};

/** 美元 → 人民币：乘保守汇率与安全余量。未知汇率版本返回 `Infinity`（失败关闭）。 */
export const usdToCny = (
  usd: number,
  fxVersion: string,
  margin: number = SAFETY_MARGIN,
): number => {
  const fx = fxRateFor(fxVersion);
  if (fx === null) return Number.POSITIVE_INFINITY;
  return usd * fx * margin;
};

/** 一次调用的保守人民币成本估算。 */
export const estimateCostCny = (
  priceVersion: string,
  fxVersion: string,
  model: string,
  usage: TokenUsage,
): number => usdToCny(estimateCostUsd(priceVersion, model, usage), fxVersion, SAFETY_MARGIN);
