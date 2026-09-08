import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
  type Response,
} from "@playwright/test";
import {
  deterministicResultSchema,
  type AnalysisScope,
  type DeterministicResultEnvelope,
  type EvidenceObject,
  type QueryIntentV11,
} from "@logiplan/contracts";
import { createReadOnlyPool } from "@logiplan/db";

type PoolConnectCallback = NonNullable<
  Parameters<ReturnType<typeof createReadOnlyPool>["connect"]>[0]
>;
type PoolClient = NonNullable<Parameters<PoolConnectCallback>[1]>;

const BASE_URL = process.env.ISSUE6_TEST_BASE_URL ?? "http://127.0.0.1:4173";
const REQUIRED_ENV = ["DATABASE_URL", "SNAPSHOT_TEST_SUPERUSER_URL"] as const;
const EVIDENCE_PARAMS = ["evidence_id", "evidence_snapshot_id", "evidence_scope"] as const;

const sourceScope: AnalysisScope = {
  period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
  comparison: "ACTUAL_VS_BUDGET",
  destination_country_ids: ["GB"],
  budget_version_id: "BUDGET_2026_V1",
  actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
  calculation_version: "D-092",
  factor_id: "MIX",
};

const sourceIntent: QueryIntentV11 = {
  contract_version: "V1.1",
  question_type: "ATTRIBUTION_DRILLDOWN",
  scope: sourceScope,
  metrics: ["FULFILLMENT_VARIABLE_COST"],
  group_by: ["FULFILLMENT_CENTER", "TRANSPORT_MODE", "CARRIER", "COST_COMPONENT"],
  output_locale: "zh-CN",
  context_sources: ["FIXED_TEMPLATE"],
};

type RouteCase = {
  path: "/" | "/attribution";
  currentHeading: string;
  preserved: Record<string, string>;
};

const routeCases: RouteCase[] = [
  {
    path: "/",
    currentHeading: "预算执行驾驶舱",
    preserved: { guide: "2", campaign: "issue6" },
  },
  {
    path: "/attribution",
    currentHeading: "英国履约变动成本归因",
    preserved: {
      period: "2026-08",
      comparison: "ACTUAL_VS_BUDGET",
      destination: "GB",
      budget: "BUDGET_2026_V1",
      actual: "ACTUAL_2026_08_CLOSE_V1",
      method: "CHAIN",
      factor: "PRICE",
      path: "FC:DE_FC~FC:DE_FC/MODE:AIR",
    },
  },
];

