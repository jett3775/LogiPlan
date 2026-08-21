import type { Pool } from "pg";
import {
  queryIntentSchema,
  type AnalysisScope,
  type Comparison,
  type EvidenceObject,
  type MoneyValue,
  type QueryIntent,
} from "@logiplan/contracts";
import { LogiPlanDecimal } from "@logiplan/domain";

export type DeterministicResult = {
  result_id: string;
  query_intent: QueryIntent;
  scope_label: string;
  data_as_of: string;
  generated_at: string;
  reporting_currency: "CNY";
  precision: { calculation: "HIGH_PRECISION_DECIMAL"; report_places: 4; display_places: 2 };
  payload: unknown;
  evidence: EvidenceObject[];
  warnings: Array<{ code: "REPORT_ROUNDING"; message: string }>;
};
export type QueryServiceError = {
  error_id: string;
  code:
    | "INVALID_METRIC"
    | "INVALID_DIMENSION"
    | "INVALID_FILTER"
    | "INVALID_PERIOD"
    | "VERSION_NOT_FOUND"
    | "UNSUPPORTED_GRAIN"
    | "ORDER_LEVEL_NOT_AVAILABLE"
    | "EVIDENCE_NOT_FOUND"
    | "RECONCILIATION_FAILED";
  message_zh: string;
  request_id: string;
};

const q = (n: unknown): string => new LogiPlanDecimal(String(n ?? "0")).toFixed();
const money = (n: unknown): MoneyValue => {
  const high = q(n);
  return {
    high_precision: high,
    report: new LogiPlanDecimal(high).toFixed(4),
    display: new LogiPlanDecimal(high).toFixed(2),
    currency: "CNY",
  };
};
const monthDate = (m: string) => `${m}-01`;
const resultId = (intent: QueryIntent) =>
  `Q-${Buffer.from(JSON.stringify(intent)).toString("base64url").slice(0, 20)}`;
const scopeLabel = (s: AnalysisScope) =>
  `${s.period.from}—${s.period.to}｜${s.destination_country_ids?.join(",") || "公司"}｜${s.comparison}`;
const evidence = (
  id: string,
  intent: QueryIntent,
  metric: string,
  value: string,
  method: string,
): EvidenceObject => ({
  evidence_id: id,
  metric,
  value,
  unit: "CNY",
  period: intent.scope.period,
  comparison: intent.scope.comparison as Comparison,
  filters: {},
  group_by: intent.group_by,
  versions: {
    budget: intent.scope.budget_version_id,
    actual: intent.scope.actual_version_id,
    forecast: intent.scope.forecast_version_id,
    scenario: intent.scope.scenario_version_id,
    calculation: intent.scope.calculation_version,
  },
  calculation_method: method,
  source_result_id: resultId(intent),
  snapshot_generated_at: new Date().toISOString(),
  source_refs: ["logiplan.active_*"],
});

function error(
  code: QueryServiceError["code"],
  message_zh: string,
  request_id: string,
): QueryServiceError {
  return { error_id: `ERR-${request_id}`, code, message_zh, request_id };
}
function validateIntent(intent: QueryIntent, request_id: string): QueryServiceError | null {
  if (intent.scope.period.from > intent.scope.period.to)
    return error("INVALID_PERIOD", "查询起始月份不得晚于结束月份", request_id);
  if (intent.scope.period.grain === "RANGE" && intent.group_by.includes("MONTH"))
    return error("UNSUPPORTED_GRAIN", "范围粒度不支持按月份分组", request_id);
  if (intent.question_type === "EVIDENCE_LOOKUP")
    return error("EVIDENCE_NOT_FOUND", "V1.0 查询服务暂不接受未绑定结果的证据 ID", request_id);
  if (intent.metrics.some((metric) => /ORDER_LEVEL|ORDER|TOP_ORDER/i.test(metric)))
    return error(
      "ORDER_LEVEL_NOT_AVAILABLE",
      "当前事实仅支持线路层下钻，无法生成订单级 Top 结果",
      request_id,
    );
  if (intent.question_type === "MANAGEMENT_ANALYSIS")
    return error("INVALID_METRIC", "管理分析必须消费确定性结果集合，不能直接查询事实", request_id);
  return null;
}

