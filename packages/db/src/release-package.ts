import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { LogiPlanDecimal } from "@logiplan/domain";
import { z } from "zod";

const decimalText = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const monthText = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const dateText = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u);
const sha256Text = z.string().regex(/^[0-9a-f]{64}$/u);

export const gate1ScenarioTypeSchema = z.enum(["BUDGET", "ACTUAL", "FORECAST"]);
export const costCategorySchema = z.enum([
  "BASE_FREIGHT",
  "FUEL_SURCHARGE",
  "BILLABLE_EXCEPTION",
  "FRONTLINE_VARIABLE_LABOR",
  "PACKAGING",
  "RETURN_LOGISTICS",
]);
export const factorSchema = z.enum(["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"]);
const comparisonSchema = z.enum([
  "ACTUAL_VS_BUDGET",
  "FORECAST_VS_BUDGET",
  "SCENARIO_GROWTH_VS_FORECAST",
  "SCENARIO_COST_SAVING_VS_FORECAST",
]);

const metadataSchema = z
  .object({
    dataset_id: z.string().min(1),
    generated_on: dateText,
    reporting_currency: z.literal("CNY"),
    latest_closed_month: monthText,
    budget_version_id: z.string().min(1),
    actual_version_id: z.string().min(1),
    forecast_version_id: z.string().min(1),
    data_classification: z.literal("SYNTHETIC_DEMO_DATA"),
    fact_grain: z.string().min(1),
    attribution_sequence: z.tuple([
      z.literal("VOLUME"),
      z.literal("MIX"),
      z.literal("EFFICIENCY"),
      z.literal("PRICE"),
      z.literal("FX"),
    ]),
    shapley_coalition_count: z.literal(32),
    cost_model_revision: z.string().min(1),
    source_workbook: z.string().min(1),
    source_workbook_sha256: sha256Text,
    source_workbook_role: z.literal("AUDIT_SOURCE_OF_TRUTH"),
  })
  .strict();

