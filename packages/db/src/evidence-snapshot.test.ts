/// <reference lib="dom" />

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { LogiPlanDecimal } from "@logiplan/domain";
import {
  FACTORS,
  attributionIntents,
  type DrilldownPayload,
  type BridgePayload,
} from "../../../apps/web/app/lib/model";
import type { Page, Request } from "@playwright/test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  deterministicResultInputSchema,
  deterministicResultSchema,
  type QueryIntentV11,
} from "@logiplan/contracts";
import {
  materializeEvidenceSnapshots,
  releaseEvidenceSnapshotIntents,
  runDeterministicQuery,
} from "./query-service";
import { evidence, resultId } from "./query-result";
import { findMaterializedSnapshot, lookupEvidenceSnapshot } from "./evidence-snapshot";
import { loadReleaseBundle, validateReleasePackage } from "./release-package";
import {
  insertReleaseData,
  validateCandidateInDatabase,
  validationSummaryJson,
} from "./release-store";

const intent: QueryIntentV11 = {
  contract_version: "V1.1",
  question_type: "COUNTRY_VARIANCE_SUMMARY",
  scope: {
    period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
    comparison: "ACTUAL_VS_BUDGET",
    destination_country_ids: ["GB"],
    budget_version_id: "BUDGET_2026_V1",
    actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
    calculation_version: "D-092",
  },
  metrics: ["FULFILLMENT_VARIABLE_COST"],
  group_by: [],
  output_locale: "zh-CN",
  context_sources: ["FIXED_TEMPLATE"],
};
const lookup = (id: string): QueryIntentV11 => ({
  ...intent,
  question_type: "EVIDENCE_LOOKUP",
  evidence_id: "E01-country",
  evidence_snapshot_id: id,
  metrics: [],
});

function fixture() {
  return deterministicResultInputSchema.parse({
    contract_version: "V1.1",
    result_id: resultId(intent),
    query_intent: intent,
    scope_label: "英国",
    data_as_of: "2026-09-01T00:00:00.000Z",
    generated_at: "2026-09-01T00:00:00.000Z",
    reporting_currency: "CNY",
    precision: { calculation: "HIGH_PRECISION_DECIMAL", report_places: 4, display_places: 2 },
    payload: { variance: "574474.2232" },
    evidence: [evidence("E01-country", intent, "差异", "574474.2232", "CHAIN")],
    warnings: [],
  });
}

