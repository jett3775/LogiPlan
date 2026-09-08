import type { Client, Pool } from "pg";
import {
  queryIntentSchema,
  type AnalysisScope,
  type DecimalValue,
  type QueryContractVersion,
  type EvidenceObject,
  type MoneyValue,
  type QueryIntent,
  type ResultWarning,
} from "@logiplan/contracts";
import { LogiPlanDecimal } from "@logiplan/domain";

import { runDiagnosticMetrics } from "./diagnostic-metrics";
import { evidence, resultId } from "./query-result";
import {
  lookupEvidenceSnapshot,
  persistEvidenceSnapshot,
  persistQueryEvidenceSnapshot,
} from "./evidence-snapshot";

type QueryDatabase = Pick<Pool, "query">;

type PreciseDecimal = InstanceType<typeof LogiPlanDecimal>;

export type DeterministicResult = {
  contract_version: QueryContractVersion;
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
const contractVersion = (intent: QueryIntent): QueryContractVersion =>
  "contract_version" in intent ? "V1.1" : "V1.0";
// D-015/D-091/D-167: all internal variable-cost aggregates use unrounded facts.
// money() generates report/display values only after the complete aggregation.
const variableAmountSql = "c.model_cny_amount";

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

const canonicalScope = (scope: AnalysisScope): string => {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  return canonical(scope);
};

const evidenceDashboardRangeScope: AnalysisScope = {
  period: { from: "2026-01", to: "2026-12", grain: "RANGE" },
  comparison: "LATEST_OUTLOOK_VS_BUDGET",
  budget_version_id: "BUDGET_2026_V1",
  actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
  forecast_version_id: "FORECAST_2026_08_V1",
  calculation_version: "D-092",
};
const evidenceDashboardMonthScope: AnalysisScope = {
  ...evidenceDashboardRangeScope,
  period: { from: "2026-01", to: "2026-12", grain: "MONTH" },
};
const evidenceWarehouseScope: AnalysisScope = {
  period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
  comparison: "ACTUAL_VS_BUDGET",
  budget_version_id: "BUDGET_2026_V1",
  actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
  calculation_version: "D-092",
};
const evidenceAttributionScope: AnalysisScope = {
  period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
  comparison: "ACTUAL_VS_BUDGET",
  destination_country_ids: ["GB"],
  budget_version_id: "BUDGET_2026_V1",
  actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
  calculation_version: "D-092",
};

const publishIntent = (
  question_type: QueryIntent["question_type"],
  scope: AnalysisScope,
  metrics: string[],
  group_by: QueryIntent["group_by"],
  top_n?: number,
): QueryIntent => ({
  contract_version: "V1.1",
  question_type,
  scope,
  metrics,
  group_by,
  ...(top_n === undefined ? {} : { top_n }),
  output_locale: "zh-CN",
  context_sources: ["PAGE_VISIBLE_STATE", "FIXED_TEMPLATE"],
});

export const releaseEvidenceSnapshotIntents: readonly QueryIntent[] = [
  publishIntent("DASHBOARD_OVERVIEW", evidenceDashboardRangeScope, ["COST"], []),
  publishIntent(
    "MONTHLY_COST_TREND",
    evidenceDashboardMonthScope,
    ["LOGISTICS_TOTAL_COST"],
    ["MONTH"],
  ),
  publishIntent(
    "TOP_ADVERSE_ANOMALIES",
    evidenceDashboardMonthScope,
    ["FULFILLMENT_VARIABLE_COST"],
    ["MONTH", "DESTINATION_COUNTRY"],
    5,
  ),
  publishIntent(
    "FIXED_COST_BREAKDOWN",
    evidenceDashboardRangeScope,
    ["LOGISTICS_FIXED_COST"],
    ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"],
  ),
  publishIntent(
    "WAREHOUSE_VARIANCE_CONTEXT",
    evidenceWarehouseScope,
    ["FULFILLMENT_VARIABLE_COST"],
    ["FULFILLMENT_CENTER"],
  ),
  publishIntent(
    "COUNTRY_VARIANCE_SUMMARY",
    evidenceAttributionScope,
    ["FULFILLMENT_VARIABLE_COST"],
    [],
  ),
  publishIntent("ATTRIBUTION_BRIDGE", evidenceAttributionScope, ["FULFILLMENT_VARIABLE_COST"], []),
  publishIntent(
    "DIAGNOSTIC_METRICS",
    evidenceAttributionScope,
    ["ORDERS", "AIR_SHARE", "CARRIER_C_SHARE", "ON_TIME_RATE", "SERVICE_MATURITY"],
    [],
  ),
  publishIntent(
    "ATTRIBUTION_DRILLDOWN",
    evidenceAttributionScope,
    ["FULFILLMENT_VARIABLE_COST"],
    ["FULFILLMENT_CENTER", "TRANSPORT_MODE", "CARRIER", "COST_COMPONENT"],
  ),
];

async function latestClosedMonth(pool: QueryDatabase, scope: AnalysisScope, requestId: string) {
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
  pool: QueryDatabase,
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
  if (
    intent.question_type === "EVIDENCE_LOOKUP" &&
    !("contract_version" in intent && intent.evidence_id)
  )
    return error("EVIDENCE_NOT_FOUND", "V1.0 不支持按 evidence_id 查询证据", request_id);
  if (intent.question_type === "EVIDENCE_LOOKUP") {
    if (intent.metrics.length !== 0 || intent.group_by.length !== 0 || intent.top_n !== undefined) {
      return error(
        "INVALID_FILTER",
        "EVIDENCE_LOOKUP 只接受顶层 evidence_id，不接受指标、分组或 top_n",
        request_id,
      );
    }
  }
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
  pool: QueryDatabase,
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
  const sql = `SELECT COALESCE(SUM(${variableAmountSql}),0)::text AS variable_cost, COALESCE(SUM(f.cny_amount) FILTER (WHERE f.cost_scope_type IN ('FULFILLMENT_CENTER','SHARED')),0)::text AS fixed_cost
    FROM logiplan.active_scenario_cost_component_fact c JOIN logiplan.active_fulfillment_scenario_fact u USING (data_release_id, fulfillment_fact_id)
    JOIN logiplan.active_scenario_version v USING (data_release_id, scenario_version_id)
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

type DashboardOperatingRow = {
  order_qty: string;
  package_qty: string;
  chargeable_weight_kg: string;
  variable_cost: string;
  transport_cost: string;
  gmv: string;
};

async function dashboardOperatingByVersion(
  pool: QueryDatabase,
  scope: AnalysisScope,
  versionId: string,
): Promise<DashboardOperatingRow> {
  const result = await pool.query(
    `/* DASHBOARD_OPERATING_METRICS */
     WITH operations AS (
       SELECT COALESCE(SUM(equivalent_order_qty), 0)::text AS order_qty,
              COALESCE(SUM(package_qty), 0)::text AS package_qty,
              COALESCE(SUM(chargeable_weight_kg), 0)::text AS chargeable_weight_kg
       FROM logiplan.active_fulfillment_scenario_fact
       WHERE scenario_version_id=$1
         AND month_id BETWEEN $2::date AND $3::date
         AND calculation_version=$4
     ), costs AS (
       SELECT COALESCE(SUM(${variableAmountSql}), 0)::text AS variable_cost,
              COALESCE(SUM(${variableAmountSql}) FILTER (
                WHERE c.cost_category IN ('BASE_FREIGHT','FUEL_SURCHARGE','BILLABLE_EXCEPTION')
              ), 0)::text AS transport_cost
       FROM logiplan.active_scenario_cost_component_fact c
       JOIN logiplan.active_fulfillment_scenario_fact u
         USING (data_release_id, fulfillment_fact_id)
       JOIN logiplan.active_scenario_version v
         USING (data_release_id, scenario_version_id)
       WHERE u.scenario_version_id=$1
         AND u.month_id BETWEEN $2::date AND $3::date
         AND u.calculation_version=$4
     ), gmv AS (
       SELECT COALESCE(SUM(cny_amount), 0)::text AS gmv
       FROM logiplan.active_scenario_gmv_fact
       WHERE scenario_version_id=$1
         AND month_id BETWEEN $2::date AND $3::date
     )
     SELECT operations.order_qty, operations.package_qty, operations.chargeable_weight_kg,
            costs.variable_cost, costs.transport_cost, gmv.gmv
     FROM operations CROSS JOIN costs CROSS JOIN gmv`,
    [
      versionId,
      monthDate(scope.period.from),
      monthDate(scope.period.to),
      scope.calculation_version,
    ],
  );
  const row = result.rows[0] as Partial<DashboardOperatingRow> | undefined;
  return {
    order_qty: q(row?.order_qty),
    package_qty: q(row?.package_qty),
    chargeable_weight_kg: q(row?.chargeable_weight_kg),
    variable_cost: q(row?.variable_cost),
    transport_cost: q(row?.transport_cost),
    gmv: q(row?.gmv),
  };
}

type MonthlyCostRow = {
  scenario_version_id: string;
  month_id: unknown;
  variable_cost: string;
  fixed_cost: string;
  variable_present: number;
  fixed_present: number;
};

async function monthlyCosts(pool: QueryDatabase, scope: AnalysisScope): Promise<MonthlyCostRow[]> {
  const versions = [
    scope.budget_version_id,
    scope.actual_version_id ?? "",
    scope.forecast_version_id ?? "",
  ];
  const result = await pool.query(
    `/* MONTHLY_COST_TREND */
     WITH monthly_cost AS (
       SELECT u.scenario_version_id, u.month_id,
              SUM(${variableAmountSql}) AS variable_cost, 0::numeric AS fixed_cost,
              1 AS variable_present, 0 AS fixed_present
       FROM logiplan.active_scenario_cost_component_fact c
       JOIN logiplan.active_fulfillment_scenario_fact u
         USING (data_release_id, fulfillment_fact_id)
       JOIN logiplan.active_scenario_version v
         USING (data_release_id, scenario_version_id)
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

async function monthlyCostTrend(pool: QueryDatabase, intent: QueryIntent, requestId: string) {
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

async function topAdverseAnomalies(pool: QueryDatabase, intent: QueryIntent, requestId: string) {
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
     WITH scoped_fulfillment AS MATERIALIZED (
       SELECT data_release_id, fulfillment_fact_id, scenario_version_id, month_id, route_id
       FROM logiplan.active_fulfillment_scenario_fact
       WHERE scenario_version_id=ANY($1::text[])
         AND month_id BETWEEN $2::date AND $3::date
         AND calculation_version=$4
     )
     SELECT u.scenario_version_id, u.month_id::text AS month_id,
            r.destination_country_id, SUM(${variableAmountSql})::text AS amount
     FROM scoped_fulfillment u
     JOIN logiplan.active_scenario_cost_component_fact c
       USING (data_release_id, fulfillment_fact_id)
     JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
     WHERE true ${countryFilter}
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

async function loadFixedCostRows(
  pool: QueryDatabase,
  scope: AnalysisScope,
): Promise<FixedCostRow[]> {
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

async function fixedCostBreakdown(pool: QueryDatabase, intent: QueryIntent, requestId: string) {
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

async function dashboard(pool: QueryDatabase, intent: QueryIntent) {
  const s = intent.scope;
  const emptyOperating: DashboardOperatingRow = {
    order_qty: "0",
    package_qty: "0",
    chargeable_weight_kg: "0",
    variable_cost: "0",
    transport_cost: "0",
    gmv: "0",
  };
  const [budget, actual, forecast, budgetOperating, actualOperating, forecastOperating] =
    await Promise.all([
      costByVersion(pool, s, s.budget_version_id),
      s.actual_version_id
        ? costByVersion(pool, s, s.actual_version_id)
        : Promise.resolve({ variable: "0", fixed: "0" }),
      s.forecast_version_id
        ? costByVersion(pool, s, s.forecast_version_id)
        : Promise.resolve({ variable: "0", fixed: "0" }),
      dashboardOperatingByVersion(pool, s, s.budget_version_id),
      s.actual_version_id
        ? dashboardOperatingByVersion(pool, s, s.actual_version_id)
        : Promise.resolve(emptyOperating),
      s.forecast_version_id
        ? dashboardOperatingByVersion(pool, s, s.forecast_version_id)
        : Promise.resolve(emptyOperating),
    ]);
  const latest = {
    variable: new LogiPlanDecimal(actual.variable).plus(forecast.variable),
    fixed: new LogiPlanDecimal(actual.fixed).plus(forecast.fixed),
  };
  const total = (x: { variable: string | unknown; fixed: string | unknown }) =>
    new LogiPlanDecimal(String(x.variable)).plus(String(x.fixed));
  const budgetTotal = total(budget);
  const latestTotal = total(latest);
  const variance = latestTotal.minus(budgetTotal);
  const combineOperating = (left: DashboardOperatingRow, right: DashboardOperatingRow) => ({
    order_qty: new LogiPlanDecimal(left.order_qty).plus(right.order_qty),
    package_qty: new LogiPlanDecimal(left.package_qty).plus(right.package_qty),
    chargeable_weight_kg: new LogiPlanDecimal(left.chargeable_weight_kg).plus(
      right.chargeable_weight_kg,
    ),
    variable_cost: new LogiPlanDecimal(left.variable_cost).plus(right.variable_cost),
    transport_cost: new LogiPlanDecimal(left.transport_cost).plus(right.transport_cost),
    gmv: new LogiPlanDecimal(left.gmv).plus(right.gmv),
  });
  const budgetOps = combineOperating(budgetOperating, emptyOperating);
  const latestOps = combineOperating(actualOperating, forecastOperating);
  const safeMoneyRatio = (numerator: PreciseDecimal, denominator: PreciseDecimal) =>
    denominator.isZero() ? null : money(numerator.div(denominator));
  const safeRatio = (numerator: PreciseDecimal, denominator: PreciseDecimal) =>
    denominator.isZero() ? null : ratio(numerator.div(denominator));
  const payload = {
    kpis: {
      budget: money(budgetTotal),
      latest_outlook: money(latestTotal),
      variance: money(variance),
      variance_rate: varianceRate(latestTotal, budgetTotal),
      variable_cost_budget: money(budget.variable),
      variable_cost_latest_outlook: money(latest.variable),
      variable_cost_variance: money(latest.variable.minus(budget.variable)),
      fixed_cost_latest_outlook: money(latest.fixed),
      fulfillment_cost_per_order_budget: safeMoneyRatio(
        budgetOps.variable_cost,
        budgetOps.order_qty,
      ),
      fulfillment_cost_per_order_latest_outlook: safeMoneyRatio(
        latestOps.variable_cost,
        latestOps.order_qty,
      ),
      transport_cost_per_kg_budget: safeMoneyRatio(
        budgetOps.transport_cost,
        budgetOps.chargeable_weight_kg,
      ),
      transport_cost_per_kg_latest_outlook: safeMoneyRatio(
        latestOps.transport_cost,
        latestOps.chargeable_weight_kg,
      ),
      logistics_total_cost_rate_budget: safeRatio(budgetTotal, budgetOps.gmv),
      logistics_total_cost_rate_latest_outlook: safeRatio(latestTotal, latestOps.gmv),
    },
    operating_totals: {
      budget: {
        order_qty: q(budgetOps.order_qty),
        package_qty: q(budgetOps.package_qty),
        chargeable_weight_kg: q(budgetOps.chargeable_weight_kg),
        gmv: money(budgetOps.gmv),
      },
      latest_outlook: {
        order_qty: q(latestOps.order_qty),
        package_qty: q(latestOps.package_qty),
        chargeable_weight_kg: q(latestOps.chargeable_weight_kg),
        gmv: money(latestOps.gmv),
      },
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

async function country(pool: QueryDatabase, intent: QueryIntent) {
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
        { filters: { destination_country_id: [id] } },
      ),
    ],
    warnings: [],
  };
}

async function bridge(pool: QueryDatabase, intent: QueryIntent) {
  const s = intent.scope;
  const [rows, baselineCost, currentCost] = await Promise.all([
    pool.query(
      `SELECT factor, COALESCE(SUM(attribution_cny),0)::text AS amount FROM logiplan.active_variance_attribution_fact f JOIN logiplan.active_variance_comparison c USING (data_release_id, comparison_id) JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id) WHERE c.budget_version_id=$1 AND c.comparison_scenario_version_id=$2 AND f.attribution_method='CHAIN_SUBSTITUTION' AND f.month_id BETWEEN $3::date AND $4::date AND ($5::text[] IS NULL OR r.destination_country_id=ANY($5::text[])) GROUP BY factor`,
      [
        s.budget_version_id,
        s.actual_version_id ?? s.forecast_version_id,
        monthDate(s.period.from),
        monthDate(s.period.to),
        s.destination_country_ids ?? null,
      ],
    ),
    costByVersion(pool, s, s.budget_version_id, s.destination_country_ids),
    costByVersion(
      pool,
      s,
      s.actual_version_id ?? s.forecast_version_id ?? "",
      s.destination_country_ids,
    ),
  ]);
  const factors = ["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"].map((factor, i) => ({
    factor_id: factor,
    label_zh: { VOLUME: "量", MIX: "结构", EFFICIENCY: "效率", PRICE: "价", FX: "汇率" }[factor],
    amount: money(rows.rows.find((row) => row.factor === factor)?.amount ?? "0"),
    sequence: i + 1,
  }));
  const total = factors.reduce(
    (sum, factor) => sum.plus(factor.amount.high_precision),
    new LogiPlanDecimal(0),
  );
  const baseline = new LogiPlanDecimal(baselineCost.variable);
  const current = new LogiPlanDecimal(currentCost.variable);
  return {
    payload: {
      baseline: money(baseline),
      factors,
      current: money(current),
      reconciliation_delta: money(current.minus(baseline).minus(total)),
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
      ...factors.map((factor) =>
        evidence(
          `ATTRIBUTION_BRIDGE:${factor.factor_id}`,
          intent,
          `${factor.label_zh}因素`,
          factor.amount.high_precision,
          "CHAIN_SUBSTITUTION 活动归因事实",
          { filters: { factor_id: [factor.factor_id] } },
        ),
      ),
    ],
    warnings: [],
  };
}

const factorIds = ["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"] as const;
const factorMap = (rows: Array<{ factor: string; amount: string }>) =>
  Object.fromEntries(
    factorIds.map((factor) => [
      factor,
      money(
        rows
          .filter((row) => row.factor === factor)
          .reduce((sum, row) => sum.plus(row.amount), new LogiPlanDecimal(0)),
      ),
    ]),
  ) as Record<(typeof factorIds)[number], MoneyValue>;
const zhCost: Record<string, string> = {
  BASE_FREIGHT: "基础运费",
  FUEL_SURCHARGE: "燃油附加费",
  BILLABLE_EXCEPTION: "计费异常",
  FRONTLINE_VARIABLE_LABOR: "一线弹性人工",
  PACKAGING: "包装材料",
  RETURN_LOGISTICS: "退货物流",
};

type DrilldownCostRow = {
  scenario_version_id: string;
  fulfillment_center_id: string;
  transport_mode_id: string;
  carrier_id: string;
  cost_category: string;
  amount: string;
};

type DrilldownFactorRow = {
  fulfillment_center_id: string;
  transport_mode_id: string;
  carrier_id: string;
  cost_category: string;
  factor: string;
  amount: string;
};

type DrilldownPayloadRow = {
  row_id: string;
  parent_row_id: string | null;
  level: "FULFILLMENT_CENTER" | "TRANSPORT_MODE" | "CARRIER" | "COST_COMPONENT";
  dimension_id: string;
  label_zh: string;
  baseline_cost: MoneyValue;
  current_cost: MoneyValue;
  variance: MoneyValue;
  variance_rate: DecimalValue | null;
  adverse_contribution_share: DecimalValue | null;
  saving_contribution_share: DecimalValue | null;
  factor_contributions: Record<(typeof factorIds)[number], MoneyValue>;
  children_available: boolean;
  evidence_ids: string[];
};

const drilldownLabels = {
  fulfillmentCenter: { DE_FC: "德国仓", FR_FC: "法国仓" } as Record<string, string>,
  transportMode: { AIR: "空运", ROAD: "公路" } as Record<string, string>,
  carrier: {
    CARRIER_A: "Carrier A",
    CARRIER_B: "Carrier B",
    CARRIER_C: "Carrier C",
  } as Record<string, string>,
};

async function drilldown(pool: QueryDatabase, intent: QueryIntent, requestId: string) {
  const s = intent.scope;
  const countryIds = s.destination_country_ids ?? ["GB"];
  // D-015/D-091/D-167: reconcile against the same unrounded model facts as
  // attribution. Per-row report_cny_amount is already quantized to four places;
  // report/display values are generated by money() only after aggregation.
  const costsResult = await pool.query(
    `SELECT u.scenario_version_id, r.fulfillment_center_id, r.transport_mode_id,
            r.carrier_id, c.cost_category, SUM(c.model_cny_amount)::text AS amount
     FROM logiplan.active_scenario_cost_component_fact c
     JOIN logiplan.active_fulfillment_scenario_fact u
       USING (data_release_id, fulfillment_fact_id)
     JOIN logiplan.active_scenario_version v
       USING (data_release_id, scenario_version_id)
     JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
     WHERE u.scenario_version_id = ANY($1::text[])
       AND u.month_id BETWEEN $2::date AND $3::date
       AND r.destination_country_id = ANY($4::text[])
     GROUP BY u.scenario_version_id, r.fulfillment_center_id, r.transport_mode_id,
              r.carrier_id, c.cost_category`,
    [
      [s.budget_version_id, s.actual_version_id ?? ""],
      monthDate(s.period.from),
      monthDate(s.period.to),
      countryIds,
    ],
  );
  const factorsResult = await pool.query(
    `SELECT r.fulfillment_center_id, r.transport_mode_id, r.carrier_id,
            f.cost_category, f.factor, SUM(f.attribution_cny)::text AS amount
     FROM logiplan.active_variance_attribution_fact f
     JOIN logiplan.active_variance_comparison c USING (data_release_id, comparison_id)
     JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
     WHERE c.budget_version_id=$1
       AND c.comparison_scenario_version_id=$2
       AND f.attribution_method='CHAIN_SUBSTITUTION'
       AND f.month_id BETWEEN $3::date AND $4::date
       AND r.destination_country_id=ANY($5::text[])
     GROUP BY r.fulfillment_center_id, r.transport_mode_id, r.carrier_id,
              f.cost_category, f.factor`,
    [
      s.budget_version_id,
      s.actual_version_id ?? s.forecast_version_id,
      monthDate(s.period.from),
      monthDate(s.period.to),
      countryIds,
    ],
  );
  const costs = costsResult.rows as DrilldownCostRow[];
  const factors = factorsResult.rows as DrilldownFactorRow[];
  const rows: DrilldownPayloadRow[] = [];

  const matches = (
    row: {
      fulfillment_center_id: string;
      transport_mode_id: string;
      carrier_id: string;
      cost_category: string;
    },
    center: string,
    mode?: string,
    carrier?: string,
    category?: string,
  ) =>
    row.fulfillment_center_id === center &&
    (mode === undefined || row.transport_mode_id === mode) &&
    (carrier === undefined || row.carrier_id === carrier) &&
    (category === undefined || row.cost_category === category);

  const appendRow = (
    level: DrilldownPayloadRow["level"],
    dimensionId: string,
    label: string,
    rowId: string,
    parentRowId: string | null,
    center: string,
    mode?: string,
    carrier?: string,
    category?: string,
  ) => {
    const matchingCosts = costs.filter((row) => matches(row, center, mode, carrier, category));
    const baseline = matchingCosts
      .filter((row) => row.scenario_version_id === s.budget_version_id)
      .reduce((sum, row) => sum.plus(row.amount), new LogiPlanDecimal(0));
    const current = matchingCosts
      .filter((row) => row.scenario_version_id === s.actual_version_id)
      .reduce((sum, row) => sum.plus(row.amount), new LogiPlanDecimal(0));
    const matchingFactors = factors
      .filter((row) => matches(row, center, mode, carrier, category))
      .map((row) => ({ factor: row.factor, amount: row.amount }));
    const evidenceId = `ATTRIBUTION_DRILLDOWN:${rowId}`;
    const factorContributions = factorMap(matchingFactors);
    const evidenceIds = [
      evidenceId,
      `${evidenceId}:BASELINE`,
      `${evidenceId}:CURRENT`,
      ...factorIds.map((factor) => `${evidenceId}:FACTOR:${factor}`),
    ];
    rows.push({
      row_id: rowId,
      parent_row_id: parentRowId,
      level,
      dimension_id: dimensionId,
      label_zh: label,
      baseline_cost: money(baseline),
      current_cost: money(current),
      variance: money(current.minus(baseline)),
      variance_rate: varianceRate(current, baseline),
      adverse_contribution_share: null,
      saving_contribution_share: null,
      factor_contributions: factorContributions,
      children_available: level !== "COST_COMPONENT",
      evidence_ids: evidenceIds,
    });
  };

  const centers = [...new Set(costs.map((row) => row.fulfillment_center_id))].sort();
  for (const center of centers) {
    const centerId = `FC:${center}`;
    appendRow(
      "FULFILLMENT_CENTER",
      center,
      drilldownLabels.fulfillmentCenter[center] ?? center,
      centerId,
      null,
      center,
    );
    const modes = [
      ...new Set(
        costs
          .filter((row) => row.fulfillment_center_id === center)
          .map((row) => row.transport_mode_id),
      ),
    ].sort();
    for (const mode of modes) {
      const modeId = `${centerId}/MODE:${mode}`;
      appendRow(
        "TRANSPORT_MODE",
        mode,
        drilldownLabels.transportMode[mode] ?? mode,
        modeId,
        centerId,
        center,
        mode,
      );
      const carriers = [
        ...new Set(
          costs
            .filter((row) => row.fulfillment_center_id === center && row.transport_mode_id === mode)
            .map((row) => row.carrier_id),
        ),
      ].sort();
      for (const carrier of carriers) {
        const carrierId = `${modeId}/CARRIER:${carrier}`;
        appendRow(
          "CARRIER",
          carrier,
          drilldownLabels.carrier[carrier] ?? carrier,
          carrierId,
          modeId,
          center,
          mode,
          carrier,
        );
        const categories = [
          ...new Set(
            costs
              .filter(
                (row) =>
                  row.fulfillment_center_id === center &&
                  row.transport_mode_id === mode &&
                  row.carrier_id === carrier,
              )
              .map((row) => row.cost_category),
          ),
        ].sort();
        for (const category of categories) {
          appendRow(
            "COST_COMPONENT",
            category,
            zhCost[category] ?? category,
            `${carrierId}/COST:${category}`,
            carrierId,
            center,
            mode,
            carrier,
            category,
          );
        }
      }
    }
  }

  const siblingGroups = new Map<string | null, DrilldownPayloadRow[]>();
  for (const row of rows) {
    const siblings = siblingGroups.get(row.parent_row_id) ?? [];
    siblings.push(row);
    siblingGroups.set(row.parent_row_id, siblings);
  }
  const sumMoney = (children: DrilldownPayloadRow[], value: (row: DrilldownPayloadRow) => string) =>
    children.reduce((sum, row) => sum.plus(value(row)), new LogiPlanDecimal(0));
  const assertReconciled = (
    parent: DrilldownPayloadRow,
    children: DrilldownPayloadRow[],
    label: string,
    parentValue: string,
    childValue: (row: DrilldownPayloadRow) => string,
  ) => {
    if (!sumMoney(children, childValue).equals(parentValue)) {
      throw error(
        "RECONCILIATION_FAILED",
        `${parent.row_id} 的直接子行${label}未与父行勾稽`,
        requestId,
      );
    }
  };
  for (const parent of rows.filter((row) => row.children_available)) {
    const children = siblingGroups.get(parent.row_id) ?? [];
    if (children.length === 0) {
      throw error("RECONCILIATION_FAILED", `${parent.row_id} 缺少直接子行`, requestId);
    }
    assertReconciled(
      parent,
      children,
      "Budget",
      parent.baseline_cost.high_precision,
      (row) => row.baseline_cost.high_precision,
    );
    assertReconciled(
      parent,
      children,
      "Actual",
      parent.current_cost.high_precision,
      (row) => row.current_cost.high_precision,
    );
    assertReconciled(
      parent,
      children,
      "总差异",
      parent.variance.high_precision,
      (row) => row.variance.high_precision,
    );
    for (const factor of factorIds) {
      assertReconciled(
        parent,
        children,
        `${factor}因素贡献`,
        parent.factor_contributions[factor].high_precision,
        (row) => row.factor_contributions[factor].high_precision,
      );
    }
  }
  for (const siblings of siblingGroups.values()) {
    const adverseTotal = siblings
      .filter((row) => new LogiPlanDecimal(row.variance.high_precision).isPositive())
      .reduce((sum, row) => sum.plus(row.variance.high_precision), new LogiPlanDecimal(0));
    const savingTotal = siblings
      .filter((row) => new LogiPlanDecimal(row.variance.high_precision).isNegative())
      .reduce(
        (sum, row) => sum.plus(new LogiPlanDecimal(row.variance.high_precision).abs()),
        new LogiPlanDecimal(0),
      );
    for (const row of siblings) {
      const variance = new LogiPlanDecimal(row.variance.high_precision);
      row.adverse_contribution_share =
        variance.isPositive() && !adverseTotal.isZero() ? ratio(variance.div(adverseTotal)) : null;
      row.saving_contribution_share =
        variance.isNegative() && !savingTotal.isZero()
          ? ratio(variance.abs().div(savingTotal))
          : null;
    }
  }

  const rootRows = siblingGroups.get(null) ?? [];
  const rootVariance = sumMoney(rootRows, (row) => row.variance.high_precision);
  const rootFactorTotal = factorIds.reduce(
    (total, factor) =>
      total.plus(sumMoney(rootRows, (row) => row.factor_contributions[factor].high_precision)),
    new LogiPlanDecimal(0),
  );
  if (!rootVariance.equals(rootFactorTotal)) {
    throw error("RECONCILIATION_FAILED", "下钻顶层总差异未与五因素贡献合计勾稽", requestId);
  }
  // Each leaf is the SQL cost key: center × mode × carrier × category.
  // A reconciled root cannot rule out opposite errors in two different keys.
  for (const row of rows.filter((row) => row.level === "COST_COMPONENT")) {
    const factorTotal = factorIds.reduce(
      (total, factor) => total.plus(row.factor_contributions[factor].high_precision),
      new LogiPlanDecimal("0"),
    );
    if (!factorTotal.equals(row.variance.high_precision)) {
      throw error(
        "RECONCILIATION_FAILED",
        `${row.row_id} 的模型成本差异未与五因素贡献合计勾稽`,
        requestId,
      );
    }
  }

  return {
    payload: { rows, primary_contribution: s.factor_id ?? "VARIANCE", method: "CHAIN" as const },
    evidence: rows.flatMap((row) => {
      const common = {
        filters: { destination_country_id: countryIds, row_id: [row.row_id] },
        group_by: [row.level],
        source_refs: [
          "logiplan.active_scenario_cost_component_fact",
          "logiplan.active_variance_attribution_fact",
          "logiplan.active_fulfillment_route",
        ],
      };
      const baseId = `ATTRIBUTION_DRILLDOWN:${row.row_id}`;
      return [
        evidence(
          baseId,
          intent,
          `${row.label_zh}总差异`,
          row.variance.high_precision,
          "Actual model_cny_amount − Budget model_cny_amount；逐层高精度勾稽",
          common,
        ),
        evidence(
          `${baseId}:BASELINE`,
          intent,
          `${row.label_zh} Budget 履约变动成本`,
          row.baseline_cost.high_precision,
          "Budget model_cny_amount 逐层汇总",
          common,
        ),
        evidence(
          `${baseId}:CURRENT`,
          intent,
          `${row.label_zh} Actual 履约变动成本`,
          row.current_cost.high_precision,
          "Actual model_cny_amount 逐层高精度汇总；汇总后生成报告值",
          common,
        ),
        ...factorIds.map((factor) =>
          evidence(
            `${baseId}:FACTOR:${factor}`,
            intent,
            `${row.label_zh} ${factor}因素贡献`,
            row.factor_contributions[factor].high_precision,
            "CHAIN_SUBSTITUTION 归因事实；与原始成本和总差异使用相同范围",
            {
              ...common,
              filters: { ...common.filters, factor_id: [factor] },
            },
          ),
        ),
      ];
    }),
    warnings: [],
  };
}
async function warehouseContext(pool: QueryDatabase, intent: QueryIntent) {
  const s = intent.scope;
  const rows = await pool.query(
    `SELECT u.scenario_version_id, r.fulfillment_center_id, SUM(${variableAmountSql})::text AS amount
    FROM logiplan.active_scenario_cost_component_fact c JOIN logiplan.active_fulfillment_scenario_fact u USING (data_release_id, fulfillment_fact_id) JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
    JOIN logiplan.active_scenario_version v USING (data_release_id, scenario_version_id)
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
async function evidenceLookup(pool: QueryDatabase, intent: QueryIntent, requestId: string) {
  if (!("contract_version" in intent) || !intent.evidence_id) {
    throw error("EVIDENCE_NOT_FOUND", "V1.1 证据查询缺少 evidence_id", requestId);
  }
  const id = intent.evidence_id;
  const sourceIntent = (
    question_type: QueryIntent["question_type"],
    scope: AnalysisScope,
    metrics: string[],
    group_by: QueryIntent["group_by"],
  ): QueryIntent => ({
    contract_version: "V1.1",
    question_type,
    scope,
    metrics,
    group_by,
    output_locale: intent.output_locale,
    context_sources: intent.context_sources,
  });
  type EvidenceQueryOutput = { evidence: EvidenceObject[]; warnings: ResultWarning[] };
  type EvidenceSource = { scope: AnalysisScope; execute: () => Promise<EvidenceQueryOutput> };
  let source: EvidenceSource | null = null;

  if (id === "E04-total") {
    source = {
      scope: evidenceDashboardRangeScope,
      execute: () =>
        dashboard(
          pool,
          sourceIntent("DASHBOARD_OVERVIEW", evidenceDashboardRangeScope, ["COST"], []),
        ),
    };
  } else if (id.startsWith("MONTHLY_COST_TREND:")) {
    source = {
      scope: evidenceDashboardMonthScope,
      execute: () =>
        monthlyCostTrend(
          pool,
          sourceIntent(
            "MONTHLY_COST_TREND",
            evidenceDashboardMonthScope,
            ["LOGISTICS_TOTAL_COST"],
            ["MONTH"],
          ),
          requestId,
        ),
    };
  } else if (id.startsWith("TOP_ADVERSE_ANOMALIES:")) {
    source = {
      scope: evidenceDashboardMonthScope,
      execute: () =>
        topAdverseAnomalies(
          pool,
          {
            ...sourceIntent(
              "TOP_ADVERSE_ANOMALIES",
              evidenceDashboardMonthScope,
              ["FULFILLMENT_VARIABLE_COST"],
              ["MONTH", "DESTINATION_COUNTRY"],
            ),
            top_n: 5,
          },
          requestId,
        ),
    };
  } else if (id.startsWith("FIXED_COST_BREAKDOWN:")) {
    source = {
      scope: evidenceDashboardRangeScope,
      execute: () =>
        fixedCostBreakdown(
          pool,
          sourceIntent(
            "FIXED_COST_BREAKDOWN",
            evidenceDashboardRangeScope,
            ["LOGISTICS_FIXED_COST"],
            ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"],
          ),
          requestId,
        ),
    };
  } else if (id.startsWith("E08-")) {
    source = {
      scope: evidenceWarehouseScope,
      execute: () =>
        warehouseContext(
          pool,
          sourceIntent(
            "WAREHOUSE_VARIANCE_CONTEXT",
            evidenceWarehouseScope,
            ["FULFILLMENT_VARIABLE_COST"],
            ["FULFILLMENT_CENTER"],
          ),
        ),
    };
  } else if (id === "E01-country") {
    source = {
      scope: evidenceAttributionScope,
      execute: () =>
        country(
          pool,
          sourceIntent(
            "COUNTRY_VARIANCE_SUMMARY",
            evidenceAttributionScope,
            ["FULFILLMENT_VARIABLE_COST"],
            [],
          ),
        ),
    };
  } else if (id === "E05-bridge" || id.startsWith("ATTRIBUTION_BRIDGE:")) {
    source = {
      scope: evidenceAttributionScope,
      execute: () =>
        bridge(
          pool,
          sourceIntent(
            "ATTRIBUTION_BRIDGE",
            evidenceAttributionScope,
            ["FULFILLMENT_VARIABLE_COST"],
            [],
          ),
        ),
    };
  } else if (id.startsWith("DIAGNOSTIC_METRICS:")) {
    source = {
      scope: evidenceAttributionScope,
      execute: () =>
        runDiagnosticMetrics(
          // This existing module uses query only; preserve its public signature.
          pool as Pool,
          sourceIntent(
            "DIAGNOSTIC_METRICS",
            evidenceAttributionScope,
            ["ORDERS", "AIR_SHARE", "CARRIER_C_SHARE", "ON_TIME_RATE", "SERVICE_MATURITY"],
            [],
          ),
          requestId,
        ),
    };
  } else if (id.startsWith("ATTRIBUTION_DRILLDOWN:")) {
    // Validate the frozen business range while preserving the source query's
    // optional factor. The metric named by an evidence ID is independent of it.
    const scope: AnalysisScope = {
      ...evidenceAttributionScope,
      ...(intent.scope.factor_id ? { factor_id: intent.scope.factor_id } : {}),
    };
    source = {
      scope,
      execute: () =>
        drilldown(
          pool,
          sourceIntent(
            "ATTRIBUTION_DRILLDOWN",
            scope,
            ["FULFILLMENT_VARIABLE_COST"],
            ["FULFILLMENT_CENTER", "TRANSPORT_MODE", "CARRIER", "COST_COMPONENT"],
          ),
          requestId,
        ),
    };
  }
  if (source === null) {
    throw error("EVIDENCE_NOT_FOUND", `未找到精确匹配的证据：${id}`, requestId);
  }
  if (canonicalScope(intent.scope) !== canonicalScope(source.scope)) {
    throw error("INVALID_FILTER", "evidence_id 与请求范围不匹配，拒绝返回其他范围证据", requestId);
  }
  const out = await source.execute();
  const found = out.evidence.find((item) => item.evidence_id === id);
  if (!found) {
    throw error("EVIDENCE_NOT_FOUND", `未找到精确匹配的证据：${id}`, requestId);
  }
  return { payload: { evidence: found }, evidence: [found], warnings: out.warnings };
}

async function executeQuery(
  pool: QueryDatabase,
  rawIntent: unknown,
  request_id: string,
): Promise<DeterministicResult | QueryServiceError> {
  const parsed = queryIntentSchema.safeParse(rawIntent);
  if (!parsed.success)
    return error("INVALID_FILTER", "查询意图不符合 V1.0/V1.1 严格契约", request_id);
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
                  ? await runDiagnosticMetrics(pool as Pool, intent, request_id)
                  : intent.question_type === "ATTRIBUTION_BRIDGE"
                    ? await bridge(pool, intent)
                    : intent.question_type === "ATTRIBUTION_DRILLDOWN"
                      ? await drilldown(pool, intent, request_id)
                      : intent.question_type === "EVIDENCE_LOOKUP"
                        ? await evidenceLookup(pool, intent, request_id)
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
      contract_version: contractVersion(intent),
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
    if (cause && typeof cause === "object" && "error_id" in cause && "request_id" in cause)
      return cause as QueryServiceError;
    throw cause;
  }
}

export async function runDeterministicQuery(
  pool: Pool,
  rawIntent: unknown,
  request_id: string,
): Promise<DeterministicResult | QueryServiceError> {
  const parsed = queryIntentSchema.safeParse(rawIntent);
  if (!parsed.success)
    return error("INVALID_FILTER", "查询意图不符合 V1.0/V1.1 严格契约", request_id);
  const intent = parsed.data;
  const validation = validateIntent(intent, request_id);
  if (validation) return validation;
  if (!("contract_version" in intent)) return executeQuery(pool, intent, request_id);
  if (intent.question_type === "EVIDENCE_LOOKUP" && intent.evidence_snapshot_id) {
    return lookupEvidenceSnapshot(pool, intent, request_id);
  }
  const client = await pool.connect();
  let commitStarted = false;
  let discardClient: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    // Establish the snapshot before any concurrent release activation.
    const release = await client.query("SELECT data_release_id FROM logiplan.active_release");
    if (release.rowCount !== 1) {
      await client.query("ROLLBACK");
      return error("VERSION_NOT_FOUND", "活动正式版本数量不是 1", request_id);
    }
    const result = await executeQuery(client, intent, request_id);
    if ("code" in result) {
      await client.query("ROLLBACK");
      return result;
    }
    const saved = await persistQueryEvidenceSnapshot(
      client,
      result,
      release.rows[0]?.data_release_id,
    );
    // A successful response is only available once its snapshot is committed.
    commitStarted = true;
    await client.query("COMMIT");
    return saved;
  } catch (cause) {
    // A lost COMMIT acknowledgement has an unknown outcome. Attempt cleanup,
    // discard the connection, and propagate failure without claiming rollback.
    if (commitStarted) discardClient = new Error("Snapshot COMMIT outcome is unconfirmed");
    await client.query("ROLLBACK").catch(() => {
      discardClient = new Error("Snapshot transaction cleanup failed");
    });
    throw cause;
  } finally {
    client.release(discardClient);
  }
}

export async function materializeEvidenceSnapshots(
  client: Pick<Client, "query">,
  intents: readonly QueryIntent[],
  requestPrefix = "publish-materialization",
): Promise<void> {
  const isolation = await client.query("SHOW transaction_isolation");
  if (String(isolation.rows[0]?.transaction_isolation) !== "repeatable read") {
    throw new Error("证据快照物化必须在 REPEATABLE READ 事务内执行");
  }
  const release = await client.query(
    `SELECT a.data_release_id
     FROM logiplan.active_data_release AS a
     JOIN logiplan.data_release AS r USING (data_release_id)
     WHERE a.singleton AND r.status = 'ACTIVE'`,
  );
  if (release.rowCount !== 1) throw new Error("物化证据快照时活动发布数量不是 1");
  const releaseId = String(release.rows[0].data_release_id);
  for (const intent of intents) {
    if (!("contract_version" in intent) || intent.question_type === "EVIDENCE_LOOKUP") {
      throw new Error("发布物化入口只接受 V1.1 确定性查询");
    }
    const result = await executeQuery(client, intent, `${requestPrefix}:${resultId(intent)}`);
    if ("code" in result) throw new Error(result.message_zh);
    await persistEvidenceSnapshot(client, result, releaseId);
  }
}

export async function checkReadiness(
  pool: QueryDatabase,
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
