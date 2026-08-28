import type { Pool } from "pg";
import {
  queryIntentSchema,
  type AnalysisScope,
  type DecimalValue,
  type EvidenceObject,
  type MoneyValue,
  type QueryIntent,
  type ResultWarning,
} from "@logiplan/contracts";
import { LogiPlanDecimal } from "@logiplan/domain";

import { runDiagnosticMetrics } from "./diagnostic-metrics";
import { evidence, resultId } from "./query-result";

type PreciseDecimal = InstanceType<typeof LogiPlanDecimal>;

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
  warnings: ResultWarning[];
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
const ratio = (n: PreciseDecimal): DecimalValue => ({
  high_precision: n.toFixed(),
  report: n.toFixed(4),
  display: n.toFixed(2),
  unit: "RATIO",
});
const varianceRate = (current: PreciseDecimal, baseline: PreciseDecimal) =>
  baseline.isZero() ? null : ratio(current.minus(baseline).div(baseline));
const monthDate = (m: string) => `${m}-01`;
const monthText = (value: unknown) =>
  value instanceof Date ? value.toISOString().slice(0, 7) : String(value).slice(0, 7);
const monthIndex = (month: string) => {
  const [year = 0, value = 0] = month.split("-").map(Number);
  return year * 12 + value - 1;
};
const monthFromIndex = (index: number) =>
  `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
const nextMonth = (month: string) => monthFromIndex(monthIndex(month) + 1);
const monthRange = (from: string, to: string) => {
  const start = monthIndex(from);
  const end = monthIndex(to);
  const count = end - start + 1;
  if (count < 1 || count > 120) return [];
  return Array.from({ length: count }, (_, offset) => monthFromIndex(start + offset));
};
const scopeLabel = (s: AnalysisScope) =>
  `${s.period.from}—${s.period.to}｜${s.destination_country_ids?.join(",") || "公司"}｜${s.comparison}`;

async function latestClosedMonth(pool: Pool, scope: AnalysisScope, requestId: string) {
  const versionIds = [scope.budget_version_id, scope.actual_version_id, scope.forecast_version_id];
  const result = await pool.query(
    `SELECT scenario_version_id, scenario_type, latest_closed_month::text AS latest_closed_month
     FROM logiplan.active_scenario_version
     WHERE scenario_version_id=ANY($1::text[]) AND calculation_version=$2`,
    [versionIds, scope.calculation_version],
  );
  const expected = [
    [scope.budget_version_id, "BUDGET"],
    [scope.actual_version_id, "ACTUAL"],
    [scope.forecast_version_id, "FORECAST"],
  ] as const;
  for (const [versionId, scenarioType] of expected) {
    if (
      !result.rows.some(
        (row) => row.scenario_version_id === versionId && row.scenario_type === scenarioType,
      )
    ) {
      throw error("VERSION_NOT_FOUND", `${scenarioType} 版本不存在或计算版本不匹配`, requestId);
    }
  }
  const latest = result.rows.find(
    (row) => row.scenario_version_id === scope.forecast_version_id,
  )?.latest_closed_month;
  if (!latest || monthText(latest) !== "2026-08") {
    throw error("VERSION_NOT_FOUND", "Forecast 版本结账边界必须为 2026-08", requestId);
  }
  return monthText(latest);
}

type CanonicalRouteRow = {
  route_id: string;
  destination_country_id: string;
  valid_from: unknown;
  valid_to: unknown | null;
};

type VariableCoverageRow = {
  scenario_version_id: string;
  month_id: unknown;
  route_id: string;
  component_count: number;
};

async function validateVariableCoverage(
  pool: Pool,
  scope: AnalysisScope,
  latestClosed: string,
  requestId: string,
) {
  const [routeResult, coverageResult] = await Promise.all([
    pool.query(
      `/* CANONICAL_ROUTES */
       SELECT route_id, destination_country_id, valid_from::text AS valid_from,
              valid_to::text AS valid_to
       FROM logiplan.active_fulfillment_route
       WHERE status='ACTIVE'
       ORDER BY route_id`,
    ),
    pool.query(
      `/* VARIABLE_COVERAGE */
       SELECT u.scenario_version_id, u.month_id::text AS month_id, u.route_id,
              COUNT(DISTINCT c.cost_category)::int AS component_count
       FROM logiplan.active_fulfillment_scenario_fact u
       JOIN logiplan.active_scenario_cost_component_fact c
         USING (data_release_id, fulfillment_fact_id)
       WHERE u.scenario_version_id=ANY($1::text[])
         AND u.month_id BETWEEN $2::date AND $3::date
         AND u.calculation_version=$4
       GROUP BY u.scenario_version_id, u.month_id, u.route_id`,
      [
        [scope.budget_version_id, scope.actual_version_id, scope.forecast_version_id],
        monthDate(scope.period.from),
        monthDate(scope.period.to),
        scope.calculation_version,
      ],
    ),
  ]);
  const routes = routeResult.rows as CanonicalRouteRow[];
  const coverage = coverageResult.rows as VariableCoverageRow[];
  for (const month of monthRange(scope.period.from, scope.period.to)) {
    const effectiveRoutes = routes.filter(
      (route) =>
        month >= monthText(route.valid_from) &&
        (route.valid_to === null || month <= monthText(route.valid_to)),
    );
    if (effectiveRoutes.length === 0) {
      throw error("RECONCILIATION_FAILED", `${month} 没有活动履约线路规范全集`, requestId);
    }
    const currentVersion =
      month <= latestClosed ? scope.actual_version_id : scope.forecast_version_id;
    for (const version of [scope.budget_version_id, currentVersion]) {
      for (const route of effectiveRoutes) {
        const row = coverage.find(
          (item) =>
            item.scenario_version_id === version &&
            monthText(item.month_id) === month &&
            item.route_id === route.route_id,
        );
        if (!row || Number(row.component_count) !== 6) {
          throw error(
            "RECONCILIATION_FAILED",
            `${month} 的 ${version} 线路 ${route.route_id} 六类变动成本事实不完整`,
            requestId,
          );
        }
      }
    }
  }
  return routes;
}

function error(
  code: QueryServiceError["code"],
  message_zh: string,
  request_id: string,
): QueryServiceError {
  return { error_id: `ERR-${request_id}`, code, message_zh, request_id };
}

const diagnosticMetricIds = [
  "ORDERS",
  "AIR_SHARE",
  "CARRIER_C_SHARE",
  "ON_TIME_RATE",
  "SERVICE_MATURITY",
] as const;

function validateIntent(intent: QueryIntent, request_id: string): QueryServiceError | null {
  if (intent.scope.period.from > intent.scope.period.to)
    return error("INVALID_PERIOD", "查询起始月份不得晚于结束月份", request_id);
  if (intent.question_type === "DIAGNOSTIC_METRICS") {
    const scope = intent.scope;
    if (scope.period.from !== "2026-08" || scope.period.to !== "2026-08") {
      return error("INVALID_PERIOD", "诊断指标仅支持 2026-08 单月范围", request_id);
    }
    if (scope.period.grain !== "MONTH") {
      return error("UNSUPPORTED_GRAIN", "诊断指标仅支持 MONTH 粒度", request_id);
    }
    if (scope.comparison !== "ACTUAL_VS_BUDGET") {
      return error("INVALID_FILTER", "诊断指标仅支持 ACTUAL_VS_BUDGET", request_id);
    }
    if (scope.destination_country_ids?.length !== 1 || scope.destination_country_ids[0] !== "GB") {
      return error("INVALID_FILTER", "诊断指标必须且只能指定目的国 GB", request_id);
    }
    if (!scope.actual_version_id) {
      return error("INVALID_FILTER", "诊断指标必须显式提供 Budget 和 Actual 版本", request_id);
    }
    const unsupportedFilter = [
      scope.fulfillment_center_ids,
      scope.transport_mode_ids,
      scope.carrier_ids,
      scope.cost_component_ids,
      scope.factor_id,
      scope.forecast_version_id,
      scope.scenario_version_id,
    ].some((value) => value !== undefined);
    if (unsupportedFilter || intent.top_n !== undefined) {
      return error("INVALID_FILTER", "诊断指标不支持额外维度、情景或 top_n 筛选", request_id);
    }
    if (
      intent.metrics.length !== diagnosticMetricIds.length ||
      intent.metrics.some((metric, index) => metric !== diagnosticMetricIds[index])
    ) {
      return error(
        "INVALID_METRIC",
        `诊断指标必须完整包含 ${diagnosticMetricIds.join(",")}`,
        request_id,
      );
    }
    if (intent.group_by.length !== 0) {
      return error("INVALID_DIMENSION", "目的国诊断指标不支持额外分组", request_id);
    }
  }
  const dashboardQueries = [
    "MONTHLY_COST_TREND",
    "TOP_ADVERSE_ANOMALIES",
    "FIXED_COST_BREAKDOWN",
  ] as const;
  if ((dashboardQueries as readonly string[]).includes(intent.question_type)) {
    const rules = {
      MONTHLY_COST_TREND: {
        metrics: ["LOGISTICS_TOTAL_COST"],
        groupBy: ["MONTH"],
        grain: "MONTH",
      },
      TOP_ADVERSE_ANOMALIES: {
        metrics: ["FULFILLMENT_VARIABLE_COST"],
        groupBy: ["MONTH", "DESTINATION_COUNTRY"],
        grain: "MONTH",
      },
      FIXED_COST_BREAKDOWN: {
        metrics: ["LOGISTICS_FIXED_COST"],
        groupBy: ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"],
        grain: "RANGE",
      },
    }[intent.question_type as (typeof dashboardQueries)[number]];
    if (intent.scope.period.from !== "2026-01" || intent.scope.period.to !== "2026-12") {
      return error("INVALID_PERIOD", "驾驶舱查询仅支持 2026-01 至 2026-12", request_id);
    }
    if (intent.scope.period.grain !== rules.grain) {
      return error("UNSUPPORTED_GRAIN", `该驾驶舱查询仅支持 ${rules.grain} 粒度`, request_id);
    }
    if (intent.scope.comparison !== "LATEST_OUTLOOK_VS_BUDGET") {
      return error("INVALID_FILTER", "驾驶舱查询仅支持 LATEST_OUTLOOK_VS_BUDGET", request_id);
    }
    if (!intent.scope.actual_version_id || !intent.scope.forecast_version_id) {
      return error(
        "INVALID_FILTER",
        "驾驶舱查询必须显式提供 Budget、Actual 和 Forecast 版本",
        request_id,
      );
    }
    const unsupportedFilter = [
      intent.scope.destination_country_ids,
      intent.scope.fulfillment_center_ids,
      intent.scope.transport_mode_ids,
      intent.scope.carrier_ids,
      intent.scope.cost_component_ids,
      intent.scope.factor_id,
      intent.scope.scenario_version_id,
    ].some((value) => value !== undefined);
    if (unsupportedFilter) {
      return error("INVALID_FILTER", "驾驶舱固定公司范围不支持额外维度或情景筛选", request_id);
    }
    if (
      intent.metrics.length !== rules.metrics.length ||
      intent.metrics.some((metric, index) => metric !== rules.metrics[index])
    ) {
      return error("INVALID_METRIC", `该查询仅支持指标 ${rules.metrics.join(",")}`, request_id);
    }
    if (
      intent.group_by.length !== rules.groupBy.length ||
      intent.group_by.some((dimension, index) => dimension !== rules.groupBy[index])
    ) {
      return error("INVALID_DIMENSION", `该查询仅支持分组 ${rules.groupBy.join(",")}`, request_id);
    }
    if (
      intent.question_type === "TOP_ADVERSE_ANOMALIES"
        ? intent.top_n !== undefined && intent.top_n !== 5
        : intent.top_n !== undefined
    ) {
      return error("INVALID_FILTER", "驾驶舱异常榜固定为 Top 5，其他查询不支持 top_n", request_id);
    }
  }
  if (intent.scope.period.grain === "RANGE" && intent.group_by.includes("MONTH"))
    return error("UNSUPPORTED_GRAIN", "范围粒度不支持按月份分组", request_id);
  if (intent.question_type === "EVIDENCE_LOOKUP")
    return error("EVIDENCE_NOT_FOUND", "V1.0 查询服务暂不接受未绑定结果的证据 ID", request_id);
  if (
    intent.metrics.some((metric) =>
      /ORDER_LEVEL|ORDER_DETAIL|ORDER_ID|TOP_ORDER|ORDER_COST/i.test(metric),
    )
  )
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

type MonthlyCostRow = {
  scenario_version_id: string;
  month_id: unknown;
  variable_cost: string;
  fixed_cost: string;
  variable_present: number;
  fixed_present: number;
};

async function monthlyCosts(pool: Pool, scope: AnalysisScope): Promise<MonthlyCostRow[]> {
  const versions = [
    scope.budget_version_id,
    scope.actual_version_id ?? "",
    scope.forecast_version_id ?? "",
  ];
  const result = await pool.query(
    `/* MONTHLY_COST_TREND */
     WITH monthly_cost AS (
       SELECT u.scenario_version_id, u.month_id,
              SUM(c.model_cny_amount) AS variable_cost, 0::numeric AS fixed_cost,
              1 AS variable_present, 0 AS fixed_present
       FROM logiplan.active_scenario_cost_component_fact c
       JOIN logiplan.active_fulfillment_scenario_fact u
         USING (data_release_id, fulfillment_fact_id)
       WHERE u.scenario_version_id=ANY($1::text[])
         AND u.month_id BETWEEN $2::date AND $3::date
         AND u.calculation_version=$4
       GROUP BY u.scenario_version_id, u.month_id
       UNION ALL
       SELECT f.scenario_version_id, f.month_id,
              0::numeric AS variable_cost, SUM(f.cny_amount) AS fixed_cost,
              0 AS variable_present, 1 AS fixed_present
       FROM logiplan.active_fixed_cost_scenario_fact f
       JOIN logiplan.active_scenario_version s
         USING (data_release_id, scenario_version_id)
       WHERE f.scenario_version_id=ANY($1::text[])
         AND f.month_id BETWEEN $2::date AND $3::date
         AND s.calculation_version=$4
       GROUP BY f.scenario_version_id, f.month_id
     )
     SELECT scenario_version_id, month_id::text AS month_id,
            SUM(variable_cost)::text AS variable_cost,
            SUM(fixed_cost)::text AS fixed_cost,
            MAX(variable_present)::int AS variable_present,
            MAX(fixed_present)::int AS fixed_present
     FROM monthly_cost
     GROUP BY scenario_version_id, month_id
     ORDER BY month_id, scenario_version_id`,
    [versions, monthDate(scope.period.from), monthDate(scope.period.to), scope.calculation_version],
  );
  return result.rows as MonthlyCostRow[];
}

const costParts = (row: MonthlyCostRow) => {
  const variable = new LogiPlanDecimal(row.variable_cost);
  const fixed = new LogiPlanDecimal(row.fixed_cost);
  return { variable, fixed, total: variable.plus(fixed) };
};

async function monthlyCostTrend(pool: Pool, intent: QueryIntent, requestId: string) {
  const s = intent.scope;
  const latestClosed = await latestClosedMonth(pool, s, requestId);
  await validateVariableCoverage(pool, s, latestClosed, requestId);
  const fixedCostRows = await loadFixedCostRows(pool, s);
  validateFixedCostCoverage(fixedCostRows, s, latestClosed, requestId);
  const rows = await monthlyCosts(pool, s);
  const find = (version: string | undefined, month: string) =>
    rows.find((row) => row.scenario_version_id === version && monthText(row.month_id) === month);
  const monthIds = monthRange(s.period.from, s.period.to);
  for (const month of monthIds) {
    const currentVersion = month <= latestClosed ? s.actual_version_id : s.forecast_version_id;
    for (const version of [s.budget_version_id, currentVersion]) {
      const row = find(version, month);
      if (!row || Number(row.variable_present) !== 1 || Number(row.fixed_present) !== 1) {
        throw error(
          "RECONCILIATION_FAILED",
          `${month} 的 ${version} 变动成本或固定成本事实不完整`,
          requestId,
        );
      }
    }
  }
  const months = monthIds.map((month) => {
    const seriesType = month <= latestClosed ? ("ACTUAL" as const) : ("FORECAST" as const);
    const currentVersion = seriesType === "ACTUAL" ? s.actual_version_id : s.forecast_version_id;
    const baseline = costParts(find(s.budget_version_id, month)!);
    const current = costParts(find(currentVersion, month)!);
    const variance = current.total.minus(baseline.total);
    return {
      month_id: month,
      series_type: seriesType,
      baseline: {
        total_cost: money(baseline.total),
        variable_cost: money(baseline.variable),
        fixed_cost: money(baseline.fixed),
      },
      current: {
        total_cost: money(current.total),
        variable_cost: money(current.variable),
        fixed_cost: money(current.fixed),
      },
      variance: money(variance),
      variance_rate: varianceRate(current.total, baseline.total),
      evidence_id: `MONTHLY_COST_TREND:${month}`,
    };
  });
  return {
    payload: {
      metric: "LOGISTICS_TOTAL_COST" as const,
      months,
      closing_boundary: {
        latest_closed_month: latestClosed,
        first_forecast_month: nextMonth(latestClosed),
      },
    },
    evidence: months.map((row) =>
      evidence(
        row.evidence_id,
        intent,
        `${row.month_id} 公司物流总成本差异`,
        row.variance.high_precision,
        "按月分别汇总履约变动成本与物流运营固定成本，并按结账边界组合 Actual/Forecast",
        {
          period: { from: row.month_id, to: row.month_id },
          group_by: ["MONTH"],
          source_refs: [
            "logiplan.active_scenario_cost_component_fact",
            "logiplan.active_fulfillment_scenario_fact",
            "logiplan.active_fixed_cost_scenario_fact",
            "logiplan.active_scenario_version",
          ],
        },
      ),
    ),
    warnings: [
      { code: "REPORT_ROUNDING" as const, message: "金额保留高精度、报告 4 位和界面 2 位" },
    ],
  };
}

type CountryCostRow = {
  scenario_version_id: string;
  month_id: unknown;
  destination_country_id: string;
  amount: string;
};

async function topAdverseAnomalies(pool: Pool, intent: QueryIntent, requestId: string) {
  const s = intent.scope;
  const latestClosed = await latestClosedMonth(pool, s, requestId);
  const canonicalRoutes = await validateVariableCoverage(pool, s, latestClosed, requestId);
  const params: unknown[] = [
    [s.budget_version_id, s.actual_version_id ?? "", s.forecast_version_id ?? ""],
    monthDate(s.period.from),
    monthDate(s.period.to),
    s.calculation_version,
  ];
  let countryFilter = "";
  if (s.destination_country_ids?.length) {
    params.push(s.destination_country_ids);
    countryFilter = `AND r.destination_country_id=ANY($${params.length}::text[])`;
  }
  const result = await pool.query(
    `/* TOP_ADVERSE_ANOMALIES */
     SELECT u.scenario_version_id, u.month_id::text AS month_id,
            r.destination_country_id, SUM(c.model_cny_amount)::text AS amount
     FROM logiplan.active_scenario_cost_component_fact c
     JOIN logiplan.active_fulfillment_scenario_fact u
       USING (data_release_id, fulfillment_fact_id)
     JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
     WHERE u.scenario_version_id=ANY($1::text[])
       AND u.month_id BETWEEN $2::date AND $3::date
       AND u.calculation_version=$4 ${countryFilter}
     GROUP BY u.scenario_version_id, u.month_id, r.destination_country_id`,
    params,
  );
  const rows = result.rows as CountryCostRow[];
  for (const month of monthRange(s.period.from, s.period.to)) {
    const currentVersion = month <= latestClosed ? s.actual_version_id : s.forecast_version_id;
    const countrySet = (version: string | undefined) =>
      new Set(
        rows
          .filter((row) => row.scenario_version_id === version && monthText(row.month_id) === month)
          .map((row) => row.destination_country_id),
      );
    const baselineCountries = countrySet(s.budget_version_id);
    const currentCountries = countrySet(currentVersion);
    const canonicalCountries = new Set(
      canonicalRoutes
        .filter(
          (route) =>
            month >= monthText(route.valid_from) &&
            (route.valid_to === null || month <= monthText(route.valid_to)),
        )
        .map((route) => route.destination_country_id),
    );
    if (
      baselineCountries.size !== canonicalCountries.size ||
      currentCountries.size !== canonicalCountries.size ||
      [...canonicalCountries].some(
        (country) => !baselineCountries.has(country) || !currentCountries.has(country),
      )
    ) {
      throw error(
        "RECONCILIATION_FAILED",
        `${month} 的月份×目的国 Budget 或当前履约变动成本事实不完整`,
        requestId,
      );
    }
  }
  const keys = [
    ...new Set(rows.map((row) => `${monthText(row.month_id)}|${row.destination_country_id}`)),
  ];
  const candidates = keys.flatMap((key) => {
    const [month = "", destinationCountryId = ""] = key.split("|");
    const seriesType = month <= latestClosed ? ("ACTUAL" as const) : ("FORECAST" as const);
    const currentVersion = seriesType === "ACTUAL" ? s.actual_version_id : s.forecast_version_id;
    const value = (version: string | undefined) =>
      new LogiPlanDecimal(
        rows.find(
          (row) =>
            row.scenario_version_id === version &&
            monthText(row.month_id) === month &&
            row.destination_country_id === destinationCountryId,
        )?.amount ?? 0,
      );
    const baseline = value(s.budget_version_id);
    const current = value(currentVersion);
    const variance = current.minus(baseline);
    return variance.isPositive()
      ? [{ month, destinationCountryId, seriesType, baseline, current, variance }]
      : [];
  });
  const adverseTotal = candidates.reduce(
    (sum, row) => sum.plus(row.variance),
    new LogiPlanDecimal(0),
  );
  candidates.sort(
    (left, right) =>
      right.variance.comparedTo(left.variance) ||
      left.month.localeCompare(right.month) ||
      left.destinationCountryId.localeCompare(right.destinationCountryId),
  );
  const anomalies = candidates.slice(0, 5).map((row, index) => ({
    rank: index + 1,
    month_id: row.month,
    destination_country_id: row.destinationCountryId,
    series_type: row.seriesType,
    baseline: money(row.baseline),
    current: money(row.current),
    variance: money(row.variance),
    variance_rate: varianceRate(row.current, row.baseline),
    adverse_contribution_share: adverseTotal.isZero()
      ? null
      : ratio(row.variance.div(adverseTotal)),
    evidence_id: `TOP_ADVERSE_ANOMALIES:${row.month}:${row.destinationCountryId}`,
  }));
  return {
    payload: {
      metric: "FULFILLMENT_VARIABLE_COST" as const,
      latest_closed_month: latestClosed,
      adverse_pool_total: money(adverseTotal),
      anomalies,
    },
    evidence: anomalies.map((row) =>
      evidence(
        row.evidence_id,
        intent,
        `${row.month_id} ${row.destination_country_id} 履约变动成本不利差异`,
        row.variance.high_precision,
        "按月份与目的国汇总履约变动成本；仅保留正差并按未舍入金额降序；贡献分母为全部正差之和",
        {
          period: { from: row.month_id, to: row.month_id },
          filters: { destination_country_id: [row.destination_country_id] },
          group_by: ["MONTH", "DESTINATION_COUNTRY"],
          source_refs: [
            "logiplan.active_scenario_cost_component_fact",
            "logiplan.active_fulfillment_scenario_fact",
            "logiplan.active_fulfillment_route",
            "logiplan.active_scenario_version",
          ],
        },
      ),
    ),
    warnings: [
      { code: "REPORT_ROUNDING" as const, message: "排序和贡献占比使用未展示舍入的高精度金额" },
    ],
  };
}

type FixedCostRow = {
  scenario_version_id: string;
  month_id: unknown;
  cost_scope_type: "FULFILLMENT_CENTER" | "SHARED";
  fulfillment_center_id: string | null;
  fixed_cost_category: string;
  amount: string;
};

async function loadFixedCostRows(pool: Pool, scope: AnalysisScope): Promise<FixedCostRow[]> {
  const result = await pool.query(
    `/* FIXED_COST_FACTS */
     SELECT f.scenario_version_id, f.month_id::text AS month_id, f.cost_scope_type,
            f.fulfillment_center_id, f.fixed_cost_category, SUM(f.cny_amount)::text AS amount
     FROM logiplan.active_fixed_cost_scenario_fact f
     JOIN logiplan.active_scenario_version s USING (data_release_id, scenario_version_id)
     WHERE f.scenario_version_id=ANY($1::text[])
       AND f.month_id BETWEEN $2::date AND $3::date
       AND s.calculation_version=$4
     GROUP BY f.scenario_version_id, f.month_id, f.cost_scope_type,
              f.fulfillment_center_id, f.fixed_cost_category`,
    [
      [scope.budget_version_id, scope.actual_version_id, scope.forecast_version_id],
      monthDate(scope.period.from),
      monthDate(scope.period.to),
      scope.calculation_version,
    ],
  );
  return result.rows as FixedCostRow[];
}

const expectedFixedCostScopes = new Map<string, readonly string[]>([
  ["WAREHOUSE_RENT", ["DE_FC", "FR_FC"]],
  ["FRONTLINE_BASE_LABOR", ["DE_FC", "FR_FC"]],
  ["WAREHOUSE_MANAGEMENT_LABOR", ["DE_FC", "FR_FC"]],
  ["SYSTEM_COST", ["SHARED"]],
]);

const fixedScopeId = (row: FixedCostRow) =>
  row.cost_scope_type === "SHARED" ? "SHARED" : String(row.fulfillment_center_id);

function validateFixedCostCoverage(
  rows: FixedCostRow[],
  scope: AnalysisScope,
  latestClosed: string,
  requestId: string,
) {
  if (
    rows.some(
      (row) => !expectedFixedCostScopes.get(row.fixed_cost_category)?.includes(fixedScopeId(row)),
    )
  ) {
    throw error("RECONCILIATION_FAILED", "固定成本包含不支持的类别或虚假归属", requestId);
  }
  for (const month of monthRange(scope.period.from, scope.period.to)) {
    const currentVersion =
      month <= latestClosed ? scope.actual_version_id : scope.forecast_version_id;
    for (const [category, expected] of expectedFixedCostScopes) {
      for (const scopeId of expected) {
        for (const version of [scope.budget_version_id, currentVersion]) {
          if (
            !rows.some(
              (row) =>
                row.scenario_version_id === version &&
                monthText(row.month_id) === month &&
                row.fixed_cost_category === category &&
                fixedScopeId(row) === scopeId,
            )
          ) {
            throw error(
              "RECONCILIATION_FAILED",
              `${month} 的 ${version} 固定成本类别或归属事实不完整`,
              requestId,
            );
          }
        }
      }
    }
  }
}

const fixedCostCategories = [
  ["WAREHOUSE_RENT", "仓租"],
  ["FRONTLINE_BASE_LABOR", "一线作业基础人工"],
  ["WAREHOUSE_MANAGEMENT_LABOR", "仓库管理人工"],
  ["SYSTEM_COST", "系统费用"],
] as const;

async function fixedCostBreakdown(pool: Pool, intent: QueryIntent, requestId: string) {
  const s = intent.scope;
  const latestClosed = await latestClosedMonth(pool, s, requestId);
  const rows = await loadFixedCostRows(pool, s);
  validateFixedCostCoverage(rows, s, latestClosed, requestId);
  const scopes = [...new Set(rows.map(fixedScopeId))].sort();
  const amount = (category: string, scopeId: string, versionKind: "BASELINE" | "CURRENT") =>
    rows
      .filter((row) => {
        const rowScope = fixedScopeId(row);
        if (row.fixed_cost_category !== category || rowScope !== scopeId) return false;
        if (versionKind === "BASELINE") return row.scenario_version_id === s.budget_version_id;
        const month = monthText(row.month_id);
        return (
          row.scenario_version_id ===
          (month <= latestClosed ? s.actual_version_id : s.forecast_version_id)
        );
      })
      .reduce((sum, row) => sum.plus(row.amount), new LogiPlanDecimal(0));
  const categories = fixedCostCategories.map(([categoryId, label]) => {
    const allocations = scopes.flatMap((scopeId) => {
      const categoryExists = rows.some((row) => {
        const rowScope = fixedScopeId(row);
        return row.fixed_cost_category === categoryId && rowScope === scopeId;
      });
      if (!categoryExists) return [];
      const baseline = amount(categoryId, scopeId, "BASELINE");
      const current = amount(categoryId, scopeId, "CURRENT");
      return [
        {
          scope_type: scopeId === "SHARED" ? ("SHARED" as const) : ("FULFILLMENT_CENTER" as const),
          scope_id: scopeId,
          fulfillment_center_id: scopeId === "SHARED" ? null : scopeId,
          baseline: money(baseline),
          current: money(current),
          variance: money(current.minus(baseline)),
          variance_rate: varianceRate(current, baseline),
          evidence_id: `FIXED_COST_BREAKDOWN:${categoryId}:${scopeId}`,
        },
      ];
    });
    const baseline = allocations.reduce(
      (sum, row) => sum.plus(row.baseline.high_precision),
      new LogiPlanDecimal(0),
    );
    const current = allocations.reduce(
      (sum, row) => sum.plus(row.current.high_precision),
      new LogiPlanDecimal(0),
    );
    return {
      fixed_cost_category: categoryId,
      label_zh: label,
      baseline: money(baseline),
      current: money(current),
      variance: money(current.minus(baseline)),
      variance_rate: varianceRate(current, baseline),
      allocations,
      evidence_id: `FIXED_COST_BREAKDOWN:${categoryId}`,
    };
  });
  const baseline = categories.reduce(
    (sum, row) => sum.plus(row.baseline.high_precision),
    new LogiPlanDecimal(0),
  );
  const current = categories.reduce(
    (sum, row) => sum.plus(row.current.high_precision),
    new LogiPlanDecimal(0),
  );
  const total = {
    baseline: money(baseline),
    current: money(current),
    variance: money(current.minus(baseline)),
    variance_rate: varianceRate(current, baseline),
    evidence_id: "FIXED_COST_BREAKDOWN:TOTAL",
  };
  const evidenceSources = {
    source_refs: ["logiplan.active_fixed_cost_scenario_fact", "logiplan.active_scenario_version"],
  };
  return {
    payload: {
      metric: "LOGISTICS_FIXED_COST" as const,
      latest_closed_month: latestClosed,
      total,
      categories,
      reconciliation: {
        baseline_delta: money(0),
        current_delta: money(0),
        variance_delta: money(0),
      },
    },
    evidence: [
      evidence(
        total.evidence_id,
        intent,
        "公司物流运营固定成本",
        total.variance.high_precision,
        "按类别及真实仓级或共享层归属汇总，并按结账边界组合 Actual/Forecast",
        { ...evidenceSources, group_by: [] },
      ),
      ...categories.flatMap((category) => [
        evidence(
          category.evidence_id,
          intent,
          `${category.label_zh}差异`,
          category.variance.high_precision,
          "固定成本类别汇总",
          {
            ...evidenceSources,
            filters: { fixed_cost_category: [category.fixed_cost_category] },
            group_by: ["FIXED_COST_CATEGORY"],
          },
        ),
        ...category.allocations.map((allocation) =>
          evidence(
            allocation.evidence_id,
            intent,
            `${category.label_zh}｜${allocation.scope_id}差异`,
            allocation.variance.high_precision,
            "固定成本真实归属层汇总；未分摊到目的国、承运商或运输方式",
            {
              ...evidenceSources,
              filters: {
                fixed_cost_category: [category.fixed_cost_category],
                ...(allocation.scope_type === "SHARED"
                  ? { cost_scope_type: ["SHARED"] }
                  : { fulfillment_center_id: [allocation.scope_id] }),
              },
              group_by: ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"],
            },
          ),
        ),
      ]),
    ],
    warnings: [
      { code: "REPORT_ROUNDING" as const, message: "金额保留高精度、报告 4 位和界面 2 位" },
    ],
  };
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

const factorIds = ["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"] as const;
const factorMap = (rows: Array<{ factor: string; amount: string }>) =>
  Object.fromEntries(
    factorIds.map((f) => [f, money(rows.find((r) => r.factor === f)?.amount ?? "0")]),
  ) as Record<(typeof factorIds)[number], MoneyValue>;
const zhCost: Record<string, string> = {
  BASE_FREIGHT: "基础运费",
  FUEL_SURCHARGE: "燃油附加费",
  BILLABLE_EXCEPTION: "计费异常",
  FRONTLINE_VARIABLE_LABOR: "一线弹性人工",
  PACKAGING: "包装材料",
  RETURN_LOGISTICS: "退货物流",
};

async function drilldown(pool: Pool, intent: QueryIntent) {
  const s = intent.scope;
  const countryIds = s.destination_country_ids ?? ["GB"];
  const versions = [s.budget_version_id, s.actual_version_id ?? ""];
  const params: unknown[] = [
    versions,
    monthDate(s.period.from),
    monthDate(s.period.to),
    countryIds,
  ];
  const costs = await pool.query(
    `SELECT u.scenario_version_id, r.fulfillment_center_id, c.cost_category, SUM(c.model_cny_amount)::text AS amount
    FROM logiplan.active_scenario_cost_component_fact c
    JOIN logiplan.active_fulfillment_scenario_fact u USING (data_release_id, fulfillment_fact_id)
    JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
    WHERE u.scenario_version_id = ANY($1::text[]) AND u.month_id BETWEEN $2::date AND $3::date AND r.destination_country_id = ANY($4::text[])
    GROUP BY u.scenario_version_id, r.fulfillment_center_id, c.cost_category`,
    params,
  );
  const factors = await pool.query(
    `SELECT r.fulfillment_center_id, f.cost_category, f.factor, SUM(f.attribution_cny)::text AS amount
    FROM logiplan.active_variance_attribution_fact f
    JOIN logiplan.active_variance_comparison c USING (data_release_id, comparison_id)
    JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
    WHERE c.budget_version_id=$1 AND c.comparison_scenario_version_id=$2 AND f.attribution_method='CHAIN_SUBSTITUTION' AND f.month_id BETWEEN $3::date AND $4::date AND r.destination_country_id=ANY($5::text[])
    GROUP BY r.fulfillment_center_id, f.cost_category, f.factor`,
    [
      s.budget_version_id,
      s.actual_version_id ?? s.forecast_version_id,
      monthDate(s.period.from),
      monthDate(s.period.to),
      countryIds,
    ],
  );
  const centers = [...new Set(costs.rows.map((r) => String(r.fulfillment_center_id)))].sort();
  const rows: Array<{
    evidence_ids: string[];
    label_zh: string;
    variance: MoneyValue;
    [key: string]: unknown;
  }> = [];
  for (const center of centers) {
    const centerCosts = costs.rows.filter((r) => String(r.fulfillment_center_id) === center);
    const b = centerCosts
      .filter((r) => r.scenario_version_id === s.budget_version_id)
      .reduce((x, r) => x.plus(String(r.amount)), new LogiPlanDecimal(0));
    const a = centerCosts
      .filter((r) => r.scenario_version_id === s.actual_version_id)
      .reduce((x, r) => x.plus(String(r.amount)), new LogiPlanDecimal(0));
    const centerFactors = factors.rows
      .filter((r) => String(r.fulfillment_center_id) === center)
      .reduce(
        (m, r) => {
          m.push({ factor: String(r.factor), amount: String(r.amount) });
          return m;
        },
        [] as Array<{ factor: string; amount: string }>,
      );
    rows.push({
      row_id: `FC:${center}`,
      parent_row_id: null,
      level: "FULFILLMENT_CENTER",
      dimension_id: center,
      label_zh: center,
      baseline_cost: money(b),
      current_cost: money(a),
      variance: money(a.minus(b)),
      variance_rate: b.isZero()
        ? null
        : {
            high_precision: a.minus(b).div(b).toFixed(),
            report: a.minus(b).div(b).toFixed(4),
            display: a.minus(b).div(b).toFixed(2),
            unit: "RATIO",
          },
      adverse_contribution_share: null,
      saving_contribution_share: null,
      factor_contributions: factorMap(centerFactors),
      children_available: true,
      evidence_ids: [`E09-${center}`],
    });
    const categories = [...new Set(centerCosts.map((r) => String(r.cost_category)))].sort();
    for (const category of categories) {
      const bcat = centerCosts
        .filter(
          (r) => r.scenario_version_id === s.budget_version_id && r.cost_category === category,
        )
        .reduce((x, r) => x.plus(String(r.amount)), new LogiPlanDecimal(0));
      const acat = centerCosts
        .filter(
          (r) => r.scenario_version_id === s.actual_version_id && r.cost_category === category,
        )
        .reduce((x, r) => x.plus(String(r.amount)), new LogiPlanDecimal(0));
      const catFactors = factors.rows
        .filter((r) => String(r.fulfillment_center_id) === center && r.cost_category === category)
        .map((r) => ({ factor: String(r.factor), amount: String(r.amount) }));
      rows.push({
        row_id: `FC:${center}/COST:${category}`,
        parent_row_id: `FC:${center}`,
        level: "COST_COMPONENT",
        dimension_id: category,
        label_zh: zhCost[category] ?? category,
        baseline_cost: money(bcat),
        current_cost: money(acat),
        variance: money(acat.minus(bcat)),
        variance_rate: bcat.isZero()
          ? null
          : {
              high_precision: acat.minus(bcat).div(bcat).toFixed(),
              report: acat.minus(bcat).div(bcat).toFixed(4),
              display: acat.minus(bcat).div(bcat).toFixed(2),
              unit: "RATIO",
            },
        adverse_contribution_share: null,
        saving_contribution_share: null,
        factor_contributions: factorMap(catFactors),
        children_available: false,
        evidence_ids: [`E09-${center}-${category}`],
      });
    }
  }
  return {
    payload: { rows, primary_contribution: s.factor_id ?? "VARIANCE", method: "CHAIN" as const },
    evidence: rows.map((row) =>
      evidence(
        row.evidence_ids[0] ?? "",
        intent,
        row.label_zh,
        row.variance.high_precision,
        "按线路归属仓库和成本组件汇总；因素来自 CHAIN_SUBSTITUTION",
      ),
    ),
    warnings: [],
  };
}

async function warehouseContext(pool: Pool, intent: QueryIntent) {
  const s = intent.scope;
  const rows = await pool.query(
    `SELECT u.scenario_version_id, r.fulfillment_center_id, SUM(c.model_cny_amount)::text AS amount
    FROM logiplan.active_scenario_cost_component_fact c JOIN logiplan.active_fulfillment_scenario_fact u USING (data_release_id, fulfillment_fact_id) JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
    WHERE u.scenario_version_id = ANY($1::text[]) AND u.month_id BETWEEN $2::date AND $3::date GROUP BY u.scenario_version_id, r.fulfillment_center_id ORDER BY r.fulfillment_center_id`,
    [
      [s.budget_version_id, s.actual_version_id ?? ""],
      monthDate(s.period.from),
      monthDate(s.period.to),
    ],
  );
  const centers = [...new Set(rows.rows.map((r) => String(r.fulfillment_center_id)))].sort();
  const warehouses = centers.map((center) => {
    const base =
      rows.rows.find(
        (r) => r.fulfillment_center_id === center && r.scenario_version_id === s.budget_version_id,
      )?.amount ?? "0";
    const current =
      rows.rows.find(
        (r) => r.fulfillment_center_id === center && r.scenario_version_id === s.actual_version_id,
      )?.amount ?? "0";
    return {
      fulfillment_center_id: center,
      baseline_cost: money(base),
      current_cost: money(current),
      variance: money(new LogiPlanDecimal(current).minus(base)),
      evidence_id: `E08-${center}`,
    };
  });
  const baseline = warehouses.reduce(
    (x, row) => x.plus(row.baseline_cost.high_precision),
    new LogiPlanDecimal(0),
  );
  const current = warehouses.reduce(
    (x, row) => x.plus(row.current_cost.high_precision),
    new LogiPlanDecimal(0),
  );
  const variance = current.minus(baseline);
  return {
    payload: {
      warehouses,
      company_total: {
        baseline_cost: money(baseline),
        current_cost: money(current),
        variance: money(variance),
      },
      scope: "COMPANY_VARIABLE_COST_ONLY" as const,
    },
    evidence: [
      ...warehouses.map((row) =>
        evidence(
          row.evidence_id,
          intent,
          `${row.fulfillment_center_id} 仓差异`,
          row.variance.high_precision,
          "按公司范围活动履约变动成本按发货仓汇总",
        ),
      ),
      evidence(
        "E08-company-total",
        intent,
        "公司发货仓差异合计",
        variance.toFixed(),
        "公司范围发货仓差异勾稽",
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
        : intent.question_type === "MONTHLY_COST_TREND"
          ? await monthlyCostTrend(pool, intent, request_id)
          : intent.question_type === "TOP_ADVERSE_ANOMALIES"
            ? await topAdverseAnomalies(pool, intent, request_id)
            : intent.question_type === "FIXED_COST_BREAKDOWN"
              ? await fixedCostBreakdown(pool, intent, request_id)
              : intent.question_type === "COUNTRY_VARIANCE_SUMMARY"
                ? await country(pool, intent)
                : intent.question_type === "DIAGNOSTIC_METRICS"
                  ? await runDiagnosticMetrics(pool, intent, request_id)
                  : intent.question_type === "ATTRIBUTION_BRIDGE"
                    ? await bridge(pool, intent)
                    : intent.question_type === "ATTRIBUTION_DRILLDOWN"
                      ? await drilldown(pool, intent)
                      : intent.question_type === "WAREHOUSE_VARIANCE_CONTEXT"
                        ? await warehouseContext(pool, intent)
                        : {
                            payload: {
                              status: "SUPPORTED_DATA_ACCESS_PENDING",
                              question_type: intent.question_type,
                            },
                            evidence: [],
                            warnings: [] as ResultWarning[],
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