function realtimeHarness(failure?: string) {
  const committed: unknown[] = [];
  let pending: unknown[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("BEGIN")) return { rows: [], rowCount: 0 };
    if (sql === "ROLLBACK") {
      pending = [];
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      if (failure === "commit") throw new Error("injected commit failure");
      committed.push(...pending);
      pending = [];
      return { rows: [], rowCount: 0 };
    }
    if (sql === "SELECT data_release_id FROM logiplan.active_release")
      return { rows: [{ data_release_id: "release-A" }], rowCount: 1 };
    if (sql.includes("persist_query_evidence_snapshot")) {
      if (failure === "save") throw new Error("injected save failure");
      const source = JSON.parse(String(params?.[0]));
      expect(source._data_release_id).toBe("release-A");
      delete source._data_release_id;
      const snapshotId = `ES-${randomUUID()}`;
      const result = {
        ...source,
        evidence: source.evidence.map((item: object) => ({
          ...item,
          evidence_snapshot_id: snapshotId,
          data_release_id: "release-A",
        })),
      };
      pending.push(result);
      if (failure === "saved-schema") return { rows: [{ result: {} }], rowCount: 1 };
      if (failure === "saved-binding") result.evidence[0].data_release_id = "release-B";
      if (failure === "saved-content") result.payload = { changed: true };
      if (failure === "saved-id") delete result.evidence[0].evidence_snapshot_id;
      return { rows: [{ result }], rowCount: 1 };
    }
    if (failure === "business") throw new Error("injected business failure");
    if (sql.includes("AS variable_cost"))
      return {
        rows: [
          {
            variable_cost:
              params?.[0] === intent.scope.budget_version_id ? "10" : "12.34567890123456789",
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("AS fixed_cost")) return { rows: [{ fixed_cost: "0" }], rowCount: 1 };
    throw new Error("Unexpected query outside the declared test boundary");
  });
  const outsideQuery = vi.fn(async () => {
    throw new Error("Realtime facts must use the transaction client");
  });
  const pool = {
    query: outsideQuery,
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as Pool;
  return { pool, query, release, committed, outsideQuery };
}

describe("persistent evidence snapshots", () => {
  it("commits a fresh complete snapshot for every successful realtime query", async () => {
    const h = realtimeHarness();
    const first = deterministicResultSchema.parse(
      await runDeterministicQuery(h.pool, intent, "first"),
    );
    expect(first.payload).toMatchObject({ variance: { high_precision: "2.34567890123456789" } });
    expect(h.committed).toEqual([first]);
    const second = deterministicResultSchema.parse(
      await runDeterministicQuery(h.pool, intent, "second"),
    );
    expect(first.result_id).toBe(second.result_id);
    expect(first.evidence[0]?.evidence_snapshot_id).not.toBe(
      second.evidence[0]?.evidence_snapshot_id,
    );
    expect(h.committed).toEqual([first, second]);
    expect(h.outsideQuery).not.toHaveBeenCalled();
    expect(h.query.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it.each([
    "business",
    "save",
    "commit",
    "saved-schema",
    "saved-binding",
    "saved-content",
    "saved-id",
  ])("blocks success and rolls back on %s failure", async (failure) => {
    const h = realtimeHarness(failure);
    await expect(runDeterministicQuery(h.pool, intent, failure)).rejects.toThrow();
    expect(h.committed).toEqual([]);
    expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    expect(h.release).toHaveBeenCalledOnce();
    if (failure !== "commit") expect(h.query).not.toHaveBeenCalledWith("COMMIT");
    else expect(h.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rejects invalid intents without acquiring a connection and leaves V1.0 read-only", async () => {
    const h = realtimeHarness();
    expect(
      await runDeterministicQuery(h.pool, { ...intent, unexpected: true }, "invalid"),
    ).toMatchObject({ code: "INVALID_FILTER" });
    expect(h.pool.connect).not.toHaveBeenCalled();
    const legacy: Record<string, unknown> = { ...intent };
    delete legacy.contract_version;
    const result = deterministicResultSchema.parse(
      await runDeterministicQuery({ query: h.query } as unknown as Pool, legacy, "v10"),
    );
    expect(result.contract_version).toBe("V1.0");
    expect(
      result.evidence.every(
        (item) => item.evidence_snapshot_id === undefined && item.data_release_id === undefined,
      ),
    ).toBe(true);
    expect(h.committed).toEqual([]);
    expect(h.query.mock.calls.every(([sql]) => !/BEGIN|persist_/.test(sql))).toBe(true);
  });

  it("scopes materialized result reuse to the current active release", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("s.data_release_id = COALESCE($2");
      expect(params).toEqual([resultId(intent), null]);
      return { rows: [], rowCount: 0 };
    });
    await expect(
      findMaterializedSnapshot(
        { query } as unknown as Parameters<typeof findMaterializedSnapshot>[0],
        intent,
      ),
    ).resolves.toBeNull();
  });

  it("requires the publisher materialization entry to run inside repeatable read", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "SHOW transaction_isolation") {
        return { rows: [{ transaction_isolation: "repeatable read" }], rowCount: 1 };
      }
      if (sql.includes("FROM logiplan.active_data_release")) {
        return { rows: [{ data_release_id: "release-A" }], rowCount: 1 };
      }
      if (sql.includes("FROM logiplan.evidence_snapshot"))
        throw new Error("publisher materialization must not read snapshot table directly");
      if (sql.includes("persist_evidence_snapshot")) {
        const saved = JSON.parse(String(params?.[0]));
        delete saved._data_release_id;
        saved.evidence = saved.evidence.map((item: object) => ({
          ...item,
          evidence_snapshot_id: "ES-published",
          data_release_id: "release-A",
        }));
        return { rows: [{ result: saved }], rowCount: 1 };
      }
      // Stub business reads; this test only exercises the materialization path.
      if (
        sql.includes("AS variable_cost") ||
        sql.includes("AS fixed_cost") ||
        sql.includes("active_fixed_cost_scenario_fact")
      ) {
        return { rows: [{ variable_cost: "10", fixed_cost: "0" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(
      materializeEvidenceSnapshots(
        { query } as unknown as Parameters<typeof materializeEvidenceSnapshots>[0],
        [intent],
        "writer-test",
      ),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenNthCalledWith(1, "SHOW transaction_isolation");
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM logiplan.active_data_release"),
    );
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("persist_evidence_snapshot")),
    ).toBe(true);
  });

  it("restores exact JSON after active release changes without running business SQL", async () => {
    const result = fixture();
    result.evidence[0] = {
      ...result.evidence[0]!,
      evidence_snapshot_id: "ES-old",
      data_release_id: "release-A",
      snapshot_generated_at: "2026-09-01T00:00:00.000Z",
    };
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes("FROM logiplan.evidence_snapshot"))
        throw new Error("Historical lookup must not recompute");
      return { rows: [{ result, historical: true }], rowCount: 1 };
    });
    const restored = await runDeterministicQuery(
      { query } as unknown as Pool,
      lookup("ES-old"),
      "history",
    );
    if ("code" in restored) throw new Error(restored.message_zh);
    expect(restored).toEqual({
      ...result,
      warnings: [{ code: "HISTORICAL_VERSION", message: "证据快照来自非当前活动数据发布" }],
    });
    expect(restored.payload).toEqual(result.payload);
    expect(restored.evidence).toEqual(result.evidence);
    expect(restored.warnings).toEqual([
      { code: "HISTORICAL_VERSION", message: "证据快照来自非当前活动数据发布" },
    ]);
    expect(restored.evidence).toHaveLength(1);
    expect(restored.evidence[0]).toMatchObject({
      evidence_id: "E01-country",
      evidence_snapshot_id: "ES-old",
      data_release_id: "release-A",
      source_result_id: result.evidence[0]?.source_result_id,
      snapshot_generated_at: "2026-09-01T00:00:00.000Z",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).not.toContain("active_scenario");
    const reordered = {
      ...lookup("ES-old"),
      scope: {
        ...intent.scope,
        period: { grain: "MONTH" as const, to: "2026-08", from: "2026-08" },
      },
    };
    expect(
      await runDeterministicQuery({ query } as unknown as Pool, reordered, "order"),
    ).toHaveProperty("evidence", result.evidence);
    expect(
      await runDeterministicQuery(
        { query } as unknown as Pool,
        { ...lookup("ES-old"), evidence_id: "unknown" },
        "bad-id",
      ),
    ).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    for (const scope of [
      { ...intent.scope, factor_id: "MIX" },
      { ...intent.scope, actual_version_id: "new" },
      { ...intent.scope, destination_country_ids: ["DE"] },
    ]) {
      expect(
        await runDeterministicQuery(
          { query } as unknown as Pool,
          { ...lookup("ES-old"), scope },
          "bad-scope",
        ),
      ).toMatchObject({ code: "INVALID_FILTER" });
    }
    expect(
      await runDeterministicQuery(
        { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool,
        lookup("unknown"),
        "missing",
      ),
    ).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
  });

  it.each([
    ["same active release", false, 0],
    ["different active release", true, 1],
    ["missing active release", true, 1],
  ])("returns the correct historical warning for %s", async (_label, historical, count) => {
    const saved = fixture();
    saved.evidence[0] = {
      ...saved.evidence[0]!,
      evidence_snapshot_id: "ES-history-status",
      data_release_id: "release-A",
    };
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("AS historical");
      return { rows: [{ result: saved, historical }], rowCount: 1 };
    });
    const result = await lookupEvidenceSnapshot(
      { query } as unknown as Parameters<typeof lookupEvidenceSnapshot>[0],
      lookup("ES-history-status"),
      "history-status",
    );
    if ("code" in result) throw new Error(result.message_zh);
    expect(result.warnings.filter((warning) => warning.code === "HISTORICAL_VERSION")).toHaveLength(
      count,
    );
    expect(query).toHaveBeenCalledOnce();
    expect(saved.warnings).toEqual([]);
  });

  it("preserves existing warnings and does not duplicate historical warning", async () => {
    const saved = fixture();
    saved.evidence[0] = {
      ...saved.evidence[0]!,
      evidence_snapshot_id: "ES-history-warning",
      data_release_id: "release-A",
    };
    saved.warnings = [
      { code: "REPORT_ROUNDING", message: "保留已有警告" },
      { code: "HISTORICAL_VERSION", message: "已有历史警告" },
    ];
    const query = vi.fn(async () => ({ rows: [{ result: saved, historical: true }], rowCount: 1 }));
    const result = await lookupEvidenceSnapshot(
      { query } as unknown as Parameters<typeof lookupEvidenceSnapshot>[0],
      lookup("ES-history-warning"),
      "history-warning",
    );
    if ("code" in result) throw new Error(result.message_zh);
    expect(result.warnings).toEqual(saved.warnings);
    expect(result).not.toBe(saved);
    expect(saved.warnings).toHaveLength(2);
    expect(query).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the client on query failure or missing active release", async () => {
    for (const failure of ["business", "missing-release"]) {
      const query = vi.fn(async (sql: string) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM logiplan.evidence_snapshot")) return { rows: [], rowCount: 0 };
        if (sql === "SELECT data_release_id FROM logiplan.active_release")
          return {
            rows: failure === "missing-release" ? [] : [{ data_release_id: "A" }],
            rowCount: failure === "missing-release" ? 0 : 1,
          };
        throw new Error("database unavailable");
      });
      const release = vi.fn();
      const pool = { query, connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
      if (failure === "missing-release")
        expect(await runDeterministicQuery(pool, intent, "failure")).toMatchObject({
          code: "VERSION_NOT_FOUND",
        });
      else
        await expect(runDeterministicQuery(pool, intent, "failure")).rejects.toThrow(
          "database unavailable",
        );
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(query).not.toHaveBeenCalledWith("COMMIT");
      expect(release).toHaveBeenCalledOnce();
    }
  });
});

