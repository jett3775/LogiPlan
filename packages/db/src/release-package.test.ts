import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  deriveCountryOrderFacts,
  loadReleaseBundle,
  releaseManifestSchema,
  validateReleasePackage,
} from "./release-package";

const manifestPath = fileURLToPath(
  new URL("../../../database/releases/LOGIPLAN_2026_DEMO_V2.json", import.meta.url),
);
const immutableV1ManifestPath = fileURLToPath(
  new URL("../../../database/releases/LOGIPLAN_2026_DEMO_V1.json", import.meta.url),
);

describe("fixed release package", () => {
  it("matches the frozen checksums and passes semantic validation", async () => {
    const bundle = await loadReleaseBundle(manifestPath);
    const summary = validateReleasePackage(bundle);

    expect(bundle.dataSha256).toBe(
      "4cbd7759d4a85a0c2c755fcf58fcbe49156083e4a81f22bf7506928148d35dfc",
    );
    expect(summary.dataset_id).toBe("LOGIPLAN_2026_DEMO_V2");
    expect(summary.gate1_rows).toMatchObject({
      scenario_versions: 3,
      fulfillment_facts: 240,
      cost_component_facts: 1440,
      fixed_cost_facts: 168,
      gmv_facts: 72,
      attribution_facts: 7200,
    });
    expect(summary.order_level_available).toBe(false);
    expect(summary.checks).toContain("country_order_source_reconciliation");

    const orderFacts = deriveCountryOrderFacts(bundle.package);
    expect(
      orderFacts.budget.find(
        (row) => row.month_id === "2026-08" && row.destination_country_id === "GB",
      )?.order_qty,
    ).toBe("4800");
    const actualGb = orderFacts.actual.filter(
      (row) => row.month_id === "2026-08" && row.destination_country_id === "GB",
    );
    expect(actualGb.map((row) => row.order_qty)).toEqual(["8664.04", "267.96"]);
  });

  it("keeps the V1 release identity and checksum immutable across the schema upgrade", async () => {
    const v1 = await loadReleaseBundle(immutableV1ManifestPath);

    expect(v1.manifest).toMatchObject({
      release_version: "LOGIPLAN_2026_DEMO_V1",
      database_schema_version: "0003",
      data_sha256: "4d7285a9d3cbe0671e98be3f0409e01847870a824f41e53fe4e4d8532862c674",
    });
    expect(v1.package.metadata.dataset_id).toBe("LOGIPLAN_2026_DEMO_V1");
  });

  it("rejects unknown manifest fields", () => {
    expect(() =>
      releaseManifestSchema.parse({
        release_version: "x",
        data_file: "x.json",
        data_sha256: "0".repeat(64),
        generator_file: "x.ts",
        generator_sha256: "0".repeat(64),
        database_schema_version: "0002",
        calculation_version: "x",
        source_description: "x",
        expected_row_counts: {
          routes: 0,
          driver_facts: 0,
          cost_facts: 0,
          fixed_cost_facts: 0,
          service_facts: 0,
          gmv_facts: 0,
          attribution_detail: 0,
          attribution_summary: 0,
          attribution_country_summary: 0,
          attribution_reconciliation: 0,
        },
        unexpected: true,
      }),
    ).toThrow();
  });
});
