import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  activateRelease,
  assertActiveRelease,
  assertDatabaseSchemaVersion,
  getReleaseStatus,
  validationSummaryJson,
} from "./release-store";

const clientFor = (query: (sql: string, values?: unknown[]) => unknown) =>
  ({ query: vi.fn(query) }) as unknown as Client;

describe("release store verification helpers", () => {
  it("checks schema and release state through parameterized read queries", async () => {
    const client = clientFor((sql, values) => {
      if (sql.includes("current_schema_version")) return { rows: [{ version: "0009" }] };
      return values?.[0] === "missing" ? { rows: [] } : { rows: [{ status: "ACTIVE" }] };
    });

    await expect(assertDatabaseSchemaVersion(client, "0009")).resolves.toBeUndefined();
    await expect(getReleaseStatus(client, "LOGIPLAN_2026_DEMO_V2")).resolves.toBe("ACTIVE");
    await expect(getReleaseStatus(client, "missing")).resolves.toBeNull();
    expect(client.query).toHaveBeenCalledWith(
      "SELECT status FROM logiplan.data_release WHERE data_release_id = $1",
      ["missing"],
    );
  });

  it("accepts the frozen 0004 package on the explicitly compatible 0009 and 0010 schemas", async () => {
    const compatible = clientFor(() => ({ rows: [{ version: "0009" }] }));
    await expect(assertDatabaseSchemaVersion(compatible, "0004")).resolves.toBeUndefined();
    const futurePackage = clientFor(() => ({ rows: [{ version: "0010" }] }));
    await expect(assertDatabaseSchemaVersion(futurePackage, "0004")).resolves.toBeUndefined();
    const unknownFuture = clientFor(() => ({ rows: [{ version: "0011" }] }));
    await expect(assertDatabaseSchemaVersion(unknownFuture, "0004")).rejects.toThrow(
      "数据库结构版本不是 0004",
    );
    await expect(assertDatabaseSchemaVersion(futurePackage, "0010")).resolves.toBeUndefined();
    await expect(assertDatabaseSchemaVersion(futurePackage, "0009")).rejects.toThrow(
      "数据库结构版本不是 0009",
    );
    const unsupportedHistorical = clientFor(() => ({ rows: [{ version: "0009" }] }));
    await expect(assertDatabaseSchemaVersion(unsupportedHistorical, "0003")).rejects.toThrow(
      "数据库结构版本不是 0003",
    );
  });

  it("rejects mismatched active or schema state", async () => {
    const schemaClient = clientFor(() => ({ rows: [{ version: "0003" }] }));
    await expect(assertDatabaseSchemaVersion(schemaClient, "0009")).rejects.toThrow(
      "数据库结构版本不是 0009",
    );

    const activeClient = clientFor(() => ({
      rows: [{ data_release_id: "LOGIPLAN_2026_DEMO_V1", status: "RETIRED" }],
      rowCount: 1,
    }));
    await expect(assertActiveRelease(activeClient, "LOGIPLAN_2026_DEMO_V2")).rejects.toThrow(
      "活动发布不是 LOGIPLAN_2026_DEMO_V2",
    );
  });

  it("uses controlled activation and serializes a passing validation summary", async () => {
    const client = clientFor(() => ({ rows: [] }));
    await activateRelease(client, "LOGIPLAN_2026_DEMO_V2");
    expect(client.query).toHaveBeenCalledWith("SELECT logiplan.activate_data_release($1)", [
      "LOGIPLAN_2026_DEMO_V2",
    ]);

    const summary = JSON.parse(
      validationSummaryJson(
        {
          dataset_id: "dataset-v2",
          full_package_rows: {},
          gate1_rows: {},
          checks: ["PASS"],
          order_level_available: false,
        },
        { row_counts: {}, core_questions: {} },
      ),
    ) as { status: string; package: { dataset_id: string }; database: { row_counts: object } };
    expect(summary).toMatchObject({
      status: "PASS",
      package: { dataset_id: "dataset-v2" },
      database: { row_counts: {} },
    });
    expect(summary).toHaveProperty("validated_at");
  });
});
