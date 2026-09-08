import { analysisScopeSchema } from "@logiplan/contracts";
import type {
  AnalysisScope,
  AttributionFactor,
  DecimalValue,
  EvidenceObject,
  MoneyValue,
  QueryIntent,
  QueryIntentV11,
  ResultWarning,
} from "@logiplan/contracts";

export const VERSIONS = {
  budget: "BUDGET_2026_V1",
  actual: "ACTUAL_2026_08_CLOSE_V1",
  forecast: "FORECAST_2026_08_V1",
  calculation: "D-092",
} as const;

export const FACTORS = ["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"] as const;

export type DeterministicResult<T> = {
  contract_version: "V1.0" | "V1.1";
  result_id: string;
  query_intent: QueryIntent;
  scope_label: string;
  data_as_of: string;
  generated_at: string;
  reporting_currency: "CNY";
  precision: { calculation: "HIGH_PRECISION_DECIMAL"; report_places: 4; display_places: 2 };
  payload: T;
  evidence: EvidenceObject[];
  warnings: ResultWarning[];
};

export type DashboardPayload = {
  kpis: {
    budget: MoneyValue;
    latest_outlook: MoneyValue;
    variance: MoneyValue;
    variance_rate: DecimalValue | null;
    variable_cost_budget: MoneyValue;
    variable_cost_latest_outlook: MoneyValue;
    variable_cost_variance: MoneyValue;
    fixed_cost_latest_outlook: MoneyValue;
    fulfillment_cost_per_order_budget: MoneyValue | null;
    fulfillment_cost_per_order_latest_outlook: MoneyValue | null;
    transport_cost_per_kg_budget: MoneyValue | null;
    transport_cost_per_kg_latest_outlook: MoneyValue | null;
    logistics_total_cost_rate_budget: DecimalValue | null;
    logistics_total_cost_rate_latest_outlook: DecimalValue | null;
  };
  series: {
    budget: { variable_cost: MoneyValue; fixed_cost: MoneyValue };
    latest_outlook: { variable_cost: MoneyValue; fixed_cost: MoneyValue };
  };
};

export type TrendPayload = {
  months: Array<{
    month_id: string;
    series_type: "ACTUAL" | "FORECAST";
    baseline: { total_cost: MoneyValue; variable_cost: MoneyValue; fixed_cost: MoneyValue };
    current: { total_cost: MoneyValue; variable_cost: MoneyValue; fixed_cost: MoneyValue };
    variance: MoneyValue;
    variance_rate: DecimalValue | null;
    evidence_id: string;
  }>;
  closing_boundary: { latest_closed_month: string; first_forecast_month: string };
};

export type AnomalyPayload = {
  anomalies: Array<{
    rank: number;
    month_id: string;
    destination_country_id: string;
    series_type: "ACTUAL" | "FORECAST";
    baseline: MoneyValue;
    current: MoneyValue;
    variance: MoneyValue;
    variance_rate: DecimalValue | null;
    adverse_contribution_share: DecimalValue | null;
    evidence_id: string;
  }>;
};

export type FixedCostPayload = {
  total: {
    baseline: MoneyValue;
    current: MoneyValue;
    variance: MoneyValue;
    variance_rate: DecimalValue | null;
  };
  categories: Array<{
    fixed_cost_category: string;
    label_zh: string;
    baseline: MoneyValue;
    current: MoneyValue;
    variance: MoneyValue;
    variance_rate: DecimalValue | null;
    allocations: Array<{
      scope_id: string;
      baseline: MoneyValue;
      current: MoneyValue;
      variance: MoneyValue;
      variance_rate: DecimalValue | null;
    }>;
  }>;
};

export type WarehousePayload = {
  warehouses: Array<{
    fulfillment_center_id: string;
    baseline_cost: MoneyValue;
    current_cost: MoneyValue;
    variance: MoneyValue;
    evidence_id: string;
  }>;
  company_total: { baseline_cost: MoneyValue; current_cost: MoneyValue; variance: MoneyValue };
  scope: "COMPANY_VARIABLE_COST_ONLY";
};

export type CountryPayload = {
  destination_country_id: string;
  baseline: MoneyValue;
  current: MoneyValue;
  variance: MoneyValue;
};

