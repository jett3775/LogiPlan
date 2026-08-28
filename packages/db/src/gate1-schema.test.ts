import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../database/migrations/0001_gate1_schema.sql", import.meta.url);
const countryOrderMigrationUrl = new URL(
  "../../../database/migrations/0004_active_country_order_fact.sql",
  import.meta.url,
);

describe("Gate 1 schema migration", () => {
  it("contains the frozen release, source and analysis structures", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const requiredTables = [
      "data_release",
      "active_data_release",
      "scenario_version",
      "budget_country_month",
      "actual_route_operation",
      "forecast_country_order_override",
      "fulfillment_scenario_fact",
      "scenario_cost_component_fact",
      "fixed_cost_scenario_fact",
      "variance_comparison",
      "variance_attribution_fact",
      "attribution_sensitivity_result",
    ];

    for (const table of requiredTables) {
      expect(sql).toContain(`CREATE TABLE logiplan.${table}`);
    }
    expect(sql).toContain("attribution_cny numeric(50,24)");
    expect(sql).toContain("report_cny_amount numeric(20,4)");
    expect(sql).toContain("cny_per_currency_unit numeric(20,6)");
    expect(sql).toContain("EXCLUDE USING gist");
  });

  it("exposes only active-version views to the runtime role", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("JOIN logiplan.active_data_release AS a USING (data_release_id)");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA logiplan FROM app_reader");
    expect(sql).toContain("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA logiplan FROM PUBLIC");
    expect(sql).toContain("CREATE FUNCTION logiplan.enforce_candidate_release_write");
    expect(sql).toContain("CREATE FUNCTION logiplan.activate_data_release");
    expect(sql).toContain("TO app_reader;");
    expect(sql).not.toMatch(/GRANT SELECT ON ALL TABLES[^;]+app_reader/su);
  });

  it("exposes true destination orders through one controlled active view", async () => {
    const sql = await readFile(countryOrderMigrationUrl, "utf8");

    expect(sql).toContain("CREATE VIEW logiplan.active_country_order_fact");
    expect(sql).toContain("FROM logiplan.budget_country_month AS b");
    expect(sql).toContain("FROM logiplan.actual_country_warehouse_fulfillment AS a");
    expect(sql).toContain("GRANT SELECT ON logiplan.active_country_order_fact TO app_reader");
    expect(sql).not.toMatch(/GRANT SELECT ON[\s\S]+budget_country_month[\s\S]+TO app_reader/u);
    expect(sql).not.toMatch(
      /GRANT SELECT ON[\s\S]+actual_country_warehouse_fulfillment[\s\S]+TO app_reader/u,
    );
  });

  it("does not create Gate 2 state or model-control tables", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).not.toMatch(
      /CREATE TABLE logiplan\.(ai_|model_|rate_limit|cost_reservation|session_)/u,
    );
    expect(sql).not.toContain("CREATE TYPE");
  });
});
