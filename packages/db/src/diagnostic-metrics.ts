import type { Pool } from "pg";
import {
  type DecimalValue,
  type EvidenceObject,
  type QueryIntent,
  type ResultWarning,
} from "@logiplan/contracts";
import { LogiPlanDecimal } from "@logiplan/domain";

import { evidence } from "./query-result";

type PreciseDecimal = InstanceType<typeof LogiPlanDecimal>;

type DiagnosticError = {
  error_id: string;
  code: "INVALID_FILTER" | "VERSION_NOT_FOUND" | "RECONCILIATION_FAILED";
  message_zh: string;
  request_id: string;
};

const error = (
  code: DiagnosticError["code"],
  message_zh: string,
  request_id: string,
): DiagnosticError => ({ error_id: `ERR-${request_id}`, code, message_zh, request_id });

const percentage = (n: PreciseDecimal): DecimalValue => {
  const percent = n.times(100);
  return {
    high_precision: percent.toFixed(),
    report: percent.toFixed(4),
    display: percent.toFixed(2),
    unit: "PERCENT",
  };
};
const percentagePointChange = (current: PreciseDecimal, baseline: PreciseDecimal): DecimalValue => {
  const highPrecision = current.minus(baseline).times(100);
  return {
    high_precision: highPrecision.toFixed(),
    report: highPrecision.toFixed(4),
    display: highPrecision.toFixed(2),
    unit: "PERCENTAGE_POINT",
  };
};
type QuantityValue = {
  high_precision: string;
  report: string;
  display: string;
  unit: "COUNT";
};
const quantity = (n: PreciseDecimal): QuantityValue => ({
  high_precision: n.toFixed(),
  report: n.toFixed(4),
  display: n.toFixed(2),
  unit: "COUNT",
});
const monthDate = (m: string) => `${m}-01`;
const monthText = (value: unknown) =>
  value instanceof Date ? value.toISOString().slice(0, 7) : String(value).slice(0, 7);
type DiagnosticMetricRow = {
  scenario_version_id: string;
  scenario_type: string;
  latest_closed_month: unknown | null;
  expected_route_count: number;
  route_count: number;
  order_qty: string | null;
  order_source_model: string | null;
  package_qty: string | null;
  air_package_qty: string | null;
  carrier_c_package_qty: string | null;
  due_package_qty: string | null;
  on_time_delivered_package_qty: string | null;
  missing_service_count: number;
};

const diagnosticNumber = (
  value: string | null,
  label: string,
  requestId: string,
): PreciseDecimal => {
  if (value === null) {
    throw error("RECONCILIATION_FAILED", `诊断指标缺少${label}`, requestId);
  }
  try {
    return new LogiPlanDecimal(value);
  } catch {
    throw error("RECONCILIATION_FAILED", `诊断指标${label}不是有效十进制`, requestId);
  }
};