export type BridgePayload = {
  baseline: MoneyValue;
  factors: Array<{
    factor_id: AttributionFactor;
    label_zh: string;
    amount: MoneyValue;
    sequence: number;
  }>;
  current: MoneyValue;
  reconciliation_delta: MoneyValue;
  method: "CHAIN";
};

export type DiagnosticValue = {
  high_precision: string;
  report: string;
  display: string;
  unit: "COUNT" | "PERCENT" | "PERCENTAGE_POINT" | "RATIO";
};

export type DiagnosticPayload = {
  diagnostics: Array<{
    diagnostic_id: "ORDERS" | "AIR_SHARE" | "CARRIER_C_SHARE" | "ON_TIME_RATE" | "SERVICE_MATURITY";
    label: string;
    current: DiagnosticValue;
    baseline: DiagnosticValue | null;
    delta: DiagnosticValue | null;
    delta_rate: DiagnosticValue | null;
    unit: "COUNT" | "PERCENT";
    evidence_ids: string[];
  }>;
  service_evaluation: {
    maturity_status: "FINAL" | "NOT_FINAL";
    status_label_zh: string;
    on_time_denominator_policy_zh: string;
    maturity_definition_zh: string;
  };
};

export type DrilldownRow = {
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
  factor_contributions: Record<AttributionFactor, MoneyValue>;
  children_available: boolean;
  evidence_ids: string[];
};

export type DrilldownPayload = {
  rows: DrilldownRow[];
  primary_contribution: AttributionFactor | "VARIANCE";
  method: "CHAIN";
};

const dashboardScope: AnalysisScope = {
  period: { from: "2026-01", to: "2026-12", grain: "RANGE" },
  comparison: "LATEST_OUTLOOK_VS_BUDGET",
  budget_version_id: VERSIONS.budget,
  actual_version_id: VERSIONS.actual,
  forecast_version_id: VERSIONS.forecast,
  calculation_version: VERSIONS.calculation,
};

const attributionScope = (factor?: AttributionFactor): AnalysisScope => ({
  period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
  comparison: "ACTUAL_VS_BUDGET",
  destination_country_ids: ["GB"],
  budget_version_id: VERSIONS.budget,
  actual_version_id: VERSIONS.actual,
  calculation_version: VERSIONS.calculation,
  ...(factor ? { factor_id: factor } : {}),
});

const intent = (
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

export const evidenceLookupIntent = (
  scope: AnalysisScope,
  evidence_id: string,
  evidence_snapshot_id?: string,
): QueryIntentV11 => ({
  contract_version: "V1.1",
  question_type: "EVIDENCE_LOOKUP",
  scope,
  metrics: [],
  group_by: [],
  output_locale: "zh-CN",
  context_sources: ["PAGE_VISIBLE_STATE", "FIXED_TEMPLATE"],
  evidence_id,
  ...(evidence_snapshot_id === undefined ? {} : { evidence_snapshot_id }),
});

// Evidence scope is distinct from the current page's selected factor/path.
export function evidenceIntentFromUrl(url: URL, id: string, fallback: AnalysisScope): QueryIntent {
  const encodedScope = url.searchParams.get("evidence_scope");
  const scope =
    encodedScope === null ? fallback : analysisScopeSchema.parse(JSON.parse(encodedScope));
  return evidenceLookupIntent(scope, id, url.searchParams.get("evidence_snapshot_id") ?? undefined);
}

export const EVIDENCE_ADDRESS_PARAMETERS = [
  "evidence_id",
  "evidence_snapshot_id",
  "evidence_scope",
] as const;

export function hasEvidenceAddress(params: Record<string, string | string[] | undefined>): boolean {
  return EVIDENCE_ADDRESS_PARAMETERS.some((key) => params[key] !== undefined);
}

export function currentAnalysisAddressFromParams(
  pathname: string,
  params: Record<string, string | string[] | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (EVIDENCE_ADDRESS_PARAMETERS.some((parameter) => parameter === key)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, item);
      }
    } else if (value !== undefined) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