async function costByVersion(
  pool: Pool,
  scope: AnalysisScope,
  versionId: string,
  countryIds?: string[],
) {
  const params: unknown[] = [versionId, monthDate(scope.period.from), monthDate(scope.period.to)];
  let country = "";
  if (countryIds?.length) {
    params.push(countryIds);
    country = `AND r.destination_country_id = ANY($${params.length}::text[])`;
  }
  const sql = `SELECT COALESCE(SUM(c.model_cny_amount),0)::text AS variable_cost, COALESCE(SUM(f.cny_amount) FILTER (WHERE f.cost_scope_type IN ('FULFILLMENT_CENTER','SHARED')),0)::text AS fixed_cost
    FROM logiplan.active_scenario_cost_component_fact c JOIN logiplan.active_fulfillment_scenario_fact u USING (data_release_id, fulfillment_fact_id)
    JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
    LEFT JOIN logiplan.active_fixed_cost_scenario_fact f ON false
    WHERE u.scenario_version_id=$1 AND u.month_id BETWEEN $2::date AND $3::date ${country}`;
  const variable = await pool.query(sql, params);
  const fixed = await pool.query(
    `SELECT COALESCE(SUM(cny_amount),0)::text AS fixed_cost FROM logiplan.active_fixed_cost_scenario_fact WHERE scenario_version_id=$1 AND month_id BETWEEN $2::date AND $3::date`,
    [versionId, monthDate(scope.period.from), monthDate(scope.period.to)],
  );
  return { variable: q(variable.rows[0]?.variable_cost), fixed: q(fixed.rows[0]?.fixed_cost) };
}

async function dashboard(pool: Pool, intent: QueryIntent) {
  const s = intent.scope;
  const budget = await costByVersion(pool, s, s.budget_version_id);
  const actual = s.actual_version_id
    ? await costByVersion(pool, s, s.actual_version_id)
    : { variable: "0", fixed: "0" };
  const forecast = s.forecast_version_id
    ? await costByVersion(pool, s, s.forecast_version_id)
    : { variable: "0", fixed: "0" };
  const latest = {
    variable: new LogiPlanDecimal(actual.variable).plus(forecast.variable),
    fixed: new LogiPlanDecimal(actual.fixed).plus(forecast.fixed),
  };
  const total = (x: { variable: string | unknown; fixed: string | unknown }) =>
    new LogiPlanDecimal(String(x.variable)).plus(String(x.fixed));
  const b = total(budget),
    l = total(latest),
    variance = l.minus(b);
  const payload = {
    kpis: {
      budget: money(b),
      latest_outlook: money(l),
      variance: money(variance),
      variable_cost_budget: money(budget.variable),
      variable_cost_latest_outlook: money(latest.variable),
      fixed_cost_latest_outlook: money(latest.fixed),
    },
    series: {
      budget: { variable_cost: money(budget.variable), fixed_cost: money(budget.fixed) },
      latest_outlook: { variable_cost: money(latest.variable), fixed_cost: money(latest.fixed) },
    },
  };
  return {
    payload,
    evidence: [
      evidence(
        "E04-total",
        intent,
        "物流总成本",
        q(variance),
        "履约变动成本与物流运营固定成本按高精度数值汇总",
      ),
    ],
    warnings: [
      { code: "REPORT_ROUNDING" as const, message: "金额保留高精度、报告 4 位和界面 2 位" },
    ],
  };
}

async function country(pool: Pool, intent: QueryIntent) {
  const id = intent.scope.destination_country_ids?.[0];
  if (!id) throw error("INVALID_FILTER", "国家查询必须显式指定 destination_country_ids", "");
  const s = intent.scope;
  const b = await costByVersion(pool, s, s.budget_version_id, [id]);
  const a = s.actual_version_id
    ? await costByVersion(pool, s, s.actual_version_id, [id])
    : { variable: "0", fixed: "0" };
  const variance = new LogiPlanDecimal(a.variable).minus(b.variable);
  const payload = {
    destination_country_id: id,
    baseline: money(b.variable),
    current: money(a.variable),
    variance: money(variance),
    metrics: { order_qty: "由活动履约事实提供", service: "由活动履约事实提供" },
  };
  return {
    payload,
    evidence: [
      evidence(
        "E01-country",
        intent,
        "国家履约变动成本差异",
        variance.toFixed(),
        "按国家过滤活动履约变动成本",
      ),
    ],
    warnings: [],
  };
}

