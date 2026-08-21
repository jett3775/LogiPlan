import { createHash } from "node:crypto";

import { LogiPlanDecimal } from "@logiplan/domain";
import type { Client } from "pg";

import {
  type DriverFact,
  type LoadedReleaseBundle,
  type PackageValidationSummary,
  isGate1Comparison,
  isGate1ScenarioType,
} from "./release-package";

type SqlValue = string | boolean | null;
type SqlRow = readonly SqlValue[];

export type ReleaseStatus = "CANDIDATE" | "VALIDATED" | "ACTIVE" | "RETIRED" | "FAILED";

export interface CoreValidationSummary {
  readonly row_counts: Readonly<Record<string, number>>;
  readonly core_questions: Readonly<Record<string, Readonly<Record<string, string | boolean>>>>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function monthDate(month: string): string {
  return `${month}-01`;
}

function fxVersionId(versionId: string): string {
  return `FX:${versionId}`;
}

function priceVersionId(versionId: string): string {
  return `PRICE:${versionId}`;
}

function fxRateId(versionId: string, month: string, currency: string): string {
  return `FXR:${versionId}:${month}:${currency}`;
}

function fulfillmentFactId(versionId: string, month: string, routeId: string): string {
  return `FF:${versionId}:${month}:${routeId}`;
}

function transportPriceId(versionId: string, month: string, routeId: string): string {
  return `TP:${versionId}:${month}:${routeId}`;
}

function laborPriceId(versionId: string, month: string, centerId: string): string {
  return `LP:${versionId}:${month}:${centerId}`;
}

function packagingPriceId(versionId: string, month: string, centerId: string): string {
  return `PP:${versionId}:${month}:${centerId}`;
}

function returnPriceId(
  versionId: string,
  month: string,
  countryId: string,
  centerId: string,
): string {
  return `RP:${versionId}:${month}:${countryId}:${centerId}`;
}

function exceptionPriceId(versionId: string, month: string, routeId: string): string {
  return `EP:${versionId}:${month}:${routeId}`;
}

function costPriceId(row: {
  version_id: string;
  month_id: string;
  route_id: string;
  destination_country_id: string;
  fulfillment_center_id: string;
  cost_component_id: string;
}): string {
  switch (row.cost_component_id) {
    case "BASE_FREIGHT":
    case "FUEL_SURCHARGE":
      return transportPriceId(row.version_id, row.month_id, row.route_id);
    case "FRONTLINE_VARIABLE_LABOR":
      return laborPriceId(row.version_id, row.month_id, row.fulfillment_center_id);
    case "PACKAGING":
      return packagingPriceId(row.version_id, row.month_id, row.fulfillment_center_id);
    case "RETURN_LOGISTICS":
      return returnPriceId(
        row.version_id,
        row.month_id,
        row.destination_country_id,
        row.fulfillment_center_id,
      );
    case "BILLABLE_EXCEPTION":
      return exceptionPriceId(row.version_id, row.month_id, row.route_id);
    default:
      throw new Error(`未知成本类别：${row.cost_component_id}`);
  }
}

function stableShortId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function putUnique(map: Map<string, SqlRow>, key: string, row: SqlRow, label: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, row);
    return;
  }
  assert(JSON.stringify(existing) === JSON.stringify(row), `${label}同键取值不一致：${key}`);
}

