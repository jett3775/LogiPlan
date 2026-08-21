import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadReleaseBundle,
  releaseManifestSchema,
  validateReleasePackage,
} from "./release-package";

const manifestPath = fileURLToPath(
  new URL("../../../database/releases/LOGIPLAN_2026_DEMO_V1.json", import.meta.url),
);

describe("fixed release package", () => {
  it("matches the frozen checksums and passes semantic validation", async () => {
    const bundle = await loadReleaseBundle(manifestPath);
    const summary = validateReleasePackage(bundle);

    expect(bundle.dataSha256).toBe(
      "4d7285a9d3cbe0671e98be3f0409e01847870a824f41e53fe4e4d8532862c674",
    );
    expect(summary.dataset_id).toBe("LOGIPLAN_2026_DEMO_V1");
    expect(summary.gate1_rows).toMatchObject({
      scenario_versions: 3,
      fulfillment_facts: 240,
      cost_component_facts: 1440,
      fixed_cost_facts: 168,
      gmv_facts: 72,
      attribution_facts: 7200,
    });
    expect(summary.order_level_available).toBe(false);
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