async function bridge(pool: Pool, intent: QueryIntent) {
  const s = intent.scope;
  const rows = await pool.query(
    `SELECT factor, COALESCE(SUM(attribution_cny),0)::text AS amount FROM logiplan.active_variance_attribution_fact f JOIN logiplan.active_variance_comparison c USING (data_release_id, comparison_id) JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id) WHERE c.budget_version_id=$1 AND c.comparison_scenario_version_id=$2 AND f.attribution_method='CHAIN_SUBSTITUTION' AND f.month_id BETWEEN $3::date AND $4::date AND ($5::text[] IS NULL OR r.destination_country_id=ANY($5::text[])) GROUP BY factor`,
    [
      s.budget_version_id,
      s.actual_version_id ?? s.forecast_version_id,
      monthDate(s.period.from),
      monthDate(s.period.to),
      s.destination_country_ids ?? null,
    ],
  );
  const factors = ["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"].map((factor, i) => ({
    factor_id: factor,
    label_zh: { VOLUME: "量", MIX: "结构", EFFICIENCY: "效率", PRICE: "价", FX: "汇率" }[factor],
    amount: money(rows.rows.find((r) => r.factor === factor)?.amount ?? "0"),
    sequence: i + 1,
  }));
  const total = factors.reduce((x, f) => x.plus(f.amount.high_precision), new LogiPlanDecimal(0));
  return {
    payload: {
      baseline: money(0),
      factors,
      current: money(total),
      reconciliation_delta: money(0),
      method: "CHAIN" as const,
    },
    evidence: [
      evidence(
        "E05-bridge",
        intent,
        "五因素归因",
        total.toFixed(),
        "CHAIN_SUBSTITUTION 活动归因事实",
      ),
    ],
    warnings: [],
  };
}

export async function runDeterministicQuery(
  pool: Pool,
  rawIntent: unknown,
  request_id: string,
): Promise<DeterministicResult | QueryServiceError> {
  const parsed = queryIntentSchema.safeParse(rawIntent);
  if (!parsed.success) return error("INVALID_FILTER", "查询意图不符合 V1.0 契约", request_id);
  const intent = parsed.data;
  const validation = validateIntent(intent, request_id);
  if (validation) return validation;
  try {
    const out =
      intent.question_type === "DASHBOARD_OVERVIEW"
        ? await dashboard(pool, intent)
        : intent.question_type === "COUNTRY_VARIANCE_SUMMARY"
          ? await country(pool, intent)
          : intent.question_type === "ATTRIBUTION_BRIDGE"
            ? await bridge(pool, intent)
            : {
                payload: {
                  status: "SUPPORTED_DATA_ACCESS_PENDING",
                  question_type: intent.question_type,
                },
                evidence: [],
                warnings: [] as Array<{ code: "REPORT_ROUNDING"; message: string }>,
              };
    return {
      result_id: resultId(intent),
      query_intent: intent,
      scope_label: scopeLabel(intent.scope),
      data_as_of: new Date().toISOString(),
      generated_at: new Date().toISOString(),
      reporting_currency: "CNY",
      precision: { calculation: "HIGH_PRECISION_DECIMAL", report_places: 4, display_places: 2 },
      ...out,
    };
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause) return cause as QueryServiceError;
    throw cause;
  }
}

export async function checkReadiness(
  pool: Pool,
): Promise<{ schema_version: string; active_release: string }> {
  const [schema, release] = await Promise.all([
    pool.query("SELECT logiplan.current_schema_version() AS version"),
    pool.query("SELECT data_release_id FROM logiplan.active_release"),
  ]);
  if (release.rowCount !== 1) throw new Error("活动正式版本数量不是 1");
  return {
    schema_version: String(schema.rows[0]?.version),
    active_release: String(release.rows[0]?.data_release_id),
  };
}