// Explicit opt-in: these URLs must point to the slice's isolated, disposable DB.
describe.skipIf(!process.env.SNAPSHOT_TEST_DATABASE_URL)("snapshot PostgreSQL integration", () => {
  beforeAll(async () => {
    if (
      process.env.SNAPSHOT_TEST_API_URL &&
      !["127.0.0.1", "localhost"].includes(new URL(process.env.SNAPSHOT_TEST_API_URL).hostname)
    )
      throw new Error("Snapshot API tests require a local server");
    for (const name of [
      "SNAPSHOT_TEST_DATABASE_URL",
      "SNAPSHOT_TEST_MIGRATION_URL",
      "SNAPSHOT_TEST_PUBLISHER_URL",
    ]) {
      const url = new URL(process.env[name]!);
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        throw new Error("Snapshot tests require isolated local PostgreSQL");
    }
    if (process.env.SNAPSHOT_TEST_SEED_EMPTY !== "1") return;
    const publisher = new Client({ connectionString: process.env.SNAPSHOT_TEST_PUBLISHER_URL });
    await publisher.connect();
    try {
      // Seed through the real validated release path, deliberately without materialization.
      const existing = await publisher.query(
        "SELECT count(*)::text AS count FROM logiplan.data_release",
      );
      if (existing.rows[0]?.count !== "0")
        throw new Error("Seed requires an empty isolated database");
      const bundle = await loadReleaseBundle(
        fileURLToPath(
          new URL("../../../database/releases/LOGIPLAN_2026_DEMO_V2.json", import.meta.url),
        ),
      );
      const summary = validateReleasePackage(bundle);
      const releaseId = bundle.manifest.release_version;
      await publisher.query("BEGIN");
      await publisher.query(
        "SELECT logiplan.create_data_release_candidate($1,$1,$2,$3,$4,$5,$6,$7)",
        [
          releaseId,
          bundle.dataSha256,
          bundle.manifest.database_schema_version,
          bundle.manifest.calculation_version,
          `sha256:${bundle.generatorSha256}`,
          bundle.manifest.source_description,
          `${bundle.package.metadata.generated_on}T00:00:00.000Z`,
        ],
      );
      await insertReleaseData(publisher, bundle);
      const core = await validateCandidateInDatabase(publisher, bundle, summary);
      await publisher.query("SELECT logiplan.mark_data_release_validated($1,$2::jsonb)", [
        releaseId,
        validationSummaryJson(summary, core),
      ]);
      await publisher.query("SELECT logiplan.activate_data_release($1)", [releaseId]);
      await publisher.query("COMMIT");
      const observer = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
      try {
        expect(
          (await observer.query("SELECT count(*)::text AS count FROM logiplan.evidence_snapshot"))
            .rows[0]?.count,
        ).toBe("0");
      } finally {
        await observer.end();
      }
    } catch (cause) {
      await publisher.query("ROLLBACK");
      throw cause;
    } finally {
      await publisher.end();
    }
  }, 120_000);

  it("persists normal query evidence, enforces privileges/immutability and survives a release switch", async () => {
    const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
    const migrator = new Pool({ connectionString: process.env.SNAPSHOT_TEST_MIGRATION_URL });
    const publisher = new Pool({ connectionString: process.env.SNAPSHOT_TEST_PUBLISHER_URL });
    try {
      const initialSnapshotCount = await reader.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM logiplan.evidence_snapshot",
      );
      if (process.env.SNAPSHOT_TEST_SEED_EMPTY === "1")
        expect(initialSnapshotCount.rows[0]?.count).toBe("0");
      const apiUrl = process.env.SNAPSHOT_TEST_API_URL;
      const apiResponse = apiUrl
        ? await fetch(`${apiUrl}/api/v1/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(intent),
          })
        : undefined;
      if (apiResponse) expect(apiResponse.status).toBe(200);
      const result = deterministicResultSchema.parse(
        apiResponse
          ? await apiResponse.json()
          : await runDeterministicQuery(reader, intent, "db-first"),
      );
      expect(result.evidence[0]?.evidence_snapshot_id).toMatch(/^ES-/u);
      const committed = await migrator.query(
        "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id = $1",
        [result.evidence[0]?.evidence_snapshot_id],
      );
      expect(committed.rows[0]?.result).toEqual(result);
      expect(
        (await reader.query("SELECT count(*)::text AS count FROM logiplan.evidence_snapshot"))
          .rows[0]?.count,
      ).toBe(String(Number(initialSnapshotCount.rows[0]?.count) + 1));
      const writer = await publisher.connect();
      try {
        await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await materializeEvidenceSnapshots(writer, [intent], "db-publish");
        await writer.query("COMMIT");
      } catch (error) {
        await writer.query("ROLLBACK");
        throw error;
      } finally {
        writer.release();
      }
      const materialized = await reader.query<{ result: typeof result }>(
        `SELECT result FROM logiplan.evidence_snapshot
         WHERE result->>'result_id' = $1 ORDER BY created_at DESC LIMIT 1`,
        [result.result_id],
      );
      const materializedResult = materialized.rows[0]?.result;
      expect(materializedResult).toBeDefined();
      if (materializedResult === undefined) throw new Error("快照物化结果缺失");
      const item = materializedResult.evidence[0];
      expect(item).toBeDefined();
      if (item === undefined) throw new Error("快照证据缺失");
      expect(item.evidence_snapshot_id).toMatch(/^ES-/);
      expect(item.data_release_id).toBe("LOGIPLAN_2026_DEMO_V2");
      const saved = await reader.query(
        "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id=$1",
        [item.evidence_snapshot_id],
      );
      expect(saved.rows[0]?.result).toEqual(materialized.rows[0]?.result);
      for (const sql of [
        "INSERT INTO logiplan.evidence_snapshot DEFAULT VALUES",
        "UPDATE logiplan.evidence_snapshot SET result = '{}'::jsonb",
        "DELETE FROM logiplan.evidence_snapshot",
        "TRUNCATE logiplan.evidence_snapshot",
        "INSERT INTO logiplan.data_release DEFAULT VALUES",
        "INSERT INTO logiplan.scenario_cost_component_fact DEFAULT VALUES",
      ])
        await expect(reader.query(sql)).rejects.toMatchObject({ code: "42501" });
      for (const sql of [
        "UPDATE logiplan.evidence_snapshot SET result = '{}'::jsonb",
        "DELETE FROM logiplan.evidence_snapshot",
        "TRUNCATE logiplan.evidence_snapshot",
      ])
        await expect(migrator.query(sql)).rejects.toMatchObject({ code: "55000" });
      await expect(
        publisher.query("SELECT * FROM logiplan.evidence_snapshot"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        publisher.query("SELECT logiplan.persist_evidence_snapshot('{}')"),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        reader.query("SELECT logiplan.persist_evidence_snapshot($1::jsonb)", [
          JSON.stringify(fixture()),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      const client = await reader.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await expect(
          client.query("SELECT logiplan.persist_evidence_snapshot('{}')"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      // Activate a validated, empty release with no matching business versions.
      const releaseId = `SNAPSHOT_TEST_${randomUUID()}`;
      await publisher.query(
        "SELECT logiplan.create_data_release_candidate($1,$1,repeat('0',64),'0009','D-092','test','snapshot test',clock_timestamp())",
        [releaseId],
      );
      await publisher.query("SELECT logiplan.mark_data_release_validated($1,$2::jsonb)", [
        releaseId,
        JSON.stringify({ status: "PASS" }),
      ]);
      await publisher.query("SELECT logiplan.activate_data_release($1)", [releaseId]);
      try {
        const restored = deterministicResultSchema.parse(
          await runDeterministicQuery(reader, lookup(item.evidence_snapshot_id!), "db-history"),
        );
        expect(restored).toEqual({
          ...materialized.rows[0]?.result,
          warnings: [{ code: "HISTORICAL_VERSION", message: "证据快照来自非当前活动数据发布" }],
        });
        expect(await runDeterministicQuery(reader, lookup("unknown"), "db-missing")).toMatchObject({
          code: "EVIDENCE_NOT_FOUND",
        });
        expect(
          await runDeterministicQuery(
            reader,
            { ...lookup(item.evidence_snapshot_id!), evidence_id: "unknown" },
            "db-unknown",
          ),
        ).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
        expect(
          await runDeterministicQuery(
            reader,
            {
              ...lookup(item.evidence_snapshot_id!),
              scope: { ...intent.scope, destination_country_ids: ["DE"] },
            },
            "db-scope",
          ),
        ).toMatchObject({ code: "INVALID_FILTER" });
      } finally {
        await publisher.query("SELECT logiplan.activate_data_release($1)", [item.data_release_id]);
      }
    } finally {
      await Promise.all([reader.end(), migrator.end(), publisher.end()]);
    }
  }, 30_000);

  it.skipIf(!process.env.SNAPSHOT_TEST_API_URL || !process.env.SNAPSHOT_TEST_SUPERUSER_URL)(
    "returns a historical warning when the active release is absent inside a rollback transaction",
    async () => {
      const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
      const superuser = new Client({ connectionString: process.env.SNAPSHOT_TEST_SUPERUSER_URL });
      await superuser.connect();
      try {
        const response = await fetch(`${process.env.SNAPSHOT_TEST_API_URL}/api/v1/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(intent),
        });
        expect(response.status).toBe(200);
        const saved = deterministicResultSchema.parse(await response.json());
        const snapshotId = saved.evidence[0]?.evidence_snapshot_id;
        if (snapshotId === undefined) throw new Error("实时快照 ID 缺失");
        const persisted = await reader.query(
          "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id = $1",
          [snapshotId],
        );
        const beforeCount = (
          await reader.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot")
        ).rows[0].count;
        await superuser.query("BEGIN");
        try {
          await superuser.query("DELETE FROM logiplan.active_data_release WHERE singleton");
          const restored = await lookupEvidenceSnapshot(
            superuser,
            lookup(snapshotId),
            "missing-active-release",
          );
          if ("code" in restored) throw new Error(restored.message_zh);
          expect(restored.warnings).toContainEqual({
            code: "HISTORICAL_VERSION",
            message: "证据快照来自非当前活动数据发布",
          });
          expect(restored).toEqual({
            ...saved,
            warnings: [
              ...saved.warnings,
              { code: "HISTORICAL_VERSION", message: "证据快照来自非当前活动数据发布" },
            ],
          });
          expect(
            (
              await superuser.query(
                "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id = $1",
                [snapshotId],
              )
            ).rows[0].result,
          ).toEqual(persisted.rows[0].result);
          expect(
            (await superuser.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot"))
              .rows[0].count,
          ).toBe(beforeCount);
        } finally {
          await superuser.query("ROLLBACK");
        }
        expect(
          (await reader.query("SELECT data_release_id FROM logiplan.active_release")).rows,
        ).toHaveLength(1);
        expect(
          (await reader.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot"))
            .rows[0].count,
        ).toBe(beforeCount);
        expect(
          (
            await reader.query(
              "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id = $1",
              [snapshotId],
            )
          ).rows[0].result,
        ).toEqual(persisted.rows[0].result);
      } finally {
        await Promise.all([reader.end(), superuser.end()]);
      }
    },
    30_000,
  );

  it.skipIf(!process.env.SNAPSHOT_TEST_API_URL)(
    "uses the real API for compatibility and save-failure responses",
    async () => {
      const base = process.env.SNAPSHOT_TEST_API_URL!;
      const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
      const migrator = new Pool({ connectionString: process.env.SNAPSHOT_TEST_MIGRATION_URL });
      const post = (body: unknown) =>
        fetch(`${base}/api/v1/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const count = async () =>
        (await reader.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot"))
          .rows[0].count;
      try {
        const before = await count();
        const v10: Record<string, unknown> = { ...intent };
        delete v10.contract_version;
        const legacy = await post(v10);
        expect(legacy.status).toBe(200);
        const result = deterministicResultSchema.parse(await legacy.json());
        expect(result.contract_version).toBe("V1.0");
        expect(
          result.evidence.every(
            (item) => item.evidence_snapshot_id === undefined && item.data_release_id === undefined,
          ),
        ).toBe(true);
        expect((await post({ ...intent, result: fixture() })).status).toBe(400);
        const missing = await post({
          ...intent,
          question_type: "EVIDENCE_LOOKUP",
          evidence_id: "unknown",
          metrics: [],
        });
        expect(missing.status).toBe(400);
        expect(await missing.json()).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
        await migrator.query(
          "REVOKE EXECUTE ON FUNCTION logiplan.persist_query_evidence_snapshot(jsonb) FROM app_reader",
        );
        try {
          const failed = await post(intent);
          expect(failed.status).toBe(503);
          expect(await failed.json()).toMatchObject({ type: "QUERY_TIMEOUT" });
          expect(await count()).toBe(before);
        } finally {
          await migrator.query(
            "GRANT EXECUTE ON FUNCTION logiplan.persist_query_evidence_snapshot(jsonb) TO app_reader",
          );
        }
      } finally {
        await Promise.all([reader.end(), migrator.end()]);
      }
    },
    30_000,
  );

  it.skipIf(!process.env.SNAPSHOT_TEST_API_URL || !process.env.SNAPSHOT_TEST_PUBLISHER_URL)(
    "preserves historical release evidence across both Chromium viewports",
    async () => {
      const { chromium, expect: browserExpect } = await import("@playwright/test");
      const { attributionIntents } = await import("../../../apps/web/app/lib/model");
      const browser = await chromium.launch({ headless: true });
      const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
      const publisher = new Pool({ connectionString: process.env.SNAPSHOT_TEST_PUBLISHER_URL });
      const base = process.env.SNAPSHOT_TEST_API_URL!;
      try {
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 1280, height: 800 },
        ]) {
          const context = await browser.newContext({ viewport });
          try {
            const initialIntents = Object.values(attributionIntents());
            const requests: Request[] = [];
            const isQuery = (request: Request) =>
              request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/query";
            const observe = (target: Page) => {
              target.on("request", (request) => {
                if (isQuery(request)) requests.push(request);
              });
            };
            const requestWindow = (
              await reader.query<{ started_at: string; data_release_id: string }>(
                `SELECT clock_timestamp()::text AS started_at, data_release_id
                 FROM logiplan.active_release`,
              )
            ).rows[0]!;
            // Scope counts to this viewport's request window, release and full intents.
            // Include observed lookups so an accidental save cannot escape the assertion.
            const counts = async () =>
              (
                await reader.query<{ question_type: string; count: number }>(
                  `SELECT result->'query_intent'->>'question_type' AS question_type,
                          count(*)::int AS count
                   FROM logiplan.evidence_snapshot
                   WHERE created_at >= $1::timestamptz AND data_release_id = $2
                     AND result->'query_intent' = ANY($3::jsonb[])
                   GROUP BY result->'query_intent'->>'question_type'`,
                  [
                    requestWindow.started_at,
                    requestWindow.data_release_id,
                    [...initialIntents, ...requests.map((request) => request.postDataJSON())].map(
                      (query) => JSON.stringify(query),
                    ),
                  ],
                )
              ).rows;
            const count = async () => (await counts()).reduce((sum, row) => sum + row.count, 0);
            const totalSnapshotCount = async () =>
              (
                await reader.query<{ count: number }>(
                  "SELECT count(*)::int AS count FROM logiplan.evidence_snapshot",
                )
              ).rows[0]!.count;
            const page = await context.newPage();
            observe(page);
            await page.goto(`${base}/attribution`);
            await browserExpect(
              page.getByRole("heading", { name: "英国履约变动成本归因" }),
            ).toBeVisible();
            // Each server-side first-screen V1.1 query must have committed its own new snapshot.
            await browserExpect
              .poll(
                async () => {
                  const committed = await counts();
                  return initialIntents.map(
                    (query) =>
                      committed.find((row) => row.question_type === query.question_type)?.count ??
                      0,
                  );
                },
                { timeout: 10_000 },
              )
              .toEqual([1, 1, 1, 1]);
            const row = page
              .getByRole("row", { name: /德国仓/u })
              .filter({ has: page.getByRole("button", { name: "数字证据", exact: true }) });
            const beforeOpen = await count();
            expect(beforeOpen).toBe(4);
            const [opened] = await Promise.all([
              page.waitForResponse((response) => isQuery(response.request())),
              row.getByRole("button", { name: "数字证据", exact: true }).click(),
            ]);
            await opened.finished();
            const dialog = page.getByRole("dialog", { name: "数字证据侧栏" });
            await browserExpect(dialog).toBeVisible();
            await browserExpect(dialog.getByText(/^ES-[0-9a-f-]+$/u)).toBeVisible();
            const address = new URL(page.url());
            const snapshotId = address.searchParams.get("evidence_snapshot_id");
            expect(snapshotId).toMatch(/^ES-/u);
            const saved = (
              await reader.query(
                `SELECT result FROM logiplan.evidence_snapshot
                 WHERE evidence_snapshot_id=$1 AND created_at >= $2::timestamptz
                   AND data_release_id=$3`,
                [snapshotId, requestWindow.started_at, requestWindow.data_release_id],
              )
            ).rows[0].result;
            const selected = saved.evidence.find(
              (item: { evidence_id: string }) =>
                item.evidence_id === address.searchParams.get("evidence_id"),
            );
            expect(selected).toBeDefined();
            const assertHistoricalRequests = async (from: number, historical = false) => {
              const observed = requests.slice(from);
              expect(observed.length).toBeGreaterThan(0);
              const expected = historical
                ? {
                    ...saved,
                    warnings: [
                      ...saved.warnings,
                      {
                        code: "HISTORICAL_VERSION" as const,
                        message: "证据快照来自非当前活动数据发布",
                      },
                    ],
                  }
                : saved;
              for (const request of observed) {
                expect(request.postDataJSON()).toMatchObject({
                  contract_version: "V1.1",
                  question_type: "EVIDENCE_LOOKUP",
                  evidence_id: selected.evidence_id,
                  evidence_snapshot_id: snapshotId,
                  scope: saved.query_intent.scope,
                });
                const response = await request.response();
                expect(response).not.toBeNull();
                expect(await response!.finished()).toBeNull();
                expect(response!.status()).toBe(200);
                expect(deterministicResultSchema.parse(await response!.json())).toEqual(expected);
              }
            };
            const restore = async (target: Page, navigate: () => Promise<unknown>) => {
              const beforeLookup = await count();
              const from = requests.length;
              const [response] = await Promise.all([
                target.waitForResponse(
                  (response) =>
                    isQuery(response.request()) &&
                    response.request().postDataJSON().question_type === "EVIDENCE_LOOKUP",
                ),
                navigate(),
              ]);
              await response.finished();
              await assertHistoricalRequests(from);
              await browserExpect(target.getByText(snapshotId!, { exact: true })).toBeVisible();
              expect(new URL(target.url()).searchParams.get("evidence_snapshot_id")).toBe(
                snapshotId,
              );
              // A completed historical lookup must not insert even one related snapshot.
              expect(await count()).toBe(beforeLookup);
            };
            await assertHistoricalRequests(0);
            await browserExpect(dialog).toContainText(selected.value);
            expect(await count()).toBe(beforeOpen);
            const sharedUrl = page.url();
            await page.getByRole("button", { name: "关闭数字证据侧栏" }).click();
            await restore(page, () => page.goBack());
            await browserExpect(dialog.getByText(snapshotId!, { exact: true })).toBeVisible();
            await page.goForward();
            await browserExpect(dialog).toHaveCount(0);
            expect(await count()).toBe(beforeOpen);
            await restore(page, () => page.goBack());
            await restore(page, () => page.reload());
            await browserExpect(
              page.getByRole("dialog", { name: "数字证据", exact: true }),
            ).toContainText(selected.value);
            await browserExpect(page.getByText(snapshotId!, { exact: true })).toBeVisible();
            const shared = await browser.newContext({ viewport });
            try {
              const sharedPage = await shared.newPage();
              observe(sharedPage);
              await restore(sharedPage, () => sharedPage.goto(sharedUrl));
              await browserExpect(sharedPage.getByText(snapshotId!, { exact: true })).toBeVisible();
              await browserExpect(
                sharedPage.getByRole("dialog", { name: "数字证据", exact: true }),
              ).toContainText(selected.value);
              await assertHistoricalRequests(0);
            } finally {
              await shared.close();
            }
            expect(await count()).toBe(beforeOpen);

            // Move the active pointer to a different, validated release without changing A.
            // The shared URL must continue to read the immutable A snapshot.
            const releaseA = requestWindow.data_release_id;
            const releaseB = `SNAPSHOT_TEST_BROWSER_${randomUUID()}`;
            await publisher.query(
              "SELECT logiplan.create_data_release_candidate($1,$1,repeat('0',64),'0009','D-092','test','browser history test',clock_timestamp())",
              [releaseB],
            );
            await publisher.query("SELECT logiplan.mark_data_release_validated($1,$2::jsonb)", [
              releaseB,
              JSON.stringify({ status: "PASS" }),
            ]);
            await publisher.query("SELECT logiplan.activate_data_release($1)", [releaseB]);
            try {
              const historicalUrl = sharedUrl;
              const historicalCount = await totalSnapshotCount();
              const historicalExpected = {
                ...saved,
                warnings: [
                  ...saved.warnings,
                  {
                    code: "HISTORICAL_VERSION" as const,
                    message: "证据快照来自非当前活动数据发布",
                  },
                ],
              };
              expect(selected.data_release_id).toBe(releaseA);
              const assertHistoricalPage = async (target: Page) => {
                const url = new URL(target.url());
                expect(url.searchParams.get("evidence_id")).toBe(selected.evidence_id);
                expect(url.searchParams.get("evidence_snapshot_id")).toBe(
                  selected.evidence_snapshot_id,
                );
                expect(JSON.parse(url.searchParams.get("evidence_scope")!)).toEqual(
                  saved.query_intent.scope,
                );
                await browserExpect(target.getByText(/基于历史版本。/u)).toBeVisible();
                await browserExpect(target.getByText(/已保存的查询证据。/u)).toHaveCount(0);
                const historicalDialog = target.getByRole("dialog", {
                  name: "数字证据",
                  exact: true,
                });
                await browserExpect(historicalDialog).toBeVisible();
                await browserExpect(
                  historicalDialog.getByText(`${selected.value} CNY`, { exact: true }),
                ).toBeVisible();
                for (const value of [
                  selected.data_release_id,
                  selected.evidence_snapshot_id,
                  selected.source_result_id,
                  selected.snapshot_generated_at,
                ])
                  await browserExpect(
                    target.getByText(String(value), { exact: true }),
                  ).toBeVisible();
                expect(await totalSnapshotCount()).toBe(historicalCount);
                expect(
                  (
                    await reader.query(
                      "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id=$1",
                      [selected.evidence_snapshot_id],
                    )
                  ).rows[0]?.result,
                ).toEqual(saved);
              };
              const restoreHistorical = async (target: Page, navigate: () => Promise<unknown>) => {
                const from = requests.length;
                const [response] = await Promise.all([
                  target.waitForResponse(
                    (candidate) =>
                      isQuery(candidate.request()) &&
                      candidate.request().postDataJSON().question_type === "EVIDENCE_LOOKUP",
                  ),
                  navigate(),
                ]);
                await response.finished();
                await assertHistoricalRequests(from, true);
                await assertHistoricalPage(target);
                expect(deterministicResultSchema.parse(await response.json())).toEqual(
                  historicalExpected,
                );
              };
              await restoreHistorical(page, () => page.goto(historicalUrl));
              await restoreHistorical(page, () => page.reload());

              const historicalShared = await browser.newContext({ viewport });
              try {
                const historicalSharedPage = await historicalShared.newPage();
                observe(historicalSharedPage);
                await restoreHistorical(historicalSharedPage, () =>
                  historicalSharedPage.goto(historicalUrl),
                );
                await historicalSharedPage.evaluate(() => {
                  const url = new URL(window.location.href);
                  url.searchParams.set("guide", "3");
                  window.history.pushState({}, "", url);
                });
                await restoreHistorical(historicalSharedPage, () => historicalSharedPage.goBack());
                await restoreHistorical(historicalSharedPage, () =>
                  historicalSharedPage.goForward(),
                );
              } finally {
                await historicalShared.close();
              }
              expect(await totalSnapshotCount()).toBe(historicalCount);
            } finally {
              await publisher.query("SELECT logiplan.activate_data_release($1)", [releaseA]);
            }
          } finally {
            await context.close();
          }
        }
      } finally {
        await Promise.all([reader.end(), publisher.end(), browser.close()]);
      }
    },
    60_000,
  );

  it.skipIf(!process.env.SNAPSHOT_TEST_API_URL)(
    "preserves all six factor source scopes, exact metrics and four-level reconciliation through the real API",
    async () => {
      const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
      const post = async (query: unknown) => {
        const response = await fetch(`${process.env.SNAPSHOT_TEST_API_URL}/api/v1/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(query),
        });
        return { status: response.status, body: await response.json() };
      };
      const sum = (values: string[]) =>
        values.reduce((a, b) => a.plus(b), new LogiPlanDecimal(0)).toFixed();
      const ids = new Set<string>();
      try {
        const bridge = deterministicResultSchema.parse(
          (await post(attributionIntents().bridge)).body,
        ).payload as BridgePayload;
        for (const factor of [undefined, ...FACTORS]) {
          const query = attributionIntents(factor).drilldown;
          const response = await post(query);
          expect(response.status).toBe(200);
          const result = deterministicResultSchema.parse(response.body);
          expect(result.query_intent).toEqual(query);
          ids.add(result.result_id);
          const payload = result.payload as DrilldownPayload;
          expect(payload.primary_contribution).toBe(factor ?? "VARIANCE");
          expect(new Set(payload.rows.map((row) => row.level)).size).toBe(4);
          for (const f of FACTORS) {
            expect(
              sum(
                payload.rows
                  .filter((r) => r.parent_row_id === null)
                  .map((r) => r.factor_contributions[f].high_precision),
              ),
            ).toBe(bridge.factors.find((b) => b.factor_id === f)!.amount.high_precision);
          }
          for (const row of payload.rows) {
            const children = payload.rows.filter((r) => r.parent_row_id === row.row_id);
            for (const field of ["baseline_cost", "current_cost", "variance"] as const)
              if (children.length)
                expect(sum(children.map((c) => c[field].high_precision))).toBe(
                  row[field].high_precision,
                );
            for (const f of FACTORS)
              if (children.length)
                expect(sum(children.map((c) => c.factor_contributions[f].high_precision))).toBe(
                  row.factor_contributions[f].high_precision,
                );
            const base = `ATTRIBUTION_DRILLDOWN:${row.row_id}`;
            for (const [suffix, amount] of [
              ["", row.variance],
              [":BASELINE", row.baseline_cost],
              [":CURRENT", row.current_cost],
              ...FACTORS.map((f) => [`:FACTOR:${f}`, row.factor_contributions[f]] as const),
            ] as const) {
              const item = result.evidence.find((e) => e.evidence_id === base + suffix)!;
              expect(item.value).toBe(amount.high_precision);
              expect(item.source_result_id).toBe(result.result_id);
              expect(item.evidence_snapshot_id).toMatch(/^ES-/u);
            }
          }
          const selected = result.evidence.find(
            (e) =>
              e.evidence_id ===
              `ATTRIBUTION_DRILLDOWN:FC:DE_FC${factor ? `:FACTOR:${factor}` : ""}`,
          )!;
          const snapshotId = selected.evidence_snapshot_id;
          const saved = await reader.query(
            "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id=$1",
            [snapshotId],
          );
          expect(saved.rows[0].result).toEqual(result);
          const history = {
            ...query,
            question_type: "EVIDENCE_LOOKUP",
            metrics: [],
            group_by: [],
            evidence_id: selected.evidence_id,
            evidence_snapshot_id: snapshotId,
          };
          // Count only this exact lookup intent, including its unique snapshot ID.
          const count = async () =>
            (
              await reader.query(
                "SELECT count(*)::int AS n FROM logiplan.evidence_snapshot WHERE result->'query_intent'=$1::jsonb",
                [JSON.stringify(history)],
              )
            ).rows[0].n;
          const before = await count();
          expect((await post(history)).body).toEqual(result);
          expect(await count()).toBe(before);
          for (const wrong of factor ? [undefined, factor === "MIX" ? "PRICE" : "MIX"] : ["MIX"]) {
            expect(
              (await post({ ...history, scope: { ...query.scope, factor_id: wrong } })).body,
            ).toMatchObject({ code: "INVALID_FILTER" });
          }
          expect(
            (await post({ ...history, evidence_snapshot_id: "ES-unknown" })).body,
          ).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
          expect(
            (await post({ ...history, evidence_id: selected.evidence_id + ":unknown" })).body,
          ).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
          const legacy = await post({ ...history, evidence_snapshot_id: undefined });
          expect(legacy.status).toBe(200);
          const legacyResult = deterministicResultSchema.parse(legacy.body);
          expect(legacyResult.query_intent.scope).toEqual(query.scope);
          expect(legacyResult.evidence[0]).toMatchObject({
            evidence_id: selected.evidence_id,
            value: selected.value,
            metric: selected.metric,
            source_result_id: result.result_id,
          });
          expect(legacyResult.evidence[0]?.evidence_snapshot_id).not.toBe(snapshotId);
        }
        expect(ids.size).toBe(6);
      } finally {
        await reader.end();
      }
    },
    60_000,
  );

  it.skipIf(!process.env.SNAPSHOT_TEST_API_URL)(
    "binds factor row evidence to its source snapshot across navigation in both Chromium viewports",
    async () => {
      const { chromium, expect: be } = await import("@playwright/test");
      const browser = await chromium.launch();
      const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
      try {
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 1280, height: 800 },
        ]) {
          const context = await browser.newContext({ viewport });
          try {
            const page = await context.newPage();
            await page.goto(`${process.env.SNAPSHOT_TEST_API_URL}/attribution`);
            const row = page.locator('tr[id="FC:DE_FC"]');
            await be(row).toBeVisible();
            const labels = {
              VOLUME: "量",
              MIX: "结构",
              EFFICIENCY: "效率",
              PRICE: "价",
              FX: "汇率",
            };
            const select = async (factor: (typeof FACTORS)[number]) => {
              const [response] = await Promise.all([
                page.waitForResponse(
                  (r) =>
                    r.url().endsWith("/api/v1/query") &&
                    r.request().postDataJSON()?.question_type === "ATTRIBUTION_DRILLDOWN",
                ),
                page.getByRole("button", { name: new RegExp(`^\\d\\. ${labels[factor]}`) }).click(),
              ]);
              expect(response.status()).toBe(200);
              const result = deterministicResultSchema.parse(await response.json());
              await be(page.getByText("正在更新归因明细…")).toHaveCount(0);
              return result;
            };
            for (const factor of [...FACTORS, undefined]) {
              const source = await select(factor ?? "FX");
              expect(source.query_intent.scope.factor_id).toBe(factor);
              const data = source.payload as DrilldownPayload;
              const target = data.rows.find((r) => r.row_id === "FC:DE_FC")!;
              const amount = factor ? target.factor_contributions[factor] : target.variance;
              const evidenceId = `ATTRIBUTION_DRILLDOWN:FC:DE_FC${factor ? `:FACTOR:${factor}` : ""}`;
              const selected = source.evidence.find((e) => e.evidence_id === evidenceId)!;
              const lookupRequests: QueryIntentV11[] = [];
              const verify = async (targetPage: Page, action: () => Promise<unknown>) => {
                const [response] = await Promise.all([
                  targetPage.waitForResponse(
                    (r) =>
                      r.url().endsWith("/api/v1/query") &&
                      r.request().postDataJSON()?.question_type === "EVIDENCE_LOOKUP",
                  ),
                  action(),
                ]);
                const query = response.request().postDataJSON();
                lookupRequests.push(query);
                expect(query).toMatchObject({
                  evidence_id: evidenceId,
                  evidence_snapshot_id: selected.evidence_snapshot_id,
                  scope: source.query_intent.scope,
                });
                expect(response.status()).toBe(200);
                expect(deterministicResultSchema.parse(await response.json())).toEqual(source);
                await be(targetPage.getByRole("dialog")).toContainText(amount.high_precision);
                const url = new URL(targetPage.url());
                expect(url.searchParams.get("evidence_id")).toBe(evidenceId);
                expect(url.searchParams.get("evidence_snapshot_id")).toBe(
                  selected.evidence_snapshot_id,
                );
                expect(JSON.parse(url.searchParams.get("evidence_scope")!)).toEqual(
                  source.query_intent.scope,
                );
              };
              await verify(page, () =>
                row.getByRole("button", { name: "数字证据", exact: true }).click(),
              );
              const link = page.url();
              await page.getByRole("button", { name: "关闭数字证据侧栏" }).click();
              await verify(page, () => page.goBack());
              await page.goForward();
              await be(page.getByRole("dialog")).toHaveCount(0);
              const shared = await browser.newContext({ viewport });
              try {
                const sharedPage = await shared.newPage();
                await verify(sharedPage, () => sharedPage.goto(link));
                await verify(sharedPage, () => sharedPage.reload());
              } finally {
                await shared.close();
              }
              const inserted = await reader.query(
                "SELECT count(*)::int AS n FROM logiplan.evidence_snapshot WHERE result->'query_intent'=ANY($1::jsonb[])",
                [lookupRequests.map((q) => JSON.stringify(q))],
              );
              expect(inserted.rows[0].n).toBe(0);
            }
            const mix = await select("MIX");
            const [opened] = await Promise.all([
              page.waitForResponse(
                (r) =>
                  r.url().endsWith("/api/v1/query") &&
                  r.request().postDataJSON()?.question_type === "EVIDENCE_LOOKUP",
              ),
              row.getByRole("button", { name: "数字证据", exact: true }).click(),
            ]);
            await opened.finished();
            const original = new URL(page.url());
            await select("PRICE");
            expect(new URL(page.url()).searchParams.get("evidence_scope")).toBe(
              original.searchParams.get("evidence_scope"),
            );
            expect(new URL(page.url()).searchParams.get("evidence_snapshot_id")).toBe(
              original.searchParams.get("evidence_snapshot_id"),
            );
            await be(page.getByRole("dialog")).toContainText("证据范围与当前页面不同");
            await be(page.getByRole("dialog")).toContainText(
              mix.evidence.find((e) => e.evidence_id.endsWith("FC:DE_FC:FACTOR:MIX"))!.value,
            );
            await page.getByRole("button", { name: "关闭数字证据侧栏" }).click();
            expect(new URL(page.url()).searchParams.get("factor")).toBe("PRICE");
          } finally {
            await context.close();
          }
        }
      } finally {
        await Promise.all([reader.end(), browser.close()]);
      }
    },
    120_000,
  );

  it.skipIf(!process.env.SNAPSHOT_TEST_API_URL)(
    "blocks stale row evidence while factor requests are gated and rejects late responses",
    async () => {
      const { chromium, expect: be } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        for (const width of [1440, 1280]) {
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            // Deliberately make cancellation ineffective to exercise sequence/scope protection.
            await context.addInitScript(() => {
              const original = window.fetch;
              window.fetch = (input, init) => {
                if (
                  typeof init?.body === "string" &&
                  JSON.parse(init.body).question_type === "ATTRIBUTION_DRILLDOWN"
                )
                  return original(input, { ...init, signal: null });
                return original(input, init);
              };
            });
            const page = await context.newPage();
            await page.goto(`${process.env.SNAPSHOT_TEST_API_URL}/attribution`);
            const row = page.locator('tr[id="FC:DE_FC"]');
            await be(row).toBeVisible();
            let releaseMix!: () => void;
            let releasePrice!: () => void;
            let mixArrived!: () => void;
            let priceArrived!: () => void;
            const mixGate = new Promise<void>((resolve) => {
              releaseMix = resolve;
            });
            const priceGate = new Promise<void>((resolve) => {
              releasePrice = resolve;
            });
            const mixReady = new Promise<void>((resolve) => {
              mixArrived = resolve;
            });
            const priceReady = new Promise<void>((resolve) => {
              priceArrived = resolve;
            });
            await page.route("**/api/v1/query", async (route) => {
              const query = route.request().postDataJSON();
              if (query.question_type !== "ATTRIBUTION_DRILLDOWN") return route.continue();
              const response = await route.fetch();
              if (query.scope.factor_id === "MIX") {
                mixArrived();
                await mixGate;
              }
              if (query.scope.factor_id === "PRICE") {
                priceArrived();
                await priceGate;
              }
              await route.fulfill({ response });
            });
            try {
              await page.getByRole("button", { name: /^2\. 结构/u }).click();
              await mixReady;
              await be(row.getByRole("button", { name: "数字证据", exact: true })).toBeDisabled();
              await page.getByRole("button", { name: /^4\. 价/u }).click();
              await priceReady;
              await be(row.getByRole("button", { name: "数字证据", exact: true })).toBeDisabled();
              const priceResponse = page.waitForResponse(
                (r) =>
                  r.url().endsWith("/api/v1/query") &&
                  r.request().postDataJSON()?.scope.factor_id === "PRICE",
              );
              releasePrice();
              const price = deterministicResultSchema.parse(await (await priceResponse).json());
              await be(page.getByText("正在更新归因明细…")).toHaveCount(0);
              const mixResponse = page.waitForResponse(
                (r) =>
                  r.url().endsWith("/api/v1/query") &&
                  r.request().postDataJSON()?.scope.factor_id === "MIX",
              );
              releaseMix();
              await (await mixResponse).finished();
              const [evidenceResponse] = await Promise.all([
                page.waitForResponse(
                  (r) =>
                    r.url().endsWith("/api/v1/query") &&
                    r.request().postDataJSON()?.question_type === "EVIDENCE_LOOKUP",
                ),
                row.getByRole("button", { name: "数字证据", exact: true }).click(),
              ]);
              expect(evidenceResponse.request().postDataJSON()).toMatchObject({
                evidence_id: "ATTRIBUTION_DRILLDOWN:FC:DE_FC:FACTOR:PRICE",
                evidence_snapshot_id: price.evidence[0]?.evidence_snapshot_id,
                scope: price.query_intent.scope,
              });
            } finally {
              releaseMix();
              releasePrice();
            }
          } finally {
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
    },
    90_000,
  );

  it("saves all supported dispatches, including unmaterialized scopes and legacy lookups", async () => {
    const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
    const observer = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
    try {
      expect(releaseEvidenceSnapshotIntents.map((item) => item.question_type).sort()).toEqual([
        "ATTRIBUTION_BRIDGE",
        "ATTRIBUTION_DRILLDOWN",
        "COUNTRY_VARIANCE_SUMMARY",
        "DASHBOARD_OVERVIEW",
        "DIAGNOSTIC_METRICS",
        "FIXED_COST_BREAKDOWN",
        "MONTHLY_COST_TREND",
        "TOP_ADVERSE_ANOMALIES",
        "WAREHOUSE_VARIANCE_CONTEXT",
      ]);
      const queries = [
        ...releaseEvidenceSnapshotIntents,
        { ...intent, scope: { ...intent.scope, destination_country_ids: ["DE"] } },
        { ...lookup("unused"), evidence_snapshot_id: undefined },
      ];
      for (const query of queries) {
        const before = (
          await observer.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot")
        ).rows[0].count;
        const first = deterministicResultSchema.parse(
          await runDeterministicQuery(reader, query, `dispatch-${query.question_type}`),
        );
        const second = deterministicResultSchema.parse(
          await runDeterministicQuery(reader, query, `repeat-${query.question_type}`),
        );
        expect(first.evidence.length).toBeGreaterThan(0);
        expect(first.result_id).toBe(second.result_id);
        expect(first.evidence[0]?.evidence_snapshot_id).not.toBe(
          second.evidence[0]?.evidence_snapshot_id,
        );
        for (const result of [first, second]) {
          const item = result.evidence[0]!;
          expect(
            result.evidence.every(
              (e) =>
                e.evidence_snapshot_id === item.evidence_snapshot_id &&
                e.data_release_id === "LOGIPLAN_2026_DEMO_V2",
            ),
          ).toBe(true);
          expect(
            (
              await observer.query(
                "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id=$1",
                [item.evidence_snapshot_id],
              )
            ).rows[0]?.result,
          ).toEqual(result);
          const restored = await runDeterministicQuery(
            reader,
            {
              ...query,
              question_type: "EVIDENCE_LOOKUP",
              metrics: [],
              group_by: [],
              top_n: undefined,
              evidence_id: item.evidence_id,
              evidence_snapshot_id: item.evidence_snapshot_id,
            },
            "history-dispatch",
          );
          if ("code" in restored)
            throw new Error(`${query.question_type} history: ${restored.code}`);
          expect(restored).toEqual(result);
          if (query.question_type === "EVIDENCE_LOOKUP")
            expect(result.payload).toEqual({ evidence: item });
        }
        expect(
          (await observer.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot"))
            .rows[0].count,
        ).toBe(before + 2);
      }
    } finally {
      await Promise.all([reader.end(), observer.end()]);
    }
  }, 30_000);

  it("enforces realtime function privileges, input binding and publisher idempotence", async () => {
    const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
    const publisher = new Pool({ connectionString: process.env.SNAPSHOT_TEST_PUBLISHER_URL });
    try {
      const privileges = await reader.query(`SELECT
        has_function_privilege(current_user, 'logiplan.persist_query_evidence_snapshot(jsonb)', 'EXECUTE') AS realtime,
        has_function_privilege(current_user, 'logiplan.activate_data_release(text)', 'EXECUTE') AS activate,
        has_table_privilege(current_user, 'logiplan.evidence_snapshot', 'INSERT,UPDATE,DELETE,TRUNCATE') AS direct_write,
        EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a
          WHERE p.oid = 'logiplan.persist_query_evidence_snapshot(jsonb)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute`);
      expect(privileges.rows[0]).toEqual({
        realtime: true,
        activate: false,
        direct_write: false,
        public_execute: false,
      });
      await expect(
        publisher.query("SELECT logiplan.persist_query_evidence_snapshot('{}')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        reader.query("SELECT logiplan.activate_data_release('forbidden')"),
      ).rejects.toMatchObject({ code: "42501" });
      const v10Intent: Record<string, unknown> = { ...intent };
      delete v10Intent.contract_version;
      const source = deterministicResultSchema.parse(
        await runDeterministicQuery(reader, v10Intent, "fixture-from-facts"),
      );
      expect(
        source.evidence.every(
          (item) => item.evidence_snapshot_id === undefined && item.data_release_id === undefined,
        ),
      ).toBe(true);
      const valid = {
        ...source,
        contract_version: "V1.1",
        query_intent: intent,
        result_id: resultId(intent),
        _data_release_id: "LOGIPLAN_2026_DEMO_V2",
      };
      const invalid: Array<[unknown, string]> = [
        [{}, "22023"],
        [{ ...valid, warnings: {} }, "22023"],
        [{ ...valid, query_intent: { contract_version: "V1.1", scope: {} } }, "22023"],
        [{ ...valid, payload: "invalid" }, "22023"],
        [{ ...valid, _data_release_id: "forged-release" }, "40001"],
        [{ ...valid, evidence_snapshot_id: "ES-forged" }, "22023"],
        [
          { ...valid, evidence: [{ ...source.evidence[0], evidence_snapshot_id: "ES-forged" }] },
          "22023",
        ],
        [{ ...valid, payload: { padding: "x".repeat(8388608) } }, "22023"],
      ];
      const before = (
        await reader.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot")
      ).rows[0].count;
      for (const [input, code] of invalid) {
        const client = await reader.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await expect(
            client.query("SELECT logiplan.persist_query_evidence_snapshot($1::jsonb)", [
              JSON.stringify(input),
            ]),
          ).rejects.toMatchObject({ code });
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
      expect(
        (await reader.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot"))
          .rows[0].count,
      ).toBe(before);
      // A query outside the realtime REPEATABLE READ entry is rejected too.
      await expect(
        reader.query("SELECT logiplan.persist_query_evidence_snapshot($1::jsonb)", [
          JSON.stringify(valid),
        ]),
      ).rejects.toMatchObject({ code: "25001" });
      const writer = await publisher.connect();
      try {
        await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await materializeEvidenceSnapshots(writer, [intent]);
        await materializeEvidenceSnapshots(writer, [intent]);
        await writer.query("COMMIT");
      } catch (cause) {
        await writer.query("ROLLBACK");
        throw cause;
      } finally {
        writer.release();
      }
      expect(
        (await reader.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot"))
          .rows[0].count,
      ).toBe(before);
    } finally {
      await Promise.all([reader.end(), publisher.end()]);
    }
  }, 30_000);

  it("rolls back real snapshot INSERTs on save-return or pre-commit failure and releases clients", async () => {
    const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL, max: 1 });
    const observer = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
    try {
      for (const failure of ["business", "save", "saved-result", "commit"]) {
        const before = (
          await observer.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot")
        ).rows[0].count;
        let inserted = false;
        let released = false;
        const decorated = {
          connect: async () => {
            const client = await reader.connect();
            return {
              query: async (sql: string, params?: unknown[]) => {
                if (failure === "business" && sql.includes("AS variable_cost"))
                  return client.query("SELECT 1/0");
                if (failure === "save" && sql.includes("persist_query_evidence_snapshot"))
                  return client.query(sql, ["{}"]);
                if (failure === "commit" && sql === "COMMIT") {
                  expect(inserted).toBe(true);
                  throw new Error("injected before COMMIT dispatch");
                }
                const result = await client.query(sql, params);
                if (sql.includes("persist_query_evidence_snapshot")) {
                  inserted = true;
                  expect(
                    (
                      await observer.query(
                        "SELECT count(*)::int AS count FROM logiplan.evidence_snapshot",
                      )
                    ).rows[0].count,
                  ).toBe(before);
                  if (failure === "saved-result") return { ...result, rows: [{ result: {} }] };
                }
                return result;
              },
              release: (error?: Error) => {
                released = true;
                client.release(error);
              },
            };
          },
        } as unknown as Pool;
        await expect(runDeterministicQuery(decorated, intent, failure)).rejects.toThrow();
        expect(released).toBe(true);
        expect(reader.waitingCount).toBe(0);
        expect(
          (await observer.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot"))
            .rows[0].count,
        ).toBe(before);
        expect((await reader.query("SELECT 1 AS ready")).rows[0].ready).toBe(1);
      }
    } finally {
      await Promise.all([reader.end(), observer.end()]);
    }
  });

  it("binds facts and saved result to A when B activates after the transaction reads A", async () => {
    const reader = new Pool({ connectionString: process.env.SNAPSHOT_TEST_DATABASE_URL });
    const publisher = new Pool({ connectionString: process.env.SNAPSHOT_TEST_PUBLISHER_URL });
    const releaseB = `SNAPSHOT_CONCURRENT_${randomUUID()}`;
    const releaseA = "LOGIPLAN_2026_DEMO_V2";
    try {
      await publisher.query(
        "SELECT logiplan.create_data_release_candidate($1,$1,repeat('0',64),'0010','D-092','test','snapshot concurrency',clock_timestamp())",
        [releaseB],
      );
      await publisher.query("SELECT logiplan.mark_data_release_validated($1,$2::jsonb)", [
        releaseB,
        JSON.stringify({ status: "PASS" }),
      ]);
      let switched = false;
      const decorated = {
        connect: async () => {
          const client = await reader.connect();
          return {
            query: async (sql: string, params?: unknown[]) => {
              const result = await client.query(sql, params);
              if (sql === "SELECT data_release_id FROM logiplan.active_release") {
                expect(result.rows[0]?.data_release_id).toBe(releaseA);
                await publisher.query("SELECT logiplan.activate_data_release($1)", [releaseB]);
                switched = true;
                expect(
                  (await reader.query("SELECT data_release_id FROM logiplan.active_release"))
                    .rows[0]?.data_release_id,
                ).toBe(releaseB);
              }
              return result;
            },
            release: (error?: Error) => client.release(error),
          };
        },
      } as unknown as Pool;
      const result = deterministicResultSchema.parse(
        await runDeterministicQuery(decorated, intent, "concurrent"),
      );
      expect(switched).toBe(true);
      expect(result.payload).toMatchObject({ variance: { report: "574474.2232" } });
      expect(result.evidence[0]?.data_release_id).toBe(releaseA);
      const snapshotId = result.evidence[0]!.evidence_snapshot_id!;
      const persistedBefore = (
        await reader.query(
          "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id=$1",
          [snapshotId],
        )
      ).rows[0].result;
      expect(persistedBefore).toEqual(result);
      const count = (
        await reader.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot")
      ).rows[0].count;
      const historical = deterministicResultSchema.parse(
        await runDeterministicQuery(reader, lookup(snapshotId), "old-A"),
      );
      const { warnings: originalWarnings, ...originalFields } = result;
      const { warnings: historicalWarnings, ...historicalFields } = historical;
      expect(historicalFields).toEqual(originalFields);
      expect(historicalWarnings).toEqual([
        ...originalWarnings,
        { code: "HISTORICAL_VERSION", message: "证据快照来自非当前活动数据发布" },
      ]);
      expect(
        historicalWarnings.filter((warning) => warning.code === "HISTORICAL_VERSION"),
      ).toHaveLength(1);
      expect(
        (
          await reader.query(
            "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id=$1",
            [snapshotId],
          )
        ).rows[0].result,
      ).toEqual(persistedBefore);
      expect(
        (await reader.query("SELECT count(*)::int AS count FROM logiplan.evidence_snapshot"))
          .rows[0].count,
      ).toBe(count);
    } finally {
      await publisher.query("SELECT logiplan.activate_data_release($1)", [releaseA]);
      await Promise.all([reader.end(), publisher.end()]);
    }
  }, 30_000);
});