export async function runDiagnosticMetrics(pool: Pool, intent: QueryIntent, requestId: string) {
  const scope = intent.scope;
  const destinationCountryId = scope.destination_country_ids?.[0];
  const actualVersionId = scope.actual_version_id;
  if (destinationCountryId === undefined || actualVersionId === undefined) {
    throw error("INVALID_FILTER", "诊断指标缺少目的国或 Actual 版本", requestId);
  }
  const result = await pool.query(
    `/* DIAGNOSTIC_METRICS */
     WITH selected_versions AS (
       SELECT scenario_version_id, scenario_type, latest_closed_month
       FROM logiplan.active_scenario_version
       WHERE scenario_version_id=ANY($1::text[]) AND calculation_version=$2
     ),
     expected_routes AS (
       SELECT COUNT(*)::int AS expected_route_count
       FROM logiplan.active_fulfillment_route
       WHERE destination_country_id=$4
         AND status='ACTIVE'
         AND valid_from <= $3::date
         AND (valid_to IS NULL OR valid_to >= $3::date)
     ),
     country_orders AS (
       SELECT scenario_version_id, scenario_type, order_qty::text,
              source_model AS order_source_model
       FROM logiplan.active_country_order_fact
       WHERE scenario_version_id=ANY($1::text[])
         AND month_id=$3::date
         AND destination_country_id=$4
     ),
     facts AS (
       SELECT u.scenario_version_id,
              COUNT(DISTINCT u.route_id)::int AS route_count,
              SUM(u.package_qty)::text AS package_qty,
              COALESCE(SUM(u.package_qty) FILTER (WHERE r.transport_mode_id='AIR'),0)::text
                AS air_package_qty,
              COALESCE(SUM(u.package_qty) FILTER (WHERE r.carrier_id='CARRIER_C'),0)::text
                AS carrier_c_package_qty,
              SUM(u.package_qty * u.service_maturity_rate)::text AS due_package_qty,
              SUM(u.package_qty * u.service_maturity_rate * u.on_time_rate)::text
                AS on_time_delivered_package_qty,
              COUNT(*) FILTER (
                WHERE u.on_time_rate IS NULL OR u.service_maturity_rate IS NULL
              )::int AS missing_service_count
       FROM logiplan.active_fulfillment_scenario_fact u
       JOIN logiplan.active_fulfillment_route r USING (data_release_id, route_id)
       WHERE u.scenario_version_id=ANY($1::text[])
         AND u.calculation_version=$2
         AND u.month_id=$3::date
         AND r.destination_country_id=$4
         AND r.status='ACTIVE'
         AND r.valid_from <= $3::date
         AND (r.valid_to IS NULL OR r.valid_to >= $3::date)
       GROUP BY u.scenario_version_id
     )
     SELECT s.scenario_version_id, s.scenario_type,
            s.latest_closed_month::text AS latest_closed_month,
            e.expected_route_count, COALESCE(f.route_count,0)::int AS route_count,
            o.order_qty, o.order_source_model,
            f.package_qty, f.air_package_qty, f.carrier_c_package_qty,
            f.due_package_qty, f.on_time_delivered_package_qty,
            COALESCE(f.missing_service_count,0)::int AS missing_service_count
     FROM selected_versions s
     CROSS JOIN expected_routes e
     LEFT JOIN country_orders o
       ON o.scenario_version_id = s.scenario_version_id
      AND o.scenario_type = s.scenario_type
     LEFT JOIN facts f ON f.scenario_version_id = s.scenario_version_id
     ORDER BY s.scenario_type`,
    [
      [scope.budget_version_id, actualVersionId],
      scope.calculation_version,
      monthDate(scope.period.from),
      destinationCountryId,
    ],
  );
  const rows = result.rows as DiagnosticMetricRow[];
  const expectedVersions = [
    [scope.budget_version_id, "BUDGET"],
    [actualVersionId, "ACTUAL"],
  ] as const;
  for (const [versionId, scenarioType] of expectedVersions) {
    const matches = rows.filter((row) => row.scenario_version_id === versionId);
    if (matches.length !== 1 || matches[0]?.scenario_type !== scenarioType) {
      throw error(
        "VERSION_NOT_FOUND",
        `${scenarioType} 版本不存在、类型错误或计算版本不匹配`,
        requestId,
      );
    }
  }
  if (rows.length !== expectedVersions.length) {
    throw error("VERSION_NOT_FOUND", "诊断指标版本解析结果不唯一", requestId);
  }
  const baselineRow = rows.find((row) => row.scenario_version_id === scope.budget_version_id)!;
  const currentRow = rows.find((row) => row.scenario_version_id === actualVersionId)!;
  if (monthText(currentRow.latest_closed_month) !== scope.period.from) {
    throw error("VERSION_NOT_FOUND", "Actual 版本结账月份与诊断期间不一致", requestId);
  }
  const expectedRouteCount = Number(currentRow.expected_route_count);
  if (
    expectedRouteCount < 1 ||
    Number(baselineRow.expected_route_count) !== expectedRouteCount ||
    Number(baselineRow.route_count) !== expectedRouteCount ||
    Number(currentRow.route_count) !== expectedRouteCount
  ) {
    throw error(
      "RECONCILIATION_FAILED",
      "诊断指标的 Budget 或 Actual 未覆盖目的国活动履约线路全集",
      requestId,
    );
  }
  if (
    Number(baselineRow.missing_service_count) !== 0 ||
    Number(currentRow.missing_service_count) !== 0
  ) {
    throw error("RECONCILIATION_FAILED", "诊断指标存在缺失的服务率或成熟度事实", requestId);
  }
  if (
    baselineRow.order_source_model !== "budget_country_month" ||
    currentRow.order_source_model !== "actual_country_warehouse_fulfillment"
  ) {
    throw error("RECONCILIATION_FAILED", "诊断指标缺少受控活动目的国真实订单事实", requestId);
  }

  const values = (row: DiagnosticMetricRow, seriesLabel: string) => {
    const orders = diagnosticNumber(row.order_qty, `${seriesLabel}订单量`, requestId);
    const packages = diagnosticNumber(row.package_qty, `${seriesLabel}包裹量`, requestId);
    const airPackages = diagnosticNumber(
      row.air_package_qty,
      `${seriesLabel}空运包裹量`,
      requestId,
    );
    const carrierCPackages = diagnosticNumber(
      row.carrier_c_package_qty,
      `${seriesLabel} Carrier C 包裹量`,
      requestId,
    );
    const duePackages = diagnosticNumber(
      row.due_package_qty,
      `${seriesLabel}已到承诺截止日期包裹量`,
      requestId,
    );
    const onTimePackages = diagnosticNumber(
      row.on_time_delivered_package_qty,
      `${seriesLabel}准时妥投包裹量`,
      requestId,
    );
    if (
      orders.lte(0) ||
      packages.lte(0) ||
      duePackages.lte(0) ||
      airPackages.isNegative() ||
      carrierCPackages.isNegative() ||
      onTimePackages.isNegative() ||
      airPackages.greaterThan(packages) ||
      carrierCPackages.greaterThan(packages) ||
      duePackages.greaterThan(packages) ||
      onTimePackages.greaterThan(duePackages)
    ) {
      throw error(
        "RECONCILIATION_FAILED",
        `诊断指标的${seriesLabel}数量、结构或服务分子分母无法勾稽`,
        requestId,
      );
    }
    return {
      orders,
      airShare: airPackages.div(packages),
      carrierCShare: carrierCPackages.div(packages),
      onTimeRate: onTimePackages.div(duePackages),
      maturityRate: duePackages.div(packages),
    };
  };
  const baseline = values(baselineRow, "Budget");
  const current = values(currentRow, "Actual");

  const orderDelta = current.orders.minus(baseline.orders);
  const orderDeltaRate = orderDelta.div(baseline.orders);
  const airShareDelta = percentagePointChange(current.airShare, baseline.airShare);
  const carrierCShareDelta = percentagePointChange(current.carrierCShare, baseline.carrierCShare);
  const onTimeRateDelta = percentagePointChange(current.onTimeRate, baseline.onTimeRate);
  const maturityIsFinal = current.maturityRate.equals(1);
  const evidenceIds = {
    orders: [
      "DIAGNOSTIC_METRICS:ORDERS:BASELINE",
      "DIAGNOSTIC_METRICS:ORDERS:CURRENT",
      "DIAGNOSTIC_METRICS:ORDERS:DELTA",
      "DIAGNOSTIC_METRICS:ORDERS:DELTA_RATE",
    ],
    airShare: [
      "DIAGNOSTIC_METRICS:AIR_SHARE:BASELINE",
      "DIAGNOSTIC_METRICS:AIR_SHARE:CURRENT",
      "DIAGNOSTIC_METRICS:AIR_SHARE:DELTA",
    ],
    carrierCShare: [
      "DIAGNOSTIC_METRICS:CARRIER_C_SHARE:BASELINE",
      "DIAGNOSTIC_METRICS:CARRIER_C_SHARE:CURRENT",
      "DIAGNOSTIC_METRICS:CARRIER_C_SHARE:DELTA",
    ],
    onTimeRate: [
      "DIAGNOSTIC_METRICS:ON_TIME_RATE:BASELINE",
      "DIAGNOSTIC_METRICS:ON_TIME_RATE:CURRENT",
      "DIAGNOSTIC_METRICS:ON_TIME_RATE:DELTA",
    ],
    maturity: ["DIAGNOSTIC_METRICS:SERVICE_MATURITY:CURRENT"],
  } as const;
  const diagnostics = [
    {
      diagnostic_id: "ORDERS" as const,
      label: "订单量",
      current: quantity(current.orders),
      baseline: quantity(baseline.orders),
      delta: quantity(orderDelta),
      delta_rate: percentage(orderDeltaRate),
      unit: "COUNT" as const,
      delta_label: "相对变化",
      evidence_ids: [...evidenceIds.orders],
    },
    {
      diagnostic_id: "AIR_SHARE" as const,
      label: "空运包裹占比",
      current: percentage(current.airShare),
      baseline: percentage(baseline.airShare),
      delta: airShareDelta,
      delta_rate: null,
      unit: "PERCENT" as const,
      delta_label: "百分点变化",
      evidence_ids: [...evidenceIds.airShare],
    },
    {
      diagnostic_id: "CARRIER_C_SHARE" as const,
      label: "Carrier C 包裹占比",
      current: percentage(current.carrierCShare),
      baseline: percentage(baseline.carrierCShare),
      delta: carrierCShareDelta,
      delta_rate: null,
      unit: "PERCENT" as const,
      delta_label: "百分点变化",
      evidence_ids: [...evidenceIds.carrierCShare],
    },
    {
      diagnostic_id: "ON_TIME_RATE" as const,
      label: "准时履约率",
      current: percentage(current.onTimeRate),
      baseline: percentage(baseline.onTimeRate),
      delta: onTimeRateDelta,
      delta_rate: null,
      unit: "PERCENT" as const,
      delta_label: "百分点变化",
      evidence_ids: [...evidenceIds.onTimeRate],
    },
    {
      diagnostic_id: "SERVICE_MATURITY" as const,
      label: "服务成熟度",
      current: percentage(current.maturityRate),
      baseline: null,
      delta: null,
      delta_rate: null,
      unit: "PERCENT" as const,
      delta_label: maturityIsFinal ? "结果已最终成熟" : "结果尚未最终成熟",
      evidence_ids: [...evidenceIds.maturity],
    },
  ];
  const evidenceOptions = {
    filters: { destination_country_id: [destinationCountryId] },
    group_by: [] as EvidenceObject["group_by"],
    source_refs: [
      "logiplan.active_country_order_fact",
      "logiplan.active_fulfillment_scenario_fact",
      "logiplan.active_fulfillment_route",
      "logiplan.active_scenario_version",
    ],
  };
  const numericEvidence = (
    evidenceId: string,
    metric: string,
    value: string,
    unit: string,
    calculationMethod: string,
  ) =>
    evidence(evidenceId, intent, metric, value, calculationMethod, {
      ...evidenceOptions,
      unit,
    });
  const resultEvidence = [
    numericEvidence(
      evidenceIds.orders[0],
      "英国 Budget 订单量",
      baseline.orders.toFixed(),
      "COUNT",
      "从活动 Budget 目的国订单事实读取真实订单量；发布时已与订单驱动和线路分摊勾稽",
    ),
    numericEvidence(
      evidenceIds.orders[1],
      "英国 Actual 订单量",
      current.orders.toFixed(),
      "COUNT",
      "从活动 Actual 目的国仓级履约事实汇总真实订单量；发布时已与订单驱动和线路分摊勾稽",
    ),
    numericEvidence(
      evidenceIds.orders[2],
      "英国订单量绝对变化",
      orderDelta.toFixed(),
      "COUNT",
      "Actual 订单量减 Budget 订单量",
    ),
    numericEvidence(
      evidenceIds.orders[3],
      "英国订单量相对变化",
      percentage(orderDeltaRate).high_precision,
      "PERCENT",
      "(Actual 订单量减 Budget 订单量)除以 Budget 订单量",
    ),
    numericEvidence(
      evidenceIds.airShare[0],
      "英国 Budget 空运包裹占比",
      percentage(baseline.airShare).high_precision,
      "PERCENT",
      "Budget 空运包裹量除以 Budget 全部包裹量",
    ),
    numericEvidence(
      evidenceIds.airShare[1],
      "英国 Actual 空运包裹占比",
      percentage(current.airShare).high_precision,
      "PERCENT",
      "Actual 空运包裹量除以 Actual 全部包裹量",
    ),
    numericEvidence(
      evidenceIds.airShare[2],
      "英国空运包裹占比百分点变化",
      airShareDelta.high_precision,
      "PERCENTAGE_POINT",
      "Actual 空运包裹占比减 Budget 空运包裹占比；高精度百分点差值直接舍入展示",
    ),
    numericEvidence(
      evidenceIds.carrierCShare[0],
      "英国 Budget Carrier C 包裹占比",
      percentage(baseline.carrierCShare).high_precision,
      "PERCENT",
      "Budget Carrier C 包裹量除以 Budget 全部包裹量",
    ),
    numericEvidence(
      evidenceIds.carrierCShare[1],
      "英国 Actual Carrier C 包裹占比",
      percentage(current.carrierCShare).high_precision,
      "PERCENT",
      "Actual Carrier C 包裹量除以 Actual 全部包裹量",
    ),
    numericEvidence(
      evidenceIds.carrierCShare[2],
      "英国 Carrier C 包裹占比百分点变化",
      carrierCShareDelta.high_precision,
      "PERCENTAGE_POINT",
      "Actual Carrier C 包裹占比减 Budget Carrier C 包裹占比",
    ),
    numericEvidence(
      evidenceIds.onTimeRate[0],
      "英国 Budget 准时履约率",
      percentage(baseline.onTimeRate).high_precision,
      "PERCENT",
      "Budget 准时包裹量除以已到承诺截止日期包裹量",
    ),
    numericEvidence(
      evidenceIds.onTimeRate[1],
      "英国 Actual 当前准时履约率",
      percentage(current.onTimeRate).high_precision,
      "PERCENT",
      "Actual 准时包裹量除以已到承诺截止日期包裹量；未到期在途包裹不进入分母",
    ),
    numericEvidence(
      evidenceIds.onTimeRate[2],
      "英国准时履约率百分点变化",
      onTimeRateDelta.high_precision,
      "PERCENTAGE_POINT",
      "Actual 当前准时履约率减 Budget 准时履约率",
    ),
    numericEvidence(
      evidenceIds.maturity[0],
      "英国 Actual 服务成熟度",
      percentage(current.maturityRate).high_precision,
      "PERCENT",
      "已到承诺截止日期包裹量除以当前发运 cohort 全部包裹量",
    ),
  ];
  const warnings: ResultWarning[] = [];
  if (!maturityIsFinal) {
    warnings.unshift({
      code: "SERVICE_NOT_MATURE",
      message:
        "服务成熟度未达到 100%，结果尚未最终成熟；未到承诺截止日期的在途包裹不进入准时履约率分母。",
    });
  }
  return {
    payload: {
      scope: {
        period: { ...scope.period },
        comparison: scope.comparison,
        destination_country_ids: [destinationCountryId],
        budget_version_id: scope.budget_version_id,
        actual_version_id: actualVersionId,
        calculation_version: scope.calculation_version,
      },
      diagnostics,
      service_evaluation: {
        maturity_status: maturityIsFinal ? ("FINAL" as const) : ("NOT_FINAL" as const),
        status_label_zh: maturityIsFinal ? "结果已最终成熟" : "结果尚未最终成熟",
        on_time_denominator_policy_zh:
          "准时履约率分母仅包含已到承诺截止日期的包裹；未到承诺截止日期的在途包裹不进入分母。",
        maturity_definition_zh:
          "服务成熟度是已到承诺截止日期包裹量占发运 cohort 全部包裹量的比例，不代表履约质量。",
      },
      interpretation_boundary_zh:
        "订单量、空运和 Carrier C 占比变化是已记录的确定性事实；相关性不等于因果，不得推断未记录的经营因果。",
    },
    evidence: resultEvidence,
    warnings,
  };
}