function configured(name: (typeof REQUIRED_ENV)[number]): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for issue 6 acceptance`);
  return value;
}

function isolatedUrl(name: string, raw: string): URL {
  const url = new URL(raw);
  expect(["127.0.0.1", "localhost"], `${name} must be local`).toContain(url.hostname);
  expect(url.port, `${name} must use an explicit isolated database port`).not.toBe("");
  return url;
}

function isLookup(response: Response, snapshotId?: string): boolean {
  if (
    response.request().method() !== "POST" ||
    new URL(response.url()).pathname !== "/api/v1/query"
  )
    return false;
  const body = response.request().postDataJSON() as Partial<QueryIntentV11> | null;
  return (
    body?.question_type === "EVIDENCE_LOOKUP" &&
    (snapshotId === undefined || body.evidence_snapshot_id === snapshotId)
  );
}

function lookupIntent(result: DeterministicResultEnvelope, item: EvidenceObject): QueryIntentV11 {
  return {
    contract_version: "V1.1",
    question_type: "EVIDENCE_LOOKUP",
    scope: result.query_intent.scope,
    metrics: [],
    group_by: [],
    output_locale: "zh-CN",
    context_sources: ["PAGE_VISIBLE_STATE", "FIXED_TEMPLATE"],
    evidence_id: item.evidence_id,
    evidence_snapshot_id: item.evidence_snapshot_id!,
  };
}

function evidenceUrl(
  route: RouteCase,
  result: DeterministicResultEnvelope,
  item: EvidenceObject,
): string {
  const url = new URL(route.path, BASE_URL);
  for (const [key, value] of Object.entries(route.preserved)) url.searchParams.set(key, value);
  url.searchParams.set("evidence_id", item.evidence_id);
  url.searchParams.set("evidence_snapshot_id", item.evidence_snapshot_id!);
  url.searchParams.set("evidence_scope", JSON.stringify(result.query_intent.scope));
  return url.toString();
}

function analysisUrl(route: RouteCase): string {
  const url = new URL(route.path, BASE_URL);
  for (const [key, value] of Object.entries(route.preserved)) url.searchParams.set(key, value);
  return url.toString();
}

async function navigateAndWaitForLookup(
  page: Page,
  navigate: () => Promise<unknown>,
  snapshotId: string,
): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => isLookup(candidate, snapshotId)),
    navigate(),
  ]);
  await response.finished();
  return response;
}

async function expectEvidence(
  page: Page,
  result: DeterministicResultEnvelope,
  item: EvidenceObject,
  historical: boolean,
): Promise<void> {
  await expect(page.getByRole("heading", { name: "历史数字证据" })).toBeVisible();
  await expect(page.getByText(/基于历史版本。/u)).toHaveCount(historical ? 1 : 0);
  await expect(page.getByText(/已保存的查询证据。/u)).toHaveCount(historical ? 0 : 1);
  const dialog = page.getByRole("dialog", { name: "数字证据", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`${item.value} ${item.unit}`, { exact: true })).toBeVisible();
  for (const value of [
    item.source_result_id,
    item.data_release_id,
    item.evidence_snapshot_id,
    item.snapshot_generated_at,
  ])
    await expect(dialog.getByText(String(value), { exact: true })).toBeVisible();
  const url = new URL(page.url());
  expect(url.searchParams.get("evidence_id")).toBe(item.evidence_id);
  expect(url.searchParams.get("evidence_snapshot_id")).toBe(item.evidence_snapshot_id);
  expect(JSON.parse(url.searchParams.get("evidence_scope")!)).toEqual(result.query_intent.scope);
}

test.describe("issue 6 independent historical evidence view", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Issue 6 is a Chromium matrix");
  test.skip(
    REQUIRED_ENV.some((name) => !process.env[name]),
    "Issue 6 requires the isolated PostgreSQL URLs",
  );
  test.setTimeout(300_000);

  let reader: ReturnType<typeof createReadOnlyPool>;
  let superuser: ReturnType<typeof createReadOnlyPool>;
  let lockClient: PoolClient | undefined;
  let api: APIRequestContext | undefined;
  let activeRelease: { data_release_id: string; activated_at: string };
  let activeReleaseRecordActivatedAt: string;
  let resultA: DeterministicResultEnvelope;
  let resultB: DeterministicResultEnvelope;
  let evidenceA: EvidenceObject;
  let evidenceB: EvidenceObject;

  const snapshotCount = async () =>
    (
      await reader.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM logiplan.evidence_snapshot",
      )
    ).rows[0]!.count;

  const persisted = async (snapshotId: string) =>
    (
      await reader.query<{ result: unknown }>(
        "SELECT result FROM logiplan.evidence_snapshot WHERE evidence_snapshot_id=$1",
        [snapshotId],
      )
    ).rows[0]!.result;

  const captureState = async () => ({
    count: await snapshotCount(),
    a: await persisted(evidenceA.evidence_snapshot_id!),
    b: await persisted(evidenceB.evidence_snapshot_id!),
  });

  const expectState = async (before: Awaited<ReturnType<typeof captureState>>) => {
    expect(await snapshotCount()).toBe(before.count);
    expect(await persisted(evidenceA.evidence_snapshot_id!)).toEqual(before.a);
    expect(await persisted(evidenceB.evidence_snapshot_id!)).toEqual(before.b);
  };

  const ensureActiveRelease = async () => {
    const current = await superuser.query<{ data_release_id: string }>(
      "SELECT data_release_id FROM logiplan.active_data_release WHERE singleton",
    );
    if (current.rows[0]?.data_release_id === activeRelease.data_release_id) return;
    if (current.rowCount !== 0)
      throw new Error(`Unexpected active release ${current.rows[0]?.data_release_id}`);
    await superuser.query(
      `INSERT INTO logiplan.active_data_release(singleton,data_release_id,activated_at)
       VALUES (true,$1,$2::timestamptz)`,
      [activeRelease.data_release_id, activeRelease.activated_at],
    );
  };

  const expectSuccessfulLookup = async (
    response: Response,
    result: DeterministicResultEnvelope,
    item: EvidenceObject,
  ) => {
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual(lookupIntent(result, item));
    expect(deterministicResultSchema.parse(await response.json())).toMatchObject({
      result_id: result.result_id,
      query_intent: result.query_intent,
      evidence: expect.arrayContaining([
        expect.objectContaining({
          evidence_id: item.evidence_id,
          evidence_snapshot_id: item.evidence_snapshot_id,
          data_release_id: item.data_release_id,
          source_result_id: item.source_result_id,
        }),
      ]),
    });
  };

  test.beforeAll(async () => {
    const database = isolatedUrl("DATABASE_URL", configured("DATABASE_URL"));
    const admin = isolatedUrl(
      "SNAPSHOT_TEST_SUPERUSER_URL",
      configured("SNAPSHOT_TEST_SUPERUSER_URL"),
    );
    expect(admin.pathname).toBe(database.pathname);
    expect(admin.port).toBe(database.port);
    expect(["127.0.0.1", "localhost"]).toContain(new URL(BASE_URL).hostname);
    reader = createReadOnlyPool(database.toString());
    superuser = createReadOnlyPool(admin.toString());
    lockClient = await superuser.connect();
    await lockClient.query("SET statement_timeout=0");
    await lockClient.query(
      "SELECT pg_advisory_lock(hashtextextended('logiplan-issue6-browser-state-v1',0))",
    );
    const originalRelease = (
      await superuser.query<{
        data_release_id: string;
        activated_at: string;
        release_activated_at: string;
      }>(
        `SELECT a.data_release_id,
                a.activated_at::text AS activated_at,
                r.activated_at::text AS release_activated_at
         FROM logiplan.active_data_release AS a
         JOIN logiplan.data_release AS r USING (data_release_id)
         WHERE a.singleton`,
      )
    ).rows[0]!;
    activeRelease = {
      data_release_id: originalRelease.data_release_id,
      activated_at: originalRelease.activated_at,
    };
    activeReleaseRecordActivatedAt = originalRelease.release_activated_at;
    api = await playwrightRequest.newContext({ baseURL: BASE_URL });
    const createSnapshot = async () => {
      const response = await api!.post("/api/v1/query", { data: sourceIntent });
      expect(response.status()).toBe(200);
      return deterministicResultSchema.parse(await response.json());
    };
    resultA = await createSnapshot();
    resultB = await createSnapshot();
    const select = (result: DeterministicResultEnvelope) => {
      const item =
        result.evidence.find((candidate) => candidate.evidence_id.endsWith(":FACTOR:MIX")) ??
        result.evidence[0];
      if (!item?.evidence_snapshot_id) throw new Error("Issue 6 source snapshot is incomplete");
      return item;
    };
    evidenceA = select(resultA);
    evidenceB = select(resultB);
    expect(evidenceA.evidence_snapshot_id).not.toBe(evidenceB.evidence_snapshot_id);
  });

  test.beforeEach(async () => ensureActiveRelease());
  test.afterEach(async () => ensureActiveRelease());

  test.afterAll(async () => {
    try {
      if (activeRelease) await ensureActiveRelease();
      if (lockClient)
        await lockClient.query(
          "SELECT pg_advisory_unlock(hashtextextended('logiplan-issue6-browser-state-v1',0))",
        );
    } finally {
      lockClient?.release();
      await Promise.all([api?.dispose(), reader?.end(), superuser?.end()]);
    }
  });

  for (const route of routeCases) {
    test(`${route.path} uses complete source scope and close/back/forward restore the right view`, async ({
      page,
    }) => {
      const before = await captureState();
      const response = await navigateAndWaitForLookup(
        page,
        () => page.goto(evidenceUrl(route, resultA, evidenceA)),
        evidenceA.evidence_snapshot_id!,
      );
      await expectSuccessfulLookup(response, resultA, evidenceA);
      await expectEvidence(page, resultA, evidenceA, false);
      expect(response.request().postDataJSON()).toMatchObject({ scope: { factor_id: "MIX" } });
      expect(new URL(page.url()).searchParams.get("factor")).toBe(
        route.path === "/attribution" ? "PRICE" : null,
      );
      await expectState(before);

      await page.getByRole("link", { name: "返回当前分析", exact: true }).click();
      await expect(page.getByRole("heading", { name: route.currentHeading })).toBeVisible();
      const returned = new URL(page.url());
      for (const key of EVIDENCE_PARAMS) expect(returned.searchParams.has(key)).toBe(false);
      for (const [key, value] of Object.entries(route.preserved))
        expect(returned.searchParams.get(key)).toBe(value);
      expect([...returned.searchParams.keys()].sort()).toEqual(Object.keys(route.preserved).sort());

      const returnedEvidence = await navigateAndWaitForLookup(
        page,
        () => page.goBack(),
        evidenceA.evidence_snapshot_id!,
      );
      await expectSuccessfulLookup(returnedEvidence, resultA, evidenceA);
      await expectEvidence(page, resultA, evidenceA, false);

      await page.getByRole("button", { name: "关闭数字证据", exact: true }).click();
      await expect(page.getByRole("heading", { name: route.currentHeading })).toBeVisible();
      const closed = new URL(page.url());
      for (const key of EVIDENCE_PARAMS) expect(closed.searchParams.has(key)).toBe(false);
      for (const [key, value] of Object.entries(route.preserved))
        expect(closed.searchParams.get(key)).toBe(value);
      expect([...closed.searchParams.keys()].sort()).toEqual(Object.keys(route.preserved).sort());

      const restored = await navigateAndWaitForLookup(
        page,
        () => page.goBack(),
        evidenceA.evidence_snapshot_id!,
      );
      await expectSuccessfulLookup(restored, resultA, evidenceA);
      await expectEvidence(page, resultA, evidenceA, false);
      await page.goForward();
      await expect(page.getByRole("heading", { name: route.currentHeading })).toBeVisible();
    });

    test(`${route.path} serves saved evidence when missing active release makes ordinary SSR fail`, async ({
      page,
    }) => {
      await superuser.query("DELETE FROM logiplan.active_data_release WHERE singleton");
      try {
        expect((await reader.query("SELECT * FROM logiplan.active_release")).rowCount).toBe(0);
        await page.goto(analysisUrl(route));
        await expect(page.getByRole("heading", { name: "分析工作台暂时不可用" })).toBeVisible();
        await expect(page.getByRole("heading", { name: route.currentHeading })).toHaveCount(0);
        const before = await captureState();
        const documentPromise = page.waitForResponse(
          (response) =>
            response.request().resourceType() === "document" &&
            new URL(response.url()).pathname === route.path,
        );
        const lookup = await navigateAndWaitForLookup(
          page,
          () => page.goto(evidenceUrl(route, resultA, evidenceA)),
          evidenceA.evidence_snapshot_id!,
        );
        expect((await documentPromise).status()).toBe(200);
        await expectSuccessfulLookup(lookup, resultA, evidenceA);
        await expectEvidence(page, resultA, evidenceA, true);
        await expectState(before);
      } finally {
        await ensureActiveRelease();
      }
      const restored = (
        await superuser.query<{ data_release_id: string; activated_at: string }>(
          `SELECT data_release_id, activated_at::text AS activated_at
             FROM logiplan.active_data_release WHERE singleton`,
        )
      ).rows[0]!;
      expect(restored).toEqual(activeRelease);
    });
  }

  test("server-rendered return links preserve non-evidence parameters before client effects run", async ({
    browser,
  }) => {
    for (const route of routeCases) {
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        await page.goto(evidenceUrl(route, resultA, evidenceA));
        const returnLink = page.getByRole("link", { name: "返回当前分析", exact: true });
        const href = await returnLink.getAttribute("href");
        const target = new URL(href!, BASE_URL);
        expect(target.pathname).toBe(route.path);
        for (const key of EVIDENCE_PARAMS) expect(target.searchParams.has(key)).toBe(false);
        for (const [key, value] of Object.entries(route.preserved))
          expect(target.searchParams.get(key)).toBe(value);
        expect([...target.searchParams.keys()].sort()).toEqual(Object.keys(route.preserved).sort());
        // With JavaScript disabled, clicking would start ordinary streamed analysis
        // that cannot hydrate to completion. The normal-JS route matrix owns the
        // actual return-link navigation assertion without leaking background queries.
      } finally {
        await context.close();
      }
    }
  });

  test("/ restores release A after release B activation, reload and a fresh-context share", async ({
    browser,
    page,
  }) => {
    const route = routeCases[0]!;
    const beforePreparation = await captureState();
    let historicalBaseline = beforePreparation;
    const sharedUrl = evidenceUrl(route, resultA, evidenceA);
    const releaseB = `ISSUE6_BROWSER_${randomUUID()}`;
    const releaseBSnapshots = async () =>
      (
        await reader.query<{
          evidence_snapshot_id: string;
          result_id: string;
          question_type: string;
          created_at: string;
        }>(
          `SELECT evidence_snapshot_id,
                  result->>'result_id' AS result_id,
                  result->'query_intent'->>'question_type' AS question_type,
                  created_at::text AS created_at
           FROM logiplan.evidence_snapshot
           WHERE data_release_id=$1
           ORDER BY created_at, evidence_snapshot_id`,
          [releaseB],
        )
      ).rows;
    const stateClient = await superuser.connect();
    let releaseBCreated = false;
    try {
      const created = await stateClient.query(
        `SELECT logiplan.create_data_release_candidate(
           $1,$1,repeat('0',64),r.database_schema_version,r.calculation_version,
           'issue6-browser','issue6 historical route acceptance',clock_timestamp()
         )
         FROM logiplan.data_release AS r
         WHERE r.data_release_id=$2`,
        [releaseB, activeRelease.data_release_id],
      );
      releaseBCreated = created.rowCount === 1;
      expect(created.rowCount).toBe(1);
      await stateClient.query("SELECT logiplan.mark_data_release_validated($1,$2::jsonb)", [
        releaseB,
        JSON.stringify({ status: "PASS", test: "issue6-browser" }),
      ]);
      await stateClient.query("SELECT logiplan.activate_data_release($1)", [releaseB]);
      const afterPreparation = await captureState();
      // Direct activate_data_release only changes release state. Publisher-side
      // materialization is a separate application workflow and is not called here.
      expect(afterPreparation.count).toBe(beforePreparation.count);
      expect(afterPreparation.a).toEqual(beforePreparation.a);
      expect(afterPreparation.b).toEqual(beforePreparation.b);
      expect(await releaseBSnapshots()).toEqual([]);
      historicalBaseline = afterPreparation;
      expect(
        (
          await reader.query<{ data_release_id: string }>(
            "SELECT data_release_id FROM logiplan.active_release",
          )
        ).rows[0]?.data_release_id,
      ).toBe(releaseB);

      const initial = await navigateAndWaitForLookup(
        page,
        () => page.goto(sharedUrl),
        evidenceA.evidence_snapshot_id!,
      );
      await expectSuccessfulLookup(initial, resultA, evidenceA);
      await expectEvidence(page, resultA, evidenceA, true);

      const refreshed = await navigateAndWaitForLookup(
        page,
        () => page.reload(),
        evidenceA.evidence_snapshot_id!,
      );
      await expectSuccessfulLookup(refreshed, resultA, evidenceA);
      await expectEvidence(page, resultA, evidenceA, true);

      const viewport = page.viewportSize();
      const shared = await browser.newContext(viewport ? { viewport } : {});
      try {
        const sharedPage = await shared.newPage();
        const sharedResponse = await navigateAndWaitForLookup(
          sharedPage,
          () => sharedPage.goto(sharedUrl),
          evidenceA.evidence_snapshot_id!,
        );
        await expectSuccessfulLookup(sharedResponse, resultA, evidenceA);
        await expectEvidence(sharedPage, resultA, evidenceA, true);
      } finally {
        await shared.close();
      }
      expect(await releaseBSnapshots()).toEqual([]);
      await expectState(historicalBaseline);
    } finally {
      try {
        await stateClient.query("BEGIN");
        await stateClient.query("SELECT logiplan.activate_data_release($1)", [
          activeRelease.data_release_id,
        ]);
        await stateClient.query(
          `UPDATE logiplan.data_release SET activated_at=$2::timestamptz
           WHERE data_release_id=$1`,
          [activeRelease.data_release_id, activeReleaseRecordActivatedAt],
        );
        await stateClient.query(
          `UPDATE logiplan.active_data_release SET activated_at=$2::timestamptz
           WHERE singleton AND data_release_id=$1`,
          [activeRelease.data_release_id, activeRelease.activated_at],
        );
        if (releaseBCreated)
          await stateClient.query("DELETE FROM logiplan.data_release WHERE data_release_id=$1", [
            releaseB,
          ]);
        await stateClient.query("COMMIT");
      } catch (cause) {
        await stateClient.query("ROLLBACK");
        throw cause;
      } finally {
        stateClient.release();
      }
    }
    expect(
      (
        await superuser.query<{ data_release_id: string; activated_at: string }>(
          `SELECT data_release_id, activated_at::text AS activated_at
           FROM logiplan.active_data_release WHERE singleton`,
        )
      ).rows[0],
    ).toEqual(activeRelease);
    expect(
      (
        await superuser.query<{ activated_at: string }>(
          `SELECT activated_at::text AS activated_at
           FROM logiplan.data_release WHERE data_release_id=$1`,
          [activeRelease.data_release_id],
        )
      ).rows[0]?.activated_at,
    ).toBe(activeReleaseRecordActivatedAt);
    await expectState(historicalBaseline);
  });

  test("invalid or incomplete addresses fail without stale data or realtime fallback", async ({
    page,
  }) => {
    const before = await captureState();
    const unknown = new URL(evidenceUrl(routeCases[0]!, resultA, evidenceA));
    unknown.searchParams.set("evidence_snapshot_id", `ES-unknown-${randomUUID()}`);
    const [unknownResponse] = await Promise.all([
      page.waitForResponse((response) => isLookup(response)),
      page.goto(unknown.toString()),
    ]);
    expect(unknownResponse.status()).toBe(400);
    await expect(unknownResponse.json()).resolves.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    await expect(page.getByRole("heading", { name: "证据查询失败" })).toBeVisible();

    const malformed = new URL(evidenceUrl(routeCases[0]!, resultA, evidenceA));
    malformed.searchParams.set("evidence_scope", "{not-json");
    await page.goto(malformed.toString());
    await expect(page.getByRole("heading", { name: "证据查询失败" })).toBeVisible();
    await expect(
      page.getByText(`${evidenceA.value} ${evidenceA.unit}`, { exact: true }),
    ).toHaveCount(0);

    const incomplete = new URL(evidenceUrl(routeCases[0]!, resultA, evidenceA));
    incomplete.searchParams.delete("evidence_snapshot_id");
    const countBeforeIncomplete = await snapshotCount();
    await page.goto(incomplete.toString());
    await expect(page.getByRole("heading", { name: "历史数字证据" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "证据查询失败" })).toBeVisible();
    await expect(page.getByText(/证据链接.*不完整/u)).toBeVisible();
    expect(await snapshotCount()).toBe(countBeforeIncomplete);
    await expectState(before);
  });

  test("shared history view rejects missing ids, missing scope, unknown evidence and mismatched scope", async ({
    page,
  }) => {
    const before = await captureState();
    const observed: QueryIntentV11[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/v1/query")
        return;
      const body = request.postDataJSON() as QueryIntentV11;
      observed.push(body);
      expect(body.question_type).toBe("EVIDENCE_LOOKUP");
      expect(body.evidence_snapshot_id).toBeTruthy();
    });

    for (const missing of ["evidence_id", "evidence_scope"] as const) {
      const incomplete = new URL(evidenceUrl(routeCases[0]!, resultA, evidenceA));
      incomplete.searchParams.delete(missing);
      const requestsBefore = observed.length;
      await page.goto(incomplete.toString());
      await expect(page.getByRole("heading", { name: "历史数字证据" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "证据查询失败" })).toBeVisible();
      await expect(page.getByText(/证据链接.*不完整/u)).toBeVisible();
      expect(observed).toHaveLength(requestsBefore);
    }

    const unknownEvidence = new URL(evidenceUrl(routeCases[0]!, resultA, evidenceA));
    unknownEvidence.searchParams.set("evidence_id", `${evidenceA.evidence_id}:unknown`);
    const [unknownResponse] = await Promise.all([
      page.waitForResponse((response) => isLookup(response, evidenceA.evidence_snapshot_id)),
      page.goto(unknownEvidence.toString()),
    ]);
    expect(unknownResponse.status()).toBe(400);
    await expect(unknownResponse.json()).resolves.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    await expect(page.getByRole("heading", { name: "证据查询失败" })).toBeVisible();

    const mismatchedScope = new URL(evidenceUrl(routeCases[0]!, resultA, evidenceA));
    mismatchedScope.searchParams.set(
      "evidence_scope",
      JSON.stringify({ ...resultA.query_intent.scope, factor_id: "PRICE" }),
    );
    const [mismatchResponse] = await Promise.all([
      page.waitForResponse((response) => isLookup(response, evidenceA.evidence_snapshot_id)),
      page.goto(mismatchedScope.toString()),
    ]);
    expect(mismatchResponse.status()).toBe(400);
    await expect(mismatchResponse.json()).resolves.toMatchObject({ code: "INVALID_FILTER" });
    await expect(page.getByRole("heading", { name: "证据查询失败" })).toBeVisible();

    const attributionIncomplete = new URL(evidenceUrl(routeCases[1]!, resultA, evidenceA));
    attributionIncomplete.searchParams.delete("evidence_scope");
    const requestsBeforeAttribution = observed.length;
    await page.goto(attributionIncomplete.toString());
    await expect(page.getByRole("heading", { name: "历史数字证据" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "证据查询失败" })).toBeVisible();
    await expect(page.getByText(/证据链接.*不完整/u)).toBeVisible();
    expect(observed).toHaveLength(requestsBeforeAttribution);

    await expect(
      page.getByText(`${evidenceA.value} ${evidenceA.unit}`, { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/基于历史版本。/u)).toHaveCount(0);
    await expectState(before);
  });

  test("service failure and client timeout clear the previous historical value and status", async ({
    page,
  }) => {
    const before = await captureState();
    const historical = {
      ...resultA,
      warnings: [
        ...resultA.warnings,
        {
          code: "HISTORICAL_VERSION" as const,
          message: "证据快照来自非当前活动数据发布",
        },
      ],
    };
    let mode: "historical" | "failure" | "timeout" = "historical";
    let releaseTimeout!: () => void;
    let markTimeoutStarted!: () => void;
    const timeoutStarted = new Promise<void>((resolve) => {
      markTimeoutStarted = resolve;
    });
    const timeoutGate = new Promise<void>((resolve) => {
      releaseTimeout = resolve;
    });
    await page.route("**/api/v1/query", async (route) => {
      const body = route.request().postDataJSON() as Partial<QueryIntentV11> | null;
      if (body?.question_type !== "EVIDENCE_LOOKUP") return route.continue();
      if (mode === "historical") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(historical),
        });
        return;
      }
      if (mode === "failure") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            type: "QUERY_TIMEOUT",
            message_zh: "确定性查询服务暂时不可用",
            request_id: randomUUID(),
          }),
        });
        return;
      }
      markTimeoutStarted();
      await timeoutGate;
      await route.abort("timedout").catch(() => undefined);
    });
    const navigateInWorkspace = async (attempt: string) => {
      const next = new URL(evidenceUrl(routeCases[0]!, resultA, evidenceA));
      next.searchParams.set("attempt", attempt);
      await page.evaluate((url) => {
        window.history.pushState({}, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, next.toString());
    };
    try {
      await page.goto(evidenceUrl(routeCases[0]!, resultA, evidenceA));
      await expectEvidence(page, resultA, evidenceA, true);

      mode = "failure";
      await navigateInWorkspace("failure");
      await expect(page.getByRole("heading", { name: "证据查询失败" })).toBeVisible();
      await expect(page.getByText("确定性查询服务暂时不可用", { exact: true })).toBeVisible();
      await expect(
        page.getByText(`${evidenceA.value} ${evidenceA.unit}`, { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText(/基于历史版本。/u)).toHaveCount(0);

      mode = "timeout";
      await navigateInWorkspace("timeout");
      await timeoutStarted;
      await expect(
        page.getByText("证据查询超时，请重试或返回当前分析。", { exact: true }),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText(`${evidenceA.value} ${evidenceA.unit}`, { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText(/基于历史版本。/u)).toHaveCount(0);
      await expectState(before);
    } finally {
      releaseTimeout();
    }
  });

  test("switching from historical evidence to a current snapshot clears stale state while loading", async ({
    page,
  }) => {
    const before = await captureState();
    await superuser.query("DELETE FROM logiplan.active_data_release WHERE singleton");
    try {
      await navigateAndWaitForLookup(
        page,
        () => page.goto(evidenceUrl(routeCases[1]!, resultA, evidenceA)),
        evidenceA.evidence_snapshot_id!,
      );
      await expectEvidence(page, resultA, evidenceA, true);
    } finally {
      await ensureActiveRelease();
    }

    let releaseCurrent!: () => void;
    let markCurrentStarted!: () => void;
    const currentStarted = new Promise<void>((resolve) => {
      markCurrentStarted = resolve;
    });
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await page.route("**/api/v1/query", async (route) => {
      const body = route.request().postDataJSON() as Partial<QueryIntentV11> | null;
      if (
        body?.question_type !== "EVIDENCE_LOOKUP" ||
        body.evidence_snapshot_id !== evidenceB.evidence_snapshot_id
      )
        return route.continue();
      const response = await route.fetch();
      markCurrentStarted();
      await currentGate;
      await route.fulfill({ response }).catch(() => undefined);
    });
    try {
      await page.evaluate(
        (url) => {
          window.history.pushState({}, "", url);
          window.dispatchEvent(new PopStateEvent("popstate"));
        },
        evidenceUrl(routeCases[1]!, resultB, evidenceB),
      );
      await currentStarted;
      await expect(page.getByText(/基于历史版本。/u)).toHaveCount(0);
      await expect(
        page.getByText(String(evidenceA.evidence_snapshot_id), { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText(`${evidenceA.value} ${evidenceA.unit}`, { exact: true }),
      ).toHaveCount(0);
      releaseCurrent();
      await expectEvidence(page, resultB, evidenceB, false);
      await expectState(before);
    } finally {
      releaseCurrent();
    }
  });

  test("a delayed evidence A lookup cannot overwrite the latest evidence B URL", async ({
    page,
  }) => {
    const before = await captureState();
    let releaseA!: () => void;
    let markAStarted!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      markAStarted = resolve;
    });
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    await page.route("**/api/v1/query", async (route) => {
      const body = route.request().postDataJSON() as Partial<QueryIntentV11> | null;
      if (body?.question_type !== "EVIDENCE_LOOKUP") return route.continue();
      if (body.evidence_snapshot_id === evidenceA.evidence_snapshot_id) {
        markAStarted();
        await aGate;
        await route
          .fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resultA) })
          .catch(() => undefined);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(resultB),
      });
    });
    try {
      await page.goto(evidenceUrl(routeCases[1]!, resultA, evidenceA));
      await aStarted;
      const bResponse = page.waitForResponse((response) =>
        isLookup(response, evidenceB.evidence_snapshot_id),
      );
      await page.evaluate(
        (url) => {
          window.history.pushState({}, "", url);
          window.dispatchEvent(new PopStateEvent("popstate"));
        },
        evidenceUrl(routeCases[1]!, resultB, evidenceB),
      );
      await bResponse;
      await expectEvidence(page, resultB, evidenceB, false);
      releaseA();
      await expectEvidence(page, resultB, evidenceB, false);
      await expectState(before);
    } finally {
      releaseA();
    }
  });
});