const dimensionsSchema = z
  .object({
    countries: z.array(z.object({ id: z.string().min(1), name_zh: z.string().min(1) }).strict()),
    fulfillment_centers: z.array(
      z
        .object({
          id: z.string().min(1),
          name_zh: z.string().min(1),
          timezone: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    carriers: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()),
    transport_modes: z.array(
      z
        .object({
          id: z.enum(["AIR", "ROAD"]),
          name_zh: z.string().min(1),
        })
        .strict(),
    ),
    routes: z.array(
      z
        .object({
          route_id: z.string().min(1),
          destination_country_id: z.string().min(1),
          fulfillment_center_id: z.string().min(1),
          carrier_id: z.string().min(1),
          transport_mode_id: z.enum(["AIR", "ROAD"]),
          active_from: dateText,
          active_to: dateText.nullable(),
          capacity_status: z.literal("NOT_VALIDATED_MVP"),
        })
        .strict(),
    ),
  })
  .strict();

const versionSchema = z
  .object({
    version_id: z.string().min(1),
    type: z.enum(["BUDGET", "ACTUAL", "FORECAST", "SCENARIO"]),
    status: z.enum(["PUBLISHED_FROZEN", "SESSION_TEMPLATE"]),
    coverage: z.string().regex(/^\d{4}-\d{2}\.\.\d{4}-\d{2}$/u),
  })
  .strict();

const driverFactSchema = z
  .object({
    version_id: z.string().min(1),
    data_type: z.enum(["BUDGET", "ACTUAL", "FORECAST", "SCENARIO"]),
    scenario_id: z.string().nullable(),
    month_id: monthText,
    route_id: z.string().min(1),
    destination_country_id: z.string().min(1),
    fulfillment_center_id: z.string().min(1),
    carrier_id: z.string().min(1),
    transport_mode_id: z.enum(["AIR", "ROAD"]),
    total_company_orders: decimalText,
    destination_order_share: decimalText,
    warehouse_order_share: decimalText,
    route_package_share: decimalText,
    equivalent_orders: decimalText,
    average_packages_per_order: decimalText,
    package_count: decimalText,
    average_chargeable_weight_per_package_kg: decimalText,
    chargeable_weight_kg: decimalText,
    return_rate: decimalText,
    return_package_count: decimalText,
    billable_events_per_package: decimalText,
    billable_event_count: decimalText,
    transport_currency: z.string().length(3),
    effective_base_rate_per_kg: decimalText,
    fuel_charge_basis: z.enum(["PERCENTAGE_OF_BASE_FREIGHT", "PER_CHARGEABLE_KG", "PER_PACKAGE"]),
    fuel_rate_or_unit_price: decimalText,
    frontline_variable_labor_currency: z.string().length(3),
    frontline_variable_labor_unit_price: decimalText,
    packaging_currency: z.string().length(3),
    packaging_unit_price: decimalText,
    return_currency: z.string().length(3),
    return_unit_price: decimalText,
    exception_currency: z.string().length(3),
    exception_unit_price: decimalText,
    eur_cny_rate: decimalText,
    gbp_cny_rate: decimalText,
    event_note: z.string().nullable(),
    management_action_note: z.string().nullable(),
    scenario_note: z.string().nullable(),
    capacity_assumption: z.literal("UNVERIFIED_UNLIMITED_FOR_MVP"),
  })
  .strict();

const costFactSchema = z
  .object({
    version_id: z.string().min(1),
    data_type: z.enum(["BUDGET", "ACTUAL", "FORECAST", "SCENARIO"]),
    scenario_id: z.string().nullable(),
    month_id: monthText,
    route_id: z.string().min(1),
    destination_country_id: z.string().min(1),
    fulfillment_center_id: z.string().min(1),
    carrier_id: z.string().min(1),
    transport_mode_id: z.enum(["AIR", "ROAD"]),
    cost_component_id: costCategorySchema,
    currency: z.string().length(3),
    original_amount: decimalText,
    fx_rate: decimalText,
    model_cost_cny_high_precision: decimalText,
    model_cost_cny_report: decimalText,
    authority_cost_cny_report: decimalText.nullable(),
    authority_model_delta_cny: decimalText.nullable(),
    posting_basis: z.enum(["INVOICE_OR_PLAN", "ACCRUAL"]),
  })
  .strict();

const fixedCostFactSchema = z
  .object({
    version_id: z.string().min(1),
    data_type: z.enum(["BUDGET", "ACTUAL", "FORECAST", "SCENARIO"]),
    scenario_id: z.string().nullable(),
    month_id: monthText,
    scope_id: z.string().min(1),
    fixed_cost_category_id: z.enum([
      "WAREHOUSE_RENT",
      "FRONTLINE_BASE_LABOR",
      "WAREHOUSE_MANAGEMENT_LABOR",
      "SYSTEM_COST",
    ]),
    currency: z.string().length(3),
    original_amount: decimalText,
    fx_rate: decimalText,
    cost_cny_high_precision: decimalText,
    cost_cny_report: decimalText,
  })
  .strict();

const serviceFactSchema = z
  .object({
    version_id: z.string().min(1),
    data_type: z.enum(["BUDGET", "ACTUAL", "FORECAST", "SCENARIO"]),
    scenario_id: z.string().nullable(),
    month_id: monthText,
    route_id: z.string().min(1),
    destination_country_id: z.string().min(1),
    fulfillment_center_id: z.string().min(1),
    carrier_id: z.string().min(1),
    transport_mode_id: z.enum(["AIR", "ROAD"]),
    cohort_package_count: decimalText,
    due_package_count: decimalText.nullable(),
    on_time_package_count: decimalText.nullable(),
    on_time_rate: decimalText,
    service_maturity_rate: decimalText.nullable(),
  })
  .strict();

const gmvFactSchema = z
  .object({
    version_id: z.string().min(1),
    data_type: z.enum(["BUDGET", "ACTUAL", "FORECAST", "SCENARIO"]),
    scenario_id: z.string().nullable(),
    month_id: monthText,
    destination_country_id: z.string().min(1),
    currency: z.string().length(3),
    original_amount: decimalText,
    fx_rate: decimalText,
    gmv_cny_high_precision: decimalText,
    gmv_cny_report: decimalText,
  })
  .strict();

const monthlySummarySchema = z
  .object({
    series_id: z.string().min(1),
    month_id: monthText,
    orders: decimalText,
    packages: decimalText,
    chargeable_weight_kg: decimalText,
    variable_cost_cny_high_precision: decimalText,
    variable_cost_cny_report: decimalText,
    fixed_cost_cny_high_precision: decimalText,
    fixed_cost_cny_report: decimalText,
    total_cost_cny_high_precision: decimalText,
    total_cost_cny_report: decimalText,
    gmv_cny_high_precision: decimalText,
    gmv_cny_report: decimalText,
    company_total_logistics_cost_rate: decimalText,
    unit_variable_cost_per_order_cny: decimalText,
    transport_cost_per_kg_cny: decimalText,
    on_time_rate: decimalText,
    service_maturity_rate: decimalText.nullable(),
  })
  .strict();

const countrySummarySchema = z
  .object({
    series_id: z.string().min(1),
    month_id: monthText,
    destination_country_id: z.string().min(1),
    orders: decimalText,
    packages: decimalText,
    variable_cost_cny_high_precision: decimalText,
    variable_cost_cny_report: decimalText,
    gmv_cny_high_precision: decimalText,
    gmv_cny_report: decimalText,
    destination_variable_cost_rate: decimalText,
    air_package_share: decimalText,
    carrier_c_package_share: decimalText,
    on_time_rate: decimalText,
    service_maturity_rate: decimalText.nullable(),
  })
  .strict();

const attributionDetailSchema = z
  .object({
    comparison_id: comparisonSchema,
    month_id: monthText,
    method_id: z.enum(["CHAIN", "SHAPLEY"]),
    factor_id: factorSchema,
    route_id: z.string().min(1),
    destination_country_id: z.string().min(1),
    fulfillment_center_id: z.string().min(1),
    carrier_id: z.string().min(1),
    transport_mode_id: z.enum(["AIR", "ROAD"]),
    cost_component_id: costCategorySchema,
    amount_cny_high_precision: decimalText,
    amount_cny_report: decimalText,
  })
  .strict();

const attributionSummarySchema = z
  .object({
    comparison_id: comparisonSchema,
    month_id: monthText,
    method_id: z.enum(["CHAIN", "SHAPLEY"]),
    factor_id: factorSchema,
    amount_cny_high_precision: decimalText,
    amount_cny_report: decimalText,
    shapley_difference_cny: decimalText.optional(),
    normalized_order_sensitivity: decimalText.optional(),
    is_order_sensitive: z.boolean().optional(),
  })
  .strict();

const attributionCountrySummarySchema = z
  .object({
    comparison_id: comparisonSchema,
    month_id: monthText,
    method_id: z.enum(["CHAIN", "SHAPLEY"]),
    factor_id: factorSchema,
    destination_country_id: z.string().min(1),
    amount_cny_high_precision: decimalText,
    amount_cny_report: decimalText,
  })
  .strict();

const attributionReconciliationSchema = z
  .object({
    comparison_id: comparisonSchema,
    month_id: monthText,
    expected_variable_cost_difference_cny: decimalText,
    chain_total_cny: decimalText,
    chain_delta_cny: decimalText,
    shapley_total_cny: decimalText,
    shapley_delta_cny: decimalText,
  })
  .strict();

export const releasePackageSchema = z
  .object({
    metadata: metadataSchema,
    dimensions: dimensionsSchema,
    versions: z.array(versionSchema),
    driver_facts: z.array(driverFactSchema),
    cost_facts: z.array(costFactSchema),
    fixed_cost_facts: z.array(fixedCostFactSchema),
    service_facts: z.array(serviceFactSchema),
    gmv_facts: z.array(gmvFactSchema),
    monthly_summary: z.array(monthlySummarySchema),
    country_summary: z.array(countrySummarySchema),
    attribution_detail: z.array(attributionDetailSchema),
    attribution_summary: z.array(attributionSummarySchema),
    attribution_country_summary: z.array(attributionCountrySummarySchema),
    attribution_reconciliation: z.array(attributionReconciliationSchema),
  })
  .strict();

const expectedRowCountsSchema = z
  .object({
    routes: z.number().int().nonnegative(),
    driver_facts: z.number().int().nonnegative(),
    cost_facts: z.number().int().nonnegative(),
    fixed_cost_facts: z.number().int().nonnegative(),
    service_facts: z.number().int().nonnegative(),
    gmv_facts: z.number().int().nonnegative(),
    attribution_detail: z.number().int().nonnegative(),
    attribution_summary: z.number().int().nonnegative(),
    attribution_country_summary: z.number().int().nonnegative(),
    attribution_reconciliation: z.number().int().nonnegative(),
  })
  .strict();

export const releaseManifestSchema = z
  .object({
    release_version: z.string().min(1),
    data_file: z.string().min(1),
    data_sha256: sha256Text,
    generator_file: z.string().min(1),
    generator_sha256: sha256Text,
    database_schema_version: z.string().regex(/^\d{4}$/u),
    calculation_version: z.string().min(1),
    source_description: z.string().min(1),
    expected_row_counts: expectedRowCountsSchema,
  })
  .strict();

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type ReleasePackage = z.infer<typeof releasePackageSchema>;
export type DriverFact = z.infer<typeof driverFactSchema>;
export type CostFact = z.infer<typeof costFactSchema>;
export type FixedCostFact = z.infer<typeof fixedCostFactSchema>;
export type ServiceFact = z.infer<typeof serviceFactSchema>;
export type GmvFact = z.infer<typeof gmvFactSchema>;
export type AttributionDetail = z.infer<typeof attributionDetailSchema>;
export type AttributionSummary = z.infer<typeof attributionSummarySchema>;

export interface LoadedReleaseBundle {
  readonly manifest: ReleaseManifest;
  readonly package: ReleasePackage;
  readonly manifestPath: string;
  readonly dataPath: string;
  readonly dataSha256: string;
  readonly generatorSha256: string;
}

export interface PackageValidationSummary {
  readonly dataset_id: string;
  readonly full_package_rows: Readonly<Record<string, number>>;
  readonly gate1_rows: Readonly<Record<string, number>>;
  readonly checks: readonly string[];
  readonly order_level_available: false;
}

export const gate1ScenarioTypes = new Set(["BUDGET", "ACTUAL", "FORECAST"] as const);
export const gate1ComparisonIds = new Set(["ACTUAL_VS_BUDGET", "FORECAST_VS_BUDGET"] as const);

export function isGate1ScenarioType(
  value: string,
): value is z.infer<typeof gate1ScenarioTypeSchema> {
  return gate1ScenarioTypeSchema.safeParse(value).success;
}

export function isGate1Comparison(
  value: string,
): value is "ACTUAL_VS_BUDGET" | "FORECAST_VS_BUDGET" {
  return value === "ACTUAL_VS_BUDGET" || value === "FORECAST_VS_BUDGET";
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertUnique<T>(items: readonly T[], keyOf: (item: T) => string, label: string): void {
  const keys = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    assert(!keys.has(key), `${label}存在重复键：${key}`);
    keys.add(key);
  }
}

function assertExactProduct(left: string, right: string, expected: string, label: string): void {
  const actual = new LogiPlanDecimal(left).times(right);
  assert(actual.equals(expected), `${label}高精度乘积不一致`);
}

function assertReportValue(value: string, report: string, label: string): void {
  const expected = new LogiPlanDecimal(value).toDecimalPlaces(4).toFixed(4);
  assert(expected === report, `${label}四位报告值不一致：${report} != ${expected}`);
}

export async function loadReleaseBundle(manifestPath: string): Promise<LoadedReleaseBundle> {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifestBuffer = await readFile(resolvedManifestPath);
  const manifest = releaseManifestSchema.parse(JSON.parse(manifestBuffer.toString("utf8")));
  const manifestDirectory = path.dirname(resolvedManifestPath);
  const dataPath = path.resolve(manifestDirectory, manifest.data_file);
  const generatorPath = path.resolve(manifestDirectory, manifest.generator_file);
  const [dataBuffer, generatorBuffer] = await Promise.all([
    readFile(dataPath),
    readFile(generatorPath),
  ]);
  const dataSha256 = sha256(dataBuffer);
  const generatorSha256 = sha256(generatorBuffer);
  assert(dataSha256 === manifest.data_sha256, "数据包 SHA-256 与发布清单不一致");
  assert(generatorSha256 === manifest.generator_sha256, "生成规则 SHA-256 与发布清单不一致");
  const releasePackage = releasePackageSchema.parse(JSON.parse(dataBuffer.toString("utf8")));

  return {
    manifest,
    package: releasePackage,
    manifestPath: resolvedManifestPath,
    dataPath,
    dataSha256,
    generatorSha256,
  };
}

export function validateReleasePackage(bundle: LoadedReleaseBundle): PackageValidationSummary {
  const data = bundle.package;
  const expected = bundle.manifest.expected_row_counts;
  const fullRows = {
    routes: data.dimensions.routes.length,
    driver_facts: data.driver_facts.length,
    cost_facts: data.cost_facts.length,
    fixed_cost_facts: data.fixed_cost_facts.length,
    service_facts: data.service_facts.length,
    gmv_facts: data.gmv_facts.length,
    attribution_detail: data.attribution_detail.length,
    attribution_summary: data.attribution_summary.length,
    attribution_country_summary: data.attribution_country_summary.length,
    attribution_reconciliation: data.attribution_reconciliation.length,
  } as const;

  for (const [name, count] of Object.entries(fullRows)) {
    const expectedCount = expected[name as keyof typeof expected];
    assert(count === expectedCount, `${name} 行数不一致：${count} != ${expectedCount}`);
  }

  assert(data.metadata.dataset_id === bundle.manifest.release_version, "数据集与发布版本不一致");
  assert(
    data.metadata.cost_model_revision === bundle.manifest.calculation_version,
    "计算版本与发布清单不一致",
  );
  assert(
    data.metadata.fact_grain ===
      "month x destination_country x fulfillment_center x carrier x transport_mode",
    "事实粒度与冻结口径不一致",
  );

  assertUnique(data.dimensions.countries, (row) => row.id, "目的国维度");
  assertUnique(data.dimensions.fulfillment_centers, (row) => row.id, "发货仓维度");
  assertUnique(data.dimensions.carriers, (row) => row.id, "承运商维度");
  assertUnique(data.dimensions.transport_modes, (row) => row.id, "运输方式维度");
  assertUnique(data.dimensions.routes, (row) => row.route_id, "履约线路维度");

  const countries = new Set(data.dimensions.countries.map((row) => row.id));
  const centers = new Set(data.dimensions.fulfillment_centers.map((row) => row.id));
  const carriers = new Set(data.dimensions.carriers.map((row) => row.id));
  const modes = new Set(data.dimensions.transport_modes.map((row) => row.id));
  for (const route of data.dimensions.routes) {
    assert(countries.has(route.destination_country_id), `线路目的国不存在：${route.route_id}`);
    assert(centers.has(route.fulfillment_center_id), `线路发货仓不存在：${route.route_id}`);
    assert(carriers.has(route.carrier_id), `线路承运商不存在：${route.route_id}`);
    assert(modes.has(route.transport_mode_id), `线路运输方式不存在：${route.route_id}`);
  }

  const versions = new Map(data.versions.map((row) => [row.version_id, row]));
  for (const versionId of [
    data.metadata.budget_version_id,
    data.metadata.actual_version_id,
    data.metadata.forecast_version_id,
  ]) {
    assert(versions.has(versionId), `Gate 1 版本不存在：${versionId}`);
  }

  const drivers = data.driver_facts.filter((row) => isGate1ScenarioType(row.data_type));
  const costs = data.cost_facts.filter((row) => isGate1ScenarioType(row.data_type));
  const fixedCosts = data.fixed_cost_facts.filter((row) => isGate1ScenarioType(row.data_type));
  const services = data.service_facts.filter((row) => isGate1ScenarioType(row.data_type));
  const gmv = data.gmv_facts.filter((row) => isGate1ScenarioType(row.data_type));
  const attribution = data.attribution_detail.filter((row) => isGate1Comparison(row.comparison_id));
  const attributionSummary = data.attribution_summary.filter((row) =>
    isGate1Comparison(row.comparison_id),
  );

  const driverKey = (row: { version_id: string; month_id: string; route_id: string }): string =>
    `${row.version_id}|${row.month_id}|${row.route_id}`;
  assertUnique(drivers, driverKey, "Gate 1 驱动事实");
  assertUnique(services, driverKey, "Gate 1 服务事实");
  const driverKeys = new Set(drivers.map(driverKey));
  const serviceKeys = new Set(services.map(driverKey));
  assert(driverKeys.size === serviceKeys.size, "驱动事实与服务事实数量不一致");
  for (const key of driverKeys) {
    assert(serviceKeys.has(key), `服务事实缺失：${key}`);
  }

  assertUnique(costs, (row) => `${driverKey(row)}|${row.cost_component_id}`, "Gate 1 成本事实");
  assert(
    costs.length === drivers.length * costCategorySchema.options.length,
    "每条驱动事实必须对应六类成本",
  );
  for (const row of costs) {
    assert(driverKeys.has(driverKey(row)), `成本事实缺少驱动事实：${driverKey(row)}`);
    assertExactProduct(
      row.original_amount,
      row.fx_rate,
      row.model_cost_cny_high_precision,
      `成本事实 ${driverKey(row)}|${row.cost_component_id}`,
    );
    assertReportValue(
      row.model_cost_cny_high_precision,
      row.model_cost_cny_report,
      `成本事实 ${driverKey(row)}|${row.cost_component_id}`,
    );
  }

  assertUnique(
    fixedCosts,
    (row) => `${row.version_id}|${row.month_id}|${row.scope_id}|${row.fixed_cost_category_id}`,
    "Gate 1 固定成本事实",
  );
  for (const row of fixedCosts) {
    assertExactProduct(
      row.original_amount,
      row.fx_rate,
      row.cost_cny_high_precision,
      `固定成本 ${row.version_id}|${row.month_id}|${row.scope_id}`,
    );
    assertReportValue(
      row.cost_cny_high_precision,
      row.cost_cny_report,
      `固定成本 ${row.version_id}|${row.month_id}|${row.scope_id}`,
    );
  }

  assertUnique(
    gmv,
    (row) => `${row.version_id}|${row.month_id}|${row.destination_country_id}`,
    "Gate 1 GMV 事实",
  );
  for (const row of gmv) {
    assertExactProduct(
      row.original_amount,
      row.fx_rate,
      row.gmv_cny_high_precision,
      `GMV ${row.version_id}|${row.month_id}|${row.destination_country_id}`,
    );
    assertReportValue(
      row.gmv_cny_high_precision,
      row.gmv_cny_report,
      `GMV ${row.version_id}|${row.month_id}|${row.destination_country_id}`,
    );
  }

  assertUnique(
    attribution,
    (row) =>
      `${row.comparison_id}|${row.month_id}|${row.method_id}|${row.factor_id}|${row.route_id}|${row.cost_component_id}`,
    "Gate 1 归因事实",
  );
  for (const row of attribution) {
    assertReportValue(
      row.amount_cny_high_precision,
      row.amount_cny_report,
      `归因事实 ${row.comparison_id}|${row.month_id}|${row.method_id}|${row.factor_id}`,
    );
  }

  const tolerance = new LogiPlanDecimal("1e-50");
  for (const row of data.attribution_reconciliation.filter((item) =>
    isGate1Comparison(item.comparison_id),
  )) {
    assert(
      new LogiPlanDecimal(row.chain_delta_cny).abs().lte(tolerance),
      `连环替代归因未勾稽：${row.comparison_id}|${row.month_id}`,
    );
    assert(
      new LogiPlanDecimal(row.shapley_delta_cny).abs().lte(tolerance),
      `Shapley 归因未勾稽：${row.comparison_id}|${row.month_id}`,
    );
  }

  return {
    dataset_id: data.metadata.dataset_id,
    full_package_rows: fullRows,
    gate1_rows: {
      scenario_versions: 3,
      fulfillment_facts: drivers.length,
      cost_component_facts: costs.length,
      fixed_cost_facts: fixedCosts.length,
      gmv_facts: gmv.length,
      attribution_facts: attribution.length,
      attribution_summary_rows: attributionSummary.length,
    },
    checks: [
      "manifest_checksums",
      "strict_schema",
      "row_counts",
      "dimension_references",
      "unique_business_keys",
      "cost_fx_recalculation",
      "four_place_reporting",
      "chain_and_shapley_reconciliation",
      "gate1_scope_boundary",
    ],
    order_level_available: false,
  };
}