async function bulkInsert(
  client: Client,
  table: string,
  columns: readonly string[],
  rows: readonly SqlRow[],
  batchSize = 250,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values: SqlValue[] = [];
    const tuples = batch.map((row) => {
      assert(row.length === columns.length, `${table} 插入列数不匹配`);
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await client.query(
      `INSERT INTO logiplan.${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
      values,
    );
  }
}

function gate1Drivers(bundle: LoadedReleaseBundle): readonly DriverFact[] {
  return bundle.package.driver_facts.filter((row) => isGate1ScenarioType(row.data_type));
}

function sourceLineage(bundle: LoadedReleaseBundle, source: string, businessKey: string): string {
  return JSON.stringify({
    dataset_id: bundle.package.metadata.dataset_id,
    data_sha256: bundle.dataSha256,
    source,
    business_key: businessKey,
  });
}

export async function assertDatabaseSchemaVersion(
  client: Client,
  expectedVersion: string,
): Promise<void> {
  const result = await client.query<{ version: string }>(
    "SELECT logiplan.current_schema_version() AS version",
  );
  assert(result.rows[0]?.version === expectedVersion, `数据库结构版本不是 ${expectedVersion}`);
}

export async function getReleaseStatus(
  client: Client,
  releaseId: string,
): Promise<ReleaseStatus | null> {
  const result = await client.query<{ status: ReleaseStatus }>(
    "SELECT status FROM logiplan.data_release WHERE data_release_id = $1",
    [releaseId],
  );
  return result.rows[0]?.status ?? null;
}

export async function insertReleaseData(
  client: Client,
  bundle: LoadedReleaseBundle,
): Promise<void> {
  const releaseId = bundle.manifest.release_version;
  const data = bundle.package;
  const drivers = gate1Drivers(bundle);
  const services = data.service_facts.filter((row) => isGate1ScenarioType(row.data_type));
  const serviceByKey = new Map(
    services.map((row) => [`${row.version_id}|${row.month_id}|${row.route_id}`, row]),
  );
  const supportedVersions = data.versions.filter((row) => isGate1ScenarioType(row.type));
  const versionById = new Map(supportedVersions.map((row) => [row.version_id, row]));

  await bulkInsert(
    client,
    "dim_destination_country",
    [
      "data_release_id",
      "destination_country_id",
      "destination_country_name_zh",
      "active_from",
      "active_to",
    ],
    data.dimensions.countries.map((row) => [releaseId, row.id, row.name_zh, "2026-01-01", null]),
  );

  await bulkInsert(
    client,
    "dim_fulfillment_center",
    [
      "data_release_id",
      "fulfillment_center_id",
      "fulfillment_center_name_zh",
      "location_country_id",
      "iana_timezone",
      "active_from",
      "active_to",
    ],
    data.dimensions.fulfillment_centers
      .filter((row) => row.id !== "SHARED")
      .map((row) => {
        assert(row.timezone !== null, `实际发货仓缺少时区：${row.id}`);
        const locationCountry = row.id.split("_")[0];
        assert(locationCountry !== undefined, `无法确定发货仓所在国：${row.id}`);
        return [releaseId, row.id, row.name_zh, locationCountry, row.timezone, "2026-01-01", null];
      }),
  );

  await bulkInsert(
    client,
    "dim_carrier",
    ["data_release_id", "carrier_id", "carrier_name", "demo_role_note", "is_demo_entity"],
    data.dimensions.carriers.map((row) => [
      releaseId,
      row.id,
      row.name,
      "仅用于合成演示数据，不代表真实供应商",
      true,
    ]),
  );

  await bulkInsert(
    client,
    "dim_transport_mode",
    ["data_release_id", "transport_mode_id", "transport_mode_name_zh"],
    data.dimensions.transport_modes.map((row) => [releaseId, row.id, row.name_zh]),
  );

  await bulkInsert(
    client,
    "fulfillment_route",
    [
      "data_release_id",
      "route_id",
      "destination_country_id",
      "fulfillment_center_id",
      "carrier_id",
      "transport_mode_id",
      "valid_from",
      "valid_to",
      "status",
    ],
    data.dimensions.routes.map((row) => [
      releaseId,
      row.route_id,
      row.destination_country_id,
      row.fulfillment_center_id,
      row.carrier_id,
      row.transport_mode_id,
      row.active_from,
      row.active_to,
      "ACTIVE",
    ]),
  );

  const generatedAt = `${data.metadata.generated_on}T00:00:00.000Z`;
  await bulkInsert(
    client,
    "fx_rate_version",
    ["data_release_id", "fx_version_id", "version_name", "status", "source_note", "published_at"],
    supportedVersions.map((row) => [
      releaseId,
      fxVersionId(row.version_id),
      `${row.version_id} 汇率版本`,
      "PUBLISHED",
      "由固定演示数据包直接提取",
      generatedAt,
    ]),
  );

  await bulkInsert(
    client,
    "price_version",
    [
      "data_release_id",
      "price_version_id",
      "version_name",
      "version_type",
      "status",
      "valid_from",
      "valid_to",
      "source_note",
      "published_at",
    ],
    supportedVersions.map((row) => {
      const [from, to] = row.coverage.split("..");
      assert(from !== undefined && to !== undefined, `版本覆盖期无效：${row.version_id}`);
      return [
        releaseId,
        priceVersionId(row.version_id),
        `${row.version_id} 价格版本`,
        row.type,
        "PUBLISHED",
        monthDate(from),
        monthDate(to),
        "由固定演示数据包直接提取；统一事实保留权威高精度金额",
        generatedAt,
      ];
    }),
  );

  const budgetVersion = versionById.get(data.metadata.budget_version_id);
  assert(budgetVersion?.type === "BUDGET", "Budget 版本定义不正确");
  const scenarioRows = supportedVersions.map((row): SqlRow => [
    releaseId,
    row.version_id,
    row.type,
    `${row.version_id} 冻结版本`,
    "PUBLISHED",
    row.type === "BUDGET" ? null : data.metadata.budget_version_id,
    priceVersionId(row.version_id),
    fxVersionId(row.version_id),
    row.type === "BUDGET" ? null : monthDate(data.metadata.latest_closed_month),
    generatedAt,
    `固定演示数据，覆盖 ${row.coverage}`,
    bundle.manifest.calculation_version,
  ]);
  await bulkInsert(
    client,
    "scenario_version",
    [
      "data_release_id",
      "scenario_version_id",
      "scenario_type",
      "version_name",
      "status",
      "base_budget_version_id",
      "price_version_id",
      "fx_version_id",
      "latest_closed_month",
      "published_at",
      "change_reason",
      "calculation_version",
    ],
    scenarioRows.filter((row) => row[2] === "BUDGET"),
  );
  await bulkInsert(
    client,
    "scenario_version",
    [
      "data_release_id",
      "scenario_version_id",
      "scenario_type",
      "version_name",
      "status",
      "base_budget_version_id",
      "price_version_id",
      "fx_version_id",
      "latest_closed_month",
      "published_at",
      "change_reason",
      "calculation_version",
    ],
    scenarioRows.filter((row) => row[2] !== "BUDGET"),
  );

  const fxRows = new Map<string, SqlRow>();
  const transportRows = new Map<string, SqlRow>();
  const laborRows = new Map<string, SqlRow>();
  const packagingRows = new Map<string, SqlRow>();
  const returnRows = new Map<string, SqlRow>();
  const exceptionRows = new Map<string, SqlRow>();
  for (const row of drivers) {
    for (const [currency, rate, rateType] of [
      [
        "CNY",
        "1",
        row.data_type === "BUDGET"
          ? "BUDGET_ANNUAL"
          : row.data_type === "ACTUAL"
            ? "ACTUAL_MONTHLY_AVERAGE"
            : "FORECAST_PLANNING",
      ],
      [
        "EUR",
        row.eur_cny_rate,
        row.data_type === "BUDGET"
          ? "BUDGET_ANNUAL"
          : row.data_type === "ACTUAL"
            ? "ACTUAL_MONTHLY_AVERAGE"
            : "FORECAST_PLANNING",
      ],
      [
        "GBP",
        row.gbp_cny_rate,
        row.data_type === "BUDGET"
          ? "BUDGET_ANNUAL"
          : row.data_type === "ACTUAL"
            ? "ACTUAL_MONTHLY_AVERAGE"
            : "FORECAST_PLANNING",
      ],
    ] as const) {
      const id = fxRateId(row.version_id, row.month_id, currency);
      putUnique(
        fxRows,
        id,
        [
          releaseId,
          id,
          fxVersionId(row.version_id),
          monthDate(row.month_id),
          currency,
          rate,
          rateType,
          "固定演示数据包汇率",
        ],
        "汇率",
      );
    }

    const transportId = transportPriceId(row.version_id, row.month_id, row.route_id);
    putUnique(
      transportRows,
      transportId,
      [
        releaseId,
        transportId,
        priceVersionId(row.version_id),
        monthDate(row.month_id),
        row.route_id,
        row.transport_currency,
        row.effective_base_rate_per_kg,
        row.fuel_charge_basis,
        row.fuel_rate_or_unit_price,
        "固定演示数据包价格；高精度计算结果以统一事实为准",
      ],
      "运输价格",
    );

    const laborId = laborPriceId(row.version_id, row.month_id, row.fulfillment_center_id);
    putUnique(
      laborRows,
      laborId,
      [
        releaseId,
        laborId,
        priceVersionId(row.version_id),
        monthDate(row.month_id),
        row.fulfillment_center_id,
        row.frontline_variable_labor_currency,
        row.frontline_variable_labor_unit_price,
        "固定演示数据包价格；高精度计算结果以统一事实为准",
      ],
      "一线变动人工价格",
    );

    const packagingId = packagingPriceId(row.version_id, row.month_id, row.fulfillment_center_id);
    putUnique(
      packagingRows,
      packagingId,
      [
        releaseId,
        packagingId,
        priceVersionId(row.version_id),
        monthDate(row.month_id),
        row.fulfillment_center_id,
        row.packaging_currency,
        row.packaging_unit_price,
        "固定演示数据包价格；高精度计算结果以统一事实为准",
      ],
      "包材价格",
    );

    const returnId = returnPriceId(
      row.version_id,
      row.month_id,
      row.destination_country_id,
      row.fulfillment_center_id,
    );
    putUnique(
      returnRows,
      returnId,
      [
        releaseId,
        returnId,
        priceVersionId(row.version_id),
        monthDate(row.month_id),
        row.destination_country_id,
        row.fulfillment_center_id,
        row.return_currency,
        row.return_unit_price,
        "固定演示数据包价格；高精度计算结果以统一事实为准",
      ],
      "退货物流价格",
    );

    const exceptionId = exceptionPriceId(row.version_id, row.month_id, row.route_id);
    putUnique(
      exceptionRows,
      exceptionId,
      [
        releaseId,
        exceptionId,
        priceVersionId(row.version_id),
        monthDate(row.month_id),
        row.route_id,
        row.exception_currency,
        row.exception_unit_price,
        "固定演示数据包价格；高精度计算结果以统一事实为准",
      ],
      "计费异常价格",
    );
  }

  await bulkInsert(
    client,
    "fx_rate",
    [
      "data_release_id",
      "fx_rate_id",
      "fx_version_id",
      "month_id",
      "currency_code",
      "cny_per_currency_unit",
      "rate_type",
      "source_note",
    ],
    [...fxRows.values()],
  );
  await bulkInsert(
    client,
    "transport_price",
    [
      "data_release_id",
      "transport_price_id",
      "price_version_id",
      "month_id",
      "route_id",
      "currency_code",
      "effective_base_rate_per_kg",
      "fuel_charge_basis",
      "fuel_rate_or_unit_price",
      "source_note",
    ],
    [...transportRows.values()],
  );
  await bulkInsert(
    client,
    "frontline_variable_labor_price",
    [
      "data_release_id",
      "labor_price_id",
      "price_version_id",
      "month_id",
      "fulfillment_center_id",
      "currency_code",
      "variable_labor_price_per_order",
      "source_note",
    ],
    [...laborRows.values()],
  );
  await bulkInsert(
    client,
    "packaging_price",
    [
      "data_release_id",
      "packaging_price_id",
      "price_version_id",
      "month_id",
      "fulfillment_center_id",
      "currency_code",
      "packaging_price_per_package",
      "source_note",
    ],
    [...packagingRows.values()],
  );
  await bulkInsert(
    client,
    "return_logistics_price",
    [
      "data_release_id",
      "return_price_id",
      "price_version_id",
      "month_id",
      "destination_country_id",
      "fulfillment_center_id",
      "currency_code",
      "effective_return_price_per_package",
      "source_note",
    ],
    [...returnRows.values()],
  );
  await bulkInsert(
    client,
    "billable_exception_price",
    [
      "data_release_id",
      "exception_price_id",
      "price_version_id",
      "month_id",
      "route_id",
      "currency_code",
      "average_price_per_billable_event",
      "source_note",
    ],
    [...exceptionRows.values()],
  );

  const eventRows = new Map<string, SqlRow>();
  for (const row of drivers) {
    for (const [type, note] of [
      ["BUSINESS_CONTEXT", row.event_note],
      ["MANAGEMENT_ACTION", row.management_action_note],
    ] as const) {
      if (note === null) {
        continue;
      }
      const key = `${type}|${row.version_id}|${row.month_id}|${row.destination_country_id}|${note}`;
      putUnique(
        eventRows,
        key,
        [
          releaseId,
          stableShortId("NOTE", key),
          type,
          monthDate(row.month_id),
          row.destination_country_id,
          note,
          "DEMO_PLANNING_ASSUMPTION",
          row.version_id,
        ],
        "业务事件说明",
      );
    }
  }
  await bulkInsert(
    client,
    "business_event_note",
    [
      "data_release_id",
      "event_note_id",
      "note_type",
      "month_id",
      "destination_country_id",
      "note_text",
      "source_type",
      "version_id",
    ],
    [...eventRows.values()],
  );

  await bulkInsert(
    client,
    "fulfillment_scenario_fact",
    [
      "data_release_id",
      "fulfillment_fact_id",
      "scenario_type",
      "scenario_version_id",
      "calculation_version",
      "month_id",
      "route_id",
      "equivalent_order_qty",
      "package_qty",
      "average_packages_per_order",
      "chargeable_weight_kg",
      "average_chargeable_weight_per_package_kg",
      "actual_weight_kg",
      "return_rate",
      "return_package_qty",
      "billable_events_per_package",
      "billable_exception_event_qty",
      "on_time_rate",
      "service_maturity_rate",
      "source_lineage",
    ],
    drivers.map((row) => {
      const key = `${row.version_id}|${row.month_id}|${row.route_id}`;
      const service = serviceByKey.get(key);
      assert(service !== undefined, `服务事实不存在：${key}`);
      return [
        releaseId,
        fulfillmentFactId(row.version_id, row.month_id, row.route_id),
        row.data_type,
        row.version_id,
        bundle.manifest.calculation_version,
        monthDate(row.month_id),
        row.route_id,
        row.equivalent_orders,
        row.package_count,
        row.average_packages_per_order,
        row.chargeable_weight_kg,
        row.average_chargeable_weight_per_package_kg,
        null,
        row.return_rate,
        row.return_package_count,
        row.billable_events_per_package,
        row.billable_event_count,
        service.on_time_rate,
        service.service_maturity_rate,
        sourceLineage(bundle, "driver_facts+service_facts", key),
      ];
    }),
  );

  const costs = data.cost_facts.filter((row) => isGate1ScenarioType(row.data_type));
  await bulkInsert(
    client,
    "scenario_cost_component_fact",
    [
      "data_release_id",
      "cost_component_fact_id",
      "fulfillment_fact_id",
      "cost_category",
      "price_record_id",
      "currency_code",
      "model_original_amount",
      "authoritative_original_amount",
      "fx_rate_id",
      "model_cny_amount",
      "report_cny_amount",
      "settlement_variance_cny",
      "amount_source",
    ],
    costs.map((row) => {
      const key = `${row.version_id}|${row.month_id}|${row.route_id}|${row.cost_component_id}`;
      return [
        releaseId,
        `CF:${key}`,
        fulfillmentFactId(row.version_id, row.month_id, row.route_id),
        row.cost_component_id,
        costPriceId(row),
        row.currency,
        row.original_amount,
        null,
        fxRateId(row.version_id, row.month_id, row.currency),
        row.model_cost_cny_high_precision,
        row.authority_cost_cny_report ?? row.model_cost_cny_report,
        row.authority_model_delta_cny ?? "0",
        row.authority_cost_cny_report === null ? null : "INVOICE",
      ];
    }),
  );

  const fixedCosts = data.fixed_cost_facts.filter((row) => isGate1ScenarioType(row.data_type));
  await bulkInsert(
    client,
    "fixed_cost_scenario_fact",
    [
      "data_release_id",
      "fixed_cost_fact_id",
      "scenario_version_id",
      "month_id",
      "cost_scope_type",
      "fulfillment_center_id",
      "fixed_cost_category",
      "original_amount",
      "currency_code",
      "fx_rate_id",
      "cny_amount",
      "source_type",
      "source_lineage",
    ],
    fixedCosts.map((row) => {
      const key = `${row.version_id}|${row.month_id}|${row.scope_id}|${row.fixed_cost_category_id}`;
      return [
        releaseId,
        `FCF:${key}`,
        row.version_id,
        monthDate(row.month_id),
        row.scope_id === "SHARED" ? "SHARED" : "FULFILLMENT_CENTER",
        row.scope_id === "SHARED" ? null : row.scope_id,
        row.fixed_cost_category_id,
        row.original_amount,
        row.currency,
        fxRateId(row.version_id, row.month_id, row.currency),
        row.cost_cny_report,
        "SYNTHETIC_DEMO_DATA",
        sourceLineage(bundle, "fixed_cost_facts", key),
      ];
    }),
  );

  const gmv = data.gmv_facts.filter((row) => isGate1ScenarioType(row.data_type));
  await bulkInsert(
    client,
    "scenario_gmv_fact",
    [
      "data_release_id",
      "scenario_version_id",
      "month_id",
      "destination_country_id",
      "original_amount",
      "currency_code",
      "fx_rate_id",
      "cny_amount",
      "source_lineage",
    ],
    gmv.map((row) => {
      const key = `${row.version_id}|${row.month_id}|${row.destination_country_id}`;
      return [
        releaseId,
        row.version_id,
        monthDate(row.month_id),
        row.destination_country_id,
        row.original_amount,
        row.currency,
        fxRateId(row.version_id, row.month_id, row.currency),
        row.gmv_cny_report,
        sourceLineage(bundle, "gmv_facts", key),
      ];
    }),
  );

  const comparisons: readonly SqlRow[] = [
    [
      releaseId,
      "ACTUAL_VS_BUDGET",
      data.metadata.budget_version_id,
      data.metadata.actual_version_id,
      "2026-01-01",
      "2026-08-01",
      monthDate(data.metadata.latest_closed_month),
      bundle.manifest.calculation_version,
      "PUBLISHED",
      generatedAt,
    ],
    [
      releaseId,
      "FORECAST_VS_BUDGET",
      data.metadata.budget_version_id,
      data.metadata.forecast_version_id,
      "2026-09-01",
      "2026-12-01",
      monthDate(data.metadata.latest_closed_month),
      bundle.manifest.calculation_version,
      "PUBLISHED",
      generatedAt,
    ],
  ];
  await bulkInsert(
    client,
    "variance_comparison",
    [
      "data_release_id",
      "comparison_id",
      "budget_version_id",
      "comparison_scenario_version_id",
      "period_start",
      "period_end",
      "latest_closed_month",
      "calculation_version",
      "status",
      "created_at",
    ],
    comparisons,
  );

  const attribution = data.attribution_detail.filter((row) => isGate1Comparison(row.comparison_id));
  await bulkInsert(
    client,
    "variance_attribution_fact",
    [
      "data_release_id",
      "attribution_fact_id",
      "comparison_id",
      "month_id",
      "route_id",
      "cost_category",
      "attribution_method",
      "factor",
      "attribution_cny",
      "calculation_version",
    ],
    attribution.map((row) => {
      const key = `${row.comparison_id}|${row.month_id}|${row.method_id}|${row.factor_id}|${row.route_id}|${row.cost_component_id}`;
      return [
        releaseId,
        `AF:${key}`,
        row.comparison_id,
        monthDate(row.month_id),
        row.route_id,
        row.cost_component_id,
        row.method_id === "CHAIN" ? "CHAIN_SUBSTITUTION" : "SHAPLEY",
        row.factor_id,
        row.amount_cny_high_precision,
        bundle.manifest.calculation_version,
      ];
    }),
  );

  const summaries = data.attribution_summary.filter((row) => isGate1Comparison(row.comparison_id));
  const summaryByKey = new Map(
    summaries.map((row) => [
      `${row.comparison_id}|${row.month_id}|${row.method_id}|${row.factor_id}`,
      row,
    ]),
  );
  const budgetCostByMonth = new Map<string, string>();
  for (const row of costs.filter((item) => item.version_id === data.metadata.budget_version_id)) {
    const current = budgetCostByMonth.get(row.month_id) ?? "0";
    budgetCostByMonth.set(
      row.month_id,
      new LogiPlanDecimal(current).plus(row.model_cost_cny_high_precision).toFixed(),
    );
  }
  const sensitivityRows: SqlRow[] = [];
  for (const chain of summaries.filter((row) => row.method_id === "CHAIN")) {
    const shapley = summaryByKey.get(
      `${chain.comparison_id}|${chain.month_id}|SHAPLEY|${chain.factor_id}`,
    );
    assert(shapley !== undefined, `Shapley 汇总缺失：${chain.comparison_id}|${chain.month_id}`);
    assert(
      chain.shapley_difference_cny !== undefined &&
        chain.normalized_order_sensitivity !== undefined &&
        chain.is_order_sensitive !== undefined,
      `连环替代敏感度字段缺失：${chain.comparison_id}|${chain.month_id}`,
    );
    const baseCost = budgetCostByMonth.get(chain.month_id);
    assert(baseCost !== undefined, `Budget 月度成本缺失：${chain.month_id}`);
    const key = `${chain.comparison_id}|${chain.month_id}|${chain.factor_id}`;
    sensitivityRows.push([
      releaseId,
      `ASR:${key}`,
      chain.comparison_id,
      monthDate(chain.month_id),
      monthDate(chain.month_id),
      null,
      chain.factor_id,
      chain.amount_cny_high_precision,
      shapley.amount_cny_high_precision,
      chain.shapley_difference_cny,
      chain.normalized_order_sensitivity,
      new LogiPlanDecimal(baseCost).times("0.005").toFixed(),
      chain.is_order_sensitive,
    ]);
  }
  await bulkInsert(
    client,
    "attribution_sensitivity_result",
    [
      "data_release_id",
      "sensitivity_result_id",
      "comparison_id",
      "period_start",
      "period_end",
      "destination_country_id",
      "factor",
      "chain_attribution_cny",
      "shapley_attribution_cny",
      "absolute_difference_cny",
      "normalized_difference",
      "amount_threshold_cny",
      "is_order_sensitive",
    ],
    sensitivityRows,
  );
}

async function rowCount(client: Client, table: string, releaseId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM logiplan.${table} WHERE data_release_id = $1`,
    [releaseId],
  );
  const value = result.rows[0]?.count;
  assert(value !== undefined, `${table} 行数查询无结果`);
  return Number(value);
}

function assertValue(actual: string | undefined, expected: string, label: string): void {
  assert(actual === expected, `${label}不一致：${actual ?? "NULL"} != ${expected}`);
}

export async function validateCandidateInDatabase(
  client: Client,
  bundle: LoadedReleaseBundle,
  packageSummary: PackageValidationSummary,
): Promise<CoreValidationSummary> {
  const releaseId = bundle.manifest.release_version;
  const expectedCounts = packageSummary.gate1_rows;
  const countTables = {
    fulfillment_scenario_fact: expectedCounts.fulfillment_facts ?? 0,
    scenario_cost_component_fact: expectedCounts.cost_component_facts ?? 0,
    fixed_cost_scenario_fact: expectedCounts.fixed_cost_facts ?? 0,
    scenario_gmv_fact: expectedCounts.gmv_facts ?? 0,
    variance_attribution_fact: expectedCounts.attribution_facts ?? 0,
  } as const;
  const actualCounts: Record<string, number> = {};
  for (const [table, expected] of Object.entries(countTables)) {
    const actual = await rowCount(client, table, releaseId);
    assert(actual === expected, `${table} 数据库行数不一致：${actual} != ${expected}`);
    actualCounts[table] = actual;
  }

  const overview = await client.query<{
    budget: string;
    latest_outlook: string;
    variance: string;
  }>(
    `WITH totals AS (
       SELECT f.scenario_type, sum(c.model_cny_amount) AS variable_cost
       FROM logiplan.fulfillment_scenario_fact AS f
       JOIN logiplan.scenario_cost_component_fact AS c
         ON c.data_release_id = f.data_release_id
        AND c.fulfillment_fact_id = f.fulfillment_fact_id
       WHERE f.data_release_id = $1
       GROUP BY f.scenario_type
     ), fixed AS (
       SELECT s.scenario_type, sum(f.cny_amount) AS fixed_cost
       FROM logiplan.fixed_cost_scenario_fact AS f
       JOIN logiplan.scenario_version AS s
         ON s.data_release_id = f.data_release_id
        AND s.scenario_version_id = f.scenario_version_id
       WHERE f.data_release_id = $1
       GROUP BY s.scenario_type
     ), combined AS (
       SELECT t.scenario_type, t.variable_cost + f.fixed_cost AS total_cost
       FROM totals AS t JOIN fixed AS f USING (scenario_type)
     )
     SELECT
       round(max(total_cost) FILTER (WHERE scenario_type = 'BUDGET'), 4)::text AS budget,
       round(sum(total_cost) FILTER (WHERE scenario_type IN ('ACTUAL', 'FORECAST')), 4)::text AS latest_outlook,
       round(
         sum(total_cost) FILTER (WHERE scenario_type IN ('ACTUAL', 'FORECAST'))
         - max(total_cost) FILTER (WHERE scenario_type = 'BUDGET'), 4
       )::text AS variance
     FROM combined`,
    [releaseId],
  );
  const overviewRow = overview.rows[0];
  assert(overviewRow !== undefined, "E04 查询无结果");
  assertValue(overviewRow.latest_outlook, "18327462.9382", "E04 Latest Outlook");
  assertValue(overviewRow.budget, "16197761.9712", "E04 Budget");
  assertValue(overviewRow.variance, "2129700.9671", "E04 差异");

  const gbCost = await client.query<{ actual: string; budget: string; variance: string }>(
    `SELECT
       round(sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'ACTUAL'), 4)::text AS actual,
       round(sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'BUDGET'), 4)::text AS budget,
       round(
         sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'ACTUAL')
         - sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'BUDGET'), 4
       )::text AS variance
     FROM logiplan.fulfillment_scenario_fact AS f
     JOIN logiplan.scenario_cost_component_fact AS c
       ON c.data_release_id = f.data_release_id
      AND c.fulfillment_fact_id = f.fulfillment_fact_id
     JOIN logiplan.fulfillment_route AS r
       ON r.data_release_id = f.data_release_id AND r.route_id = f.route_id
     WHERE f.data_release_id = $1
       AND f.month_id = DATE '2026-08-01'
       AND r.destination_country_id = 'GB'`,
    [releaseId],
  );
  const gbCostRow = gbCost.rows[0];
  assert(gbCostRow !== undefined, "E01 查询无结果");
  assertValue(gbCostRow.actual, "891643.2815", "E01 Actual");
  assertValue(gbCostRow.budget, "317169.0583", "E01 Budget");
  assertValue(gbCostRow.variance, "574474.2232", "E01 差异");

  const factorResult = await client.query<{ factor: string; amount: string }>(
    `SELECT a.factor, round(sum(a.attribution_cny), 4)::text AS amount
     FROM logiplan.variance_attribution_fact AS a
     JOIN logiplan.fulfillment_route AS r
       ON r.data_release_id = a.data_release_id AND r.route_id = a.route_id
     WHERE a.data_release_id = $1
       AND a.comparison_id = 'ACTUAL_VS_BUDGET'
       AND a.month_id = DATE '2026-08-01'
       AND a.attribution_method = 'CHAIN_SUBSTITUTION'
       AND r.destination_country_id = 'GB'
     GROUP BY a.factor`,
    [releaseId],
  );
  const factors = Object.fromEntries(factorResult.rows.map((row) => [row.factor, row.amount]));
  const expectedFactors = {
    VOLUME: "85239.1844",
    MIX: "324207.8221",
    EFFICIENCY: "64558.2789",
    PRICE: "79960.1574",
    FX: "20508.7803",
  } as const;
  for (const [factor, expected] of Object.entries(expectedFactors)) {
    assertValue(factors[factor], expected, `E05 ${factor}`);
  }

  const sharesResult = await client.query<{
    scenario_type: string;
    air_share: string;
    carrier_c_share: string;
    on_time_rate: string;
    maturity_rate: string;
  }>(
    `SELECT f.scenario_type,
       round(sum(f.package_qty) FILTER (WHERE r.transport_mode_id = 'AIR') / sum(f.package_qty), 4)::text AS air_share,
       round(sum(f.package_qty) FILTER (WHERE r.carrier_id = 'CARRIER_C') / sum(f.package_qty), 4)::text AS carrier_c_share,
       round(sum(f.package_qty * f.on_time_rate) / sum(f.package_qty), 4)::text AS on_time_rate,
       round(sum(f.package_qty * f.service_maturity_rate) / sum(f.package_qty), 4)::text AS maturity_rate
     FROM logiplan.fulfillment_scenario_fact AS f
     JOIN logiplan.fulfillment_route AS r
       ON r.data_release_id = f.data_release_id AND r.route_id = f.route_id
     WHERE f.data_release_id = $1
       AND f.month_id = DATE '2026-08-01'
       AND r.destination_country_id = 'GB'
       AND f.scenario_type IN ('BUDGET', 'ACTUAL')
     GROUP BY f.scenario_type`,
    [releaseId],
  );
  const shares = new Map(sharesResult.rows.map((row) => [row.scenario_type, row]));
  const budgetShares = shares.get("BUDGET");
  const actualShares = shares.get("ACTUAL");
  assert(budgetShares !== undefined && actualShares !== undefined, "E07/E10 查询缺少版本");
  assertValue(budgetShares.air_share, "0.1369", "E07 Budget 空运占比");
  assertValue(actualShares.air_share, "0.6602", "E07 Actual 空运占比");
  assertValue(budgetShares.carrier_c_share, "0.0288", "E07 Budget Carrier C 占比");
  assertValue(actualShares.carrier_c_share, "0.3884", "E07 Actual Carrier C 占比");
  assertValue(actualShares.on_time_rate, "0.9616", "E10 准时履约率");
  assertValue(actualShares.maturity_rate, "0.9200", "E10 服务成熟度");

  const warehouseResult = await client.query<{ center: string; variance: string }>(
    `SELECT r.fulfillment_center_id AS center,
       round(
         sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'ACTUAL')
         - sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'BUDGET'), 4
       )::text AS variance
     FROM logiplan.fulfillment_scenario_fact AS f
     JOIN logiplan.scenario_cost_component_fact AS c
       ON c.data_release_id = f.data_release_id
      AND c.fulfillment_fact_id = f.fulfillment_fact_id
     JOIN logiplan.fulfillment_route AS r
       ON r.data_release_id = f.data_release_id AND r.route_id = f.route_id
     WHERE f.data_release_id = $1 AND f.month_id = DATE '2026-08-01'
     GROUP BY r.fulfillment_center_id`,
    [releaseId],
  );
  const warehouses = Object.fromEntries(
    warehouseResult.rows.map((row) => [row.center, row.variance]),
  );
  assertValue(warehouses.DE_FC, "589251.0927", "E08 德国仓差异");
  assertValue(warehouses.FR_FC, "12299.5128", "E08 法国仓差异");

  const componentResult = await client.query<{ category: string; variance: string }>(
    `SELECT c.cost_category AS category,
       round(
         sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'ACTUAL')
         - sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'BUDGET'), 4
       )::text AS variance
     FROM logiplan.fulfillment_scenario_fact AS f
     JOIN logiplan.scenario_cost_component_fact AS c
       ON c.data_release_id = f.data_release_id
      AND c.fulfillment_fact_id = f.fulfillment_fact_id
     JOIN logiplan.fulfillment_route AS r
       ON r.data_release_id = f.data_release_id AND r.route_id = f.route_id
     WHERE f.data_release_id = $1
       AND f.month_id = DATE '2026-08-01'
       AND r.destination_country_id = 'GB'
     GROUP BY c.cost_category
     ORDER BY (
       sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'ACTUAL')
       - sum(c.model_cny_amount) FILTER (WHERE f.scenario_type = 'BUDGET')
     ) DESC
     LIMIT 1`,
    [releaseId],
  );
  const component = componentResult.rows[0];
  assert(component !== undefined, "E09 查询无结果");
  assertValue(component.category, "BASE_FREIGHT", "E09 最大成本类别");
  assertValue(component.variance, "432453.0802", "E09 最大成本增量");

  return {
    row_counts: actualCounts,
    core_questions: {
      E01: gbCostRow,
      E04: overviewRow,
      E05: expectedFactors,
      E06: { largest_factor: "MIX", amount: factors.MIX ?? "" },
      E07: {
        budget_air_share: budgetShares.air_share,
        actual_air_share: actualShares.air_share,
        budget_carrier_c_share: budgetShares.carrier_c_share,
        actual_carrier_c_share: actualShares.carrier_c_share,
      },
      E08: { de_fc: warehouses.DE_FC ?? "", fr_fc: warehouses.FR_FC ?? "" },
      E09: component,
      E10: {
        on_time_rate: actualShares.on_time_rate,
        maturity_rate: actualShares.maturity_rate,
      },
      E20: { order_level_available: false },
    },
  };
}

export async function activateRelease(client: Client, releaseId: string): Promise<void> {
  await client.query("SELECT logiplan.activate_data_release($1)", [releaseId]);
}

export async function assertActiveRelease(client: Client, releaseId: string): Promise<void> {
  const result = await client.query<{ data_release_id: string; status: string }>(
    `SELECT a.data_release_id, r.status
     FROM logiplan.active_data_release AS a
     JOIN logiplan.data_release AS r USING (data_release_id)
     WHERE a.singleton`,
  );
  const row = result.rows[0];
  assert(
    result.rowCount === 1 && row?.data_release_id === releaseId && row.status === "ACTIVE",
    `活动发布不是 ${releaseId}`,
  );
}

export function validationSummaryJson(
  packageSummary: PackageValidationSummary,
  coreSummary: CoreValidationSummary,
): string {
  return JSON.stringify({
    status: "PASS",
    validated_at: new Date().toISOString(),
    package: packageSummary,
    database: coreSummary,
  });
}