export function historicalEvidenceIntentFromUrl(url: URL): QueryIntentV11 {
  const required = (key: (typeof EVIDENCE_ADDRESS_PARAMETERS)[number]) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0]?.trim() === "")
      throw new Error("证据链接不完整，请返回当前分析重新打开证据。");
    return values[0]!;
  };
  const evidenceId = required("evidence_id");
  const snapshotId = required("evidence_snapshot_id");
  const encodedScope = required("evidence_scope");
  let decodedScope: unknown;
  try {
    decodedScope = JSON.parse(encodedScope) as unknown;
  } catch {
    throw new Error("证据链接中的 evidence_scope 无效，请返回当前分析重新打开证据。");
  }
  const scope = analysisScopeSchema.safeParse(decodedScope);
  if (!scope.success)
    throw new Error("证据链接中的 evidence_scope 无效，请返回当前分析重新打开证据。");
  return evidenceLookupIntent(scope.data, evidenceId, snapshotId);
}

export function bindEvidenceAddress(url: URL, item: EvidenceObject, scope: AnalysisScope): void {
  url.searchParams.set("evidence_id", item.evidence_id);
  url.searchParams.set("evidence_scope", JSON.stringify(scope));
  if (item.evidence_snapshot_id)
    url.searchParams.set("evidence_snapshot_id", item.evidence_snapshot_id);
  else url.searchParams.delete("evidence_snapshot_id");
}

export function clearEvidenceAddress(url: URL): void {
  for (const key of EVIDENCE_ADDRESS_PARAMETERS) url.searchParams.delete(key);
}

export const dashboardIntents = {
  overview: intent("DASHBOARD_OVERVIEW", dashboardScope, ["COST"], []),
  trend: intent(
    "MONTHLY_COST_TREND",
    { ...dashboardScope, period: { ...dashboardScope.period, grain: "MONTH" } },
    ["LOGISTICS_TOTAL_COST"],
    ["MONTH"],
  ),
  anomalies: intent(
    "TOP_ADVERSE_ANOMALIES",
    { ...dashboardScope, period: { ...dashboardScope.period, grain: "MONTH" } },
    ["FULFILLMENT_VARIABLE_COST"],
    ["MONTH", "DESTINATION_COUNTRY"],
    5,
  ),
  fixed: intent(
    "FIXED_COST_BREAKDOWN",
    dashboardScope,
    ["LOGISTICS_FIXED_COST"],
    ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"],
  ),
  warehouses: intent(
    "WAREHOUSE_VARIANCE_CONTEXT",
    {
      period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
      comparison: "ACTUAL_VS_BUDGET",
      budget_version_id: VERSIONS.budget,
      actual_version_id: VERSIONS.actual,
      calculation_version: VERSIONS.calculation,
    },
    ["FULFILLMENT_VARIABLE_COST"],
    ["FULFILLMENT_CENTER"],
  ),
} as const;

export const attributionIntents = (factor?: AttributionFactor) => ({
  country: intent(
    "COUNTRY_VARIANCE_SUMMARY",
    attributionScope(),
    ["FULFILLMENT_VARIABLE_COST"],
    [],
  ),
  bridge: intent("ATTRIBUTION_BRIDGE", attributionScope(), ["FULFILLMENT_VARIABLE_COST"], []),
  diagnostics: intent(
    "DIAGNOSTIC_METRICS",
    attributionScope(),
    ["ORDERS", "AIR_SHARE", "CARRIER_C_SHARE", "ON_TIME_RATE", "SERVICE_MATURITY"],
    [],
  ),
  drilldown: intent(
    "ATTRIBUTION_DRILLDOWN",
    attributionScope(factor),
    ["FULFILLMENT_VARIABLE_COST"],
    ["FULFILLMENT_CENTER", "TRANSPORT_MODE", "CARRIER", "COST_COMPONENT"],
  ),
});

export type DashboardData = {
  overview: DeterministicResult<DashboardPayload>;
  trend: DeterministicResult<TrendPayload>;
  anomalies: DeterministicResult<AnomalyPayload>;
  fixed: DeterministicResult<FixedCostPayload>;
  warehouses: DeterministicResult<WarehousePayload>;
};

export type AttributionData = {
  country: DeterministicResult<CountryPayload>;
  bridge: DeterministicResult<BridgePayload>;
  diagnostics: DeterministicResult<DiagnosticPayload>;
  drilldown: DeterministicResult<DrilldownPayload>;
};
