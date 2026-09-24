import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Page, Request } from "@playwright/test";

// 诊断时间线：仅在设置了 LOGIPLAN_GATE1_TIMELINE_FILE 时写文件，每行一个 JSON 对象
// （iteration/event/at_ms/detail）。断言失败时把「停滞在哪一阶段」写进错误消息。
const timelineFile = process.env.LOGIPLAN_GATE1_TIMELINE_FILE;
const timelineIteration = Number.parseInt(process.env.LOGIPLAN_GATE1_ITERATION ?? "1", 10);
const timelineStartMs = Date.now();

// 归属信息：让每条事件都能追溯到具体的 Playwright project（chromium-1440 / chromium-1280 /
// firefox-smoke）与浏览器，否则同一 spec 在多 project 下并行时无法判断某条 pageerror 来自哪个浏览器。
// 依据：test.info() 返回当前用例的 TestInfo，其 project 是 TestProject 的运行时形态：project.name 即
// project 名；浏览器先取 project.use.browserName，未设置时回退 project.use.defaultBrowserType——这正是
// Playwright 自己解析 browserName fixture 的顺序（index.js:193
// `browserName: [({ defaultBrowserType }, use) => use(defaultBrowserType)]`）。本仓库 playwright.config.ts
// 的三个 project 都只用 devices["Desktop Chrome"] / devices["Desktop Firefox"] 展开，只带
// defaultBrowserType、不带 browserName（已实测），故该回退必须保留，否则 browser 恒为 null。
// test.info() 只在用例运行期间可用——Playwright 在用例（含 afterEach）结束后会把 currentTestInfo 置空
// （workerProcessEntry.js:1720 调用 globals.setCurrentTestInfo(null)），此后再调用会抛「test.info() can
// only be called while test is running」（common/index.js:2252）。而页面事件回调可能在用例结束后才触发
// （例如 api_query_response_end 来自 response.finished() 的 promise），故取不到实时值时回退到最近一次
// 快照；快照也没有则记 null。
let lastKnownTimelineAttribution: { project: string | null; browser: string | null } | null = null;

function timelineAttribution(): { project: string | null; browser: string | null } {
  try {
    const { project } = test.info();
    lastKnownTimelineAttribution = {
      project: project.name,
      browser: project.use?.browserName ?? project.use?.defaultBrowserType ?? null,
    };
    return lastKnownTimelineAttribution;
  } catch {
    return lastKnownTimelineAttribution ?? { project: null, browser: null };
  }
}

function recordTimeline(event: string, detail?: unknown): void {
  if (timelineFile === undefined || timelineFile === "") return;
  try {
    // 归属只在此处集中附加，事件名与既有字段保持原样。
    const attribution = timelineAttribution();
    appendFileSync(
      timelineFile,
      `${JSON.stringify({
        iteration: Number.isSafeInteger(timelineIteration) ? timelineIteration : 1,
        event,
        at_ms: Date.now() - timelineStartMs,
        detail: detail ?? null,
        project: attribution.project,
        browser: attribution.browser,
      })}\n`,
    );
  } catch {
    // 诊断埋点不得改变测试结果。
  }
}

function createStageTracker(scope: string) {
  let stage = "start";
  return {
    mark(event: string, detail?: unknown): void {
      stage = event;
      recordTimeline(event, detail);
    },
    current(): string {
      return stage;
    },
    async track(run: () => Promise<void>): Promise<void> {
      try {
        await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordTimeline("failure", { stage, message });
        const annotated = `[${scope}] 停滞阶段「${stage}」：${message}`;
        if (error instanceof Error) {
          Object.assign(error, { message: annotated });
          throw error;
        }
        throw new Error(annotated);
      }
    },
  };
}

const isQueryRequest = (request: Request): boolean =>
  request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/query";

function queryRequestBody(request: Request): unknown {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

// 常驻页面埋点：导航、document、/api/v1/query 的请求与响应生命周期、console 与 pageerror。
function instrumentPage(page: Page): void {
  page.on("console", (message) => {
    if (message.type() === "error") recordTimeline("console_error", { text: message.text() });
  });
  page.on("pageerror", (error) => recordTimeline("pageerror", { message: error.message }));
  page.on("request", (request) => {
    if (request.resourceType() === "document") {
      recordTimeline("navigation_request", { url: request.url() });
      return;
    }
    if (isQueryRequest(request)) {
      recordTimeline("api_query_request_start", {
        url: request.url(),
        body: queryRequestBody(request),
      });
    }
  });
  page.on("response", (response) => {
    const request = response.request();
    if (request.resourceType() === "document") {
      recordTimeline("document_response", { url: request.url(), status: response.status() });
      return;
    }
    if (!isQueryRequest(request)) return;
    recordTimeline("api_query_response_status", { status: response.status() });
    response.finished().then(
      () => recordTimeline("api_query_response_end", { status: response.status() }),
      () => undefined,
    );
  });
  page.on("requestfailed", (request) => {
    if (!isQueryRequest(request)) return;
    recordTimeline("api_query_request_failed", { failure: request.failure()?.errorText ?? null });
  });
}

// 记录路由级 loading 壳（apps/web/app/loading.tsx）是否已经消失。
async function recordLoadingShell(page: Page, stage: string): Promise<void> {
  try {
    const count = await page.getByRole("heading", { name: "正在加载分析工作台" }).count();
    recordTimeline("loading_shell_gone", { stage, gone: count === 0 });
  } catch (error) {
    recordTimeline("loading_shell_probe_failed", {
      stage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// 专为判定 React #418 的元素级服务端/客户端不匹配来源而加：记录水合瞬间 DOM 是否仍停在
// Next 的 loading 壳（loading.tsx 的 <main aria-busy>）上，以及应用根元素的结构摘要。
// 只读观测，不改变断言、超时或渲染产物；未设置时间线文件时仅在页面内做只读查询。
async function recordHydrationDomProbe(page: Page, stage: string): Promise<void> {
  try {
    const probe = await page.evaluate(() => {
      const loadingShell = document.querySelector("main[aria-busy]");
      // 生产构建会把 CSS Module 类名哈希成纯 hash（不含 "workspace" 子串），故 [class*=workspace]
      // 不可靠；改用 body 的首个元素子节点作为应用根元素，取不到时记 null。
      const root = document.body.firstElementChild;
      return {
        loading_shell_present: loadingShell !== null,
        app_root: root === null ? null : { tagName: root.tagName, className: root.className },
        loading_shell_html_head:
          loadingShell === null ? null : loadingShell.outerHTML.slice(0, 200),
      };
    });
    const dashboardHeadingPresent =
      (await page.getByRole("heading", { name: "预算执行驾驶舱" }).count()) > 0;
    recordTimeline("hydration_dom_probe", {
      stage,
      ...probe,
      dashboard_heading_present: dashboardHeadingPresent,
    });
  } catch (error) {
    recordTimeline("hydration_dom_probe_failed", {
      stage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// 为定位 React #418（元素级 SSR/客户端不匹配）而加：把权威 SSR HTML 与水合完成后的 DOM 各自
// 落盘，交由离线结构化 diff 找出发生不匹配的元素。仅当设置了时间线文件时才读取响应体/DOM 并
// 写文件；未设置时零副作用（连响应体与 page.content() 都不取）。任何失败只记事件，绝不让用例失败。
async function recordHydrationHtmlSnapshot(
  page: Page,
  ssrHtmlPromise: Promise<string | null>,
  stage: string,
): Promise<void> {
  if (timelineFile === undefined || timelineFile === "") return;
  try {
    const ssrHtml = await ssrHtmlPromise;
    if (ssrHtml === null) throw new Error("未捕获到主文档响应体");
    const hydratedHtml = await page.content();
    const iter = Number.isSafeInteger(timelineIteration) ? timelineIteration : 1;
    const ssrPath = `${timelineFile}.iter${iter}.ssr.html`;
    const hydratedPath = `${timelineFile}.iter${iter}.hydrated.html`;
    writeFileSync(ssrPath, ssrHtml);
    writeFileSync(hydratedPath, hydratedHtml);
    const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
    recordTimeline("hydration_html_snapshot", {
      stage,
      ssr_bytes: Buffer.byteLength(ssrHtml),
      hydrated_bytes: Buffer.byteLength(hydratedHtml),
      ssr_sha256: digest(ssrHtml),
      hydrated_sha256: digest(hydratedHtml),
      ssr_path: ssrPath,
      hydrated_path: hydratedPath,
    });
  } catch (error) {
    recordTimeline("hydration_html_snapshot_failed", {
      stage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const diagnosticIntent = {
  question_type: "DIAGNOSTIC_METRICS",
  scope: {
    period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
    comparison: "ACTUAL_VS_BUDGET",
    destination_country_ids: ["GB"],
    budget_version_id: "BUDGET_2026_V1",
    actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
    calculation_version: "D-092",
  },
  metrics: ["ORDERS", "AIR_SHARE", "CARRIER_C_SHARE", "ON_TIME_RATE", "SERVICE_MATURITY"],
  group_by: [],
  output_locale: "zh-CN",
  context_sources: ["FIXED_TEMPLATE"],
} as const;

const attributionEvidenceScope = {
  period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
  comparison: "ACTUAL_VS_BUDGET",
  destination_country_ids: ["GB"] as string[],
  budget_version_id: "BUDGET_2026_V1",
  actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
  calculation_version: "D-092",
} as const;

const evidenceLookup = (evidence_id: string, scope = attributionEvidenceScope) => ({
  contract_version: "V1.1",
  question_type: "EVIDENCE_LOOKUP",
  scope,
  metrics: [],
  group_by: [],
  output_locale: "zh-CN",
  context_sources: ["PAGE_VISIBLE_STATE"],
  evidence_id,
});

type MetricValue = {
  high_precision: string;
  report: string;
  display: string;
  unit: string;
};

type DiagnosticMetric = {
  diagnostic_id: string;
  current: MetricValue;
  baseline: MetricValue | null;
  delta: MetricValue | null;
};

type DiagnosticResponse = {
  result_id: string;
  payload: {
    scope: typeof diagnosticIntent.scope;
    diagnostics: DiagnosticMetric[];
    service_evaluation: {
      maturity_status: string;
      status_label_zh: string;
      on_time_denominator_policy_zh: string;
    };
  };
  evidence: Array<{
    source_result_id: string;
    period: { from: string; to: string };
    comparison: string;
    filters: { destination_country_id: string[] };
    group_by: string[];
    source_refs: string[];
    value: string;
  }>;
  warnings: Array<{ code: string }>;
};

function metric(body: DiagnosticResponse, name: string) {
  const found = body.payload.diagnostics.find((item) => item.diagnostic_id === name);
  expect(found, `missing diagnostic metric ${name}`).toBeDefined();
  return found as DiagnosticMetric;
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const seriousViolations = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(seriousViolations).toEqual([]);
}

test("@firefox-smoke V01-V04 dashboard is readable, expandable and navigates to GB attribution", async ({
  page,
}) => {
  const tracker = createStageTracker("Firefox 目标用例");
  instrumentPage(page);
  await tracker.track(async () => {
    tracker.mark("navigation_start", { url: "/" });
    // 只读捕获本次导航的主文档响应体作为权威 SSR HTML。waitForResponse 在主流程之外异步读取
    // 响应体，不阻塞 goto 之后的任何既有断言/等待。未设置时间线文件时不安装监听（零副作用）。
    const ssrHtmlPromise: Promise<string | null> =
      timelineFile === undefined || timelineFile === ""
        ? Promise.resolve(null)
        : page
            .waitForResponse(
              (response) =>
                response.request().resourceType() === "document" &&
                response.status() === 200 &&
                new URL(response.url()).pathname === "/",
            )
            .then((response) => response.text())
            .catch(() => null);
    await page.goto("/");
    tracker.mark("first_document_loaded");
    await recordHydrationDomProbe(page, "dashboard-first-paint");
    tracker.mark("dashboard_heading_wait");
    await expect(page.getByRole("heading", { name: "预算执行驾驶舱" })).toBeVisible();
    tracker.mark("dashboard_heading_visible");
    await recordLoadingShell(page, "dashboard");
    await recordHydrationHtmlSnapshot(page, ssrHtmlPromise, "dashboard-hydrated");
    await expect(page.getByText("完全虚构的求职作品集演示数据")).toBeVisible();
    await expect(page.getByRole("heading", { name: "六项核心 KPI" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Budget / Actual / Forecast 月度趋势" }),
    ).toBeVisible();
    await expect(page.getByText("8—9 月结账分界")).toBeVisible();
    const fixedRegion = page
      .getByRole("heading", { name: "物流运营固定成本" })
      .locator("xpath=ancestor::section[1]");
    const fixedButton = fixedRegion.getByRole("button", { name: "展开固定成本" });
    await fixedButton.click();
    const expandedFixedButton = fixedRegion.getByRole("button", { name: "收起固定成本" });
    await expect(expandedFixedButton).toHaveAttribute("aria-expanded", "true");
    await expect(fixedRegion.getByText("一线作业基础人工", { exact: true })).toBeVisible();
    await expect(fixedRegion.getByText("仓库管理人工", { exact: true })).toBeVisible();
    const warehouseRegion = page
      .getByRole("heading", { name: "发货仓差异" })
      .locator("xpath=ancestor::section[1]");
    await expect(warehouseRegion.getByText("+589,251.09 CNY", { exact: true })).toBeVisible();
    tracker.mark("attribution_link_click");
    await page.getByRole("link", { name: "进入归因" }).click();
    tracker.mark("attribution_url_wait");
    await expect(page).toHaveURL(/\/attribution\?.*destination=GB/u);
    tracker.mark("attribution_url_matched");
    await recordLoadingShell(page, "attribution");
    tracker.mark("target_heading_wait");
    await expect(page.getByRole("heading", { name: "英国履约变动成本归因" })).toBeVisible();
    tracker.mark("target_heading_visible");
    tracker.mark("accessibility_audit");
    await expectNoSeriousAccessibilityViolations(page);
    tracker.mark("accessibility_passed");
  });
});

test("@firefox-smoke V05-V09 and V11 attribution supports factors, drilldown, evidence and history", async ({
  page,
}) => {
  let evidenceLookupRequests = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/v1/query")) return;
    const body = request.postDataJSON() as { question_type?: string } | null;
    if (body?.question_type === "EVIDENCE_LOOKUP") evidenceLookupRequests += 1;
  });
  await page.goto(
    `/attribution?period=2026-08&comparison=ACTUAL_VS_BUDGET&destination=GB&budget=BUDGET_2026_V1&actual=ACTUAL_2026_08_CLOSE_V1&method=CHAIN`,
  );
  const summaryRegion = page.getByRole("region", { name: "英国成本摘要" });
  await expect(summaryRegion.getByText("891,643.28 CNY", { exact: true })).toBeVisible();
  await expect(summaryRegion.getByText("317,169.06 CNY", { exact: true })).toBeVisible();
  await expect(summaryRegion.getByText("+574,474.22 CNY", { exact: true })).toBeVisible();

  const volume = page.getByRole("button", { name: /^1\. 量/u });
  const mix = page.getByRole("button", { name: /^2\. 结构/u });
  await volume.click();
  await expect(volume).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/factor=VOLUME/u);
  await mix.click();
  await expect(mix).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/factor=MIX/u);
  await page.goBack();
  await expect(volume).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(mix).toHaveAttribute("aria-pressed", "true");
  await mix.click();
  await expect(mix).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "+ 德国仓" }).click();
  await page.getByRole("button", { name: "+ 空运" }).click();
  await page.getByRole("button", { name: "+ Carrier C" }).click();
  await expect(page.getByRole("row", { name: /基础运费/u })).toBeVisible();
  await expect(page.getByText("示例回答", { exact: true })).toBeVisible();
  await expect(page.getByText(/相关性不等于因果/u)).toBeVisible();
  await expect(page.getByText(/无法生成订单级 Top 结果/u)).toBeVisible();

  const warehouseRow = page.getByRole("row", { name: /德国仓/u });
  const evidenceButton = warehouseRow.getByRole("button", { name: "数字证据" });
  await evidenceButton.click();
  await expect(page.getByRole("dialog", { name: "数字证据侧栏" })).toBeVisible();
  await expect(page).toHaveURL(/evidence_id=/u);
  await expect.poll(() => evidenceLookupRequests).toBe(1);
  await page.reload();
  await expect.poll(() => evidenceLookupRequests).toBe(2);
  await expect(page.getByRole("heading", { name: "历史数字证据" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "数字证据" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "德国仓总差异" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "英国履约变动成本归因" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "数字证据" })).toHaveCount(0);
  const requestsBeforeForward = evidenceLookupRequests;
  await page.goForward();
  await expect(page.getByRole("heading", { name: "历史数字证据" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "数字证据" })).toBeVisible();
  await expect.poll(() => evidenceLookupRequests).toBeGreaterThan(requestsBeforeForward);
  await expectNoSeriousAccessibilityViolations(page);
});

test("V10 four-step guide starts, crosses pages, completes, exits and restarts", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看演示主线" }).click();
  await expect(page.getByText("演示主线 · 第 1 / 4 步")).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByText("演示主线 · 第 2 / 4 步")).toBeVisible();
  await page.getByRole("link", { name: "进入归因页" }).click();
  await expect(page.getByText("演示主线 · 第 3 / 4 步")).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByText("演示主线 · 第 4 / 4 步")).toBeVisible();
  await expect(page.getByRole("button", { name: /^2\. 结构/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "− Carrier C" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.getByRole("button", { name: "完成" }).click();
  await expect(page.getByText("演示主线 · 第 4 / 4 步")).toHaveCount(0);
  await page.getByRole("link", { name: "预算执行驾驶舱" }).click();
  await page.getByRole("button", { name: "查看演示主线" }).click();
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByText(/演示主线 · 第/u)).toHaveCount(0);
});
test("evidence lookup API returns exact evidence and explicit errors", async ({ request }) => {
  const known = await request.post("/api/v1/query", { data: evidenceLookup("E01-country") });
  expect(known.status()).toBe(200);
  const knownBody = (await known.json()) as {
    contract_version: string;
    evidence: Array<{ evidence_id: string; value: string; source_result_id: string }>;
  };
  expect(knownBody.contract_version).toBe("V1.1");
  expect(knownBody.evidence).toEqual([
    expect.objectContaining({ evidence_id: "E01-country", value: expect.any(String) }),
  ]);
  expect(knownBody.evidence[0]?.source_result_id).toMatch(/^Q-[a-f0-9]{64}$/u);

  const unknown = await request.post("/api/v1/query", {
    data: evidenceLookup("E01-country:unknown"),
  });
  expect(unknown.status()).toBe(400);
  await expect(unknown.json()).resolves.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });

  const mismatched = await request.post("/api/v1/query", {
    data: evidenceLookup("E01-country", {
      ...attributionEvidenceScope,
      destination_country_ids: ["DE"],
    }),
  });
  expect(mismatched.status()).toBe(400);
  await expect(mismatched.json()).resolves.toMatchObject({
    code: "INVALID_FILTER",
    message_zh: expect.stringContaining("范围不匹配"),
  });
});

test("@firefox-smoke diagnostic metrics API returns E07 and E10 from active PostgreSQL", async ({
  request,
}) => {
  const response = await request.post("/api/v1/query", { data: diagnosticIntent });
  expect(response.status()).toBe(200);

  const body = (await response.json()) as DiagnosticResponse;
  expect(body.result_id).toMatch(/^Q-/);
  expect(body.payload.scope).toEqual(diagnosticIntent.scope);

  const air = metric(body, "AIR_SHARE");
  expect(air.current.display).toBe("66.02");
  expect(air.baseline?.display).toBe("13.69");
  expect(air.delta).toMatchObject({
    report: "52.3241",
    display: "52.32",
    unit: "PERCENTAGE_POINT",
  });
  expect(typeof air.delta?.high_precision).toBe("string");
  expect(air.delta?.high_precision).not.toBe(air.delta?.report);

  const carrier = metric(body, "CARRIER_C_SHARE");
  expect(carrier.current.display).toBe("38.84");
  expect(carrier.baseline?.display).toBe("2.88");
  expect(carrier.delta).toMatchObject({
    report: "35.9613",
    display: "35.96",
    unit: "PERCENTAGE_POINT",
  });
  expect(typeof carrier.delta?.high_precision).toBe("string");

  const service = body.payload.service_evaluation;
  expect(service.maturity_status).toBe("NOT_FINAL");
  expect(service.status_label_zh).toBe("结果尚未最终成熟");
  expect(service.on_time_denominator_policy_zh).toContain("未到承诺截止日期的在途包裹不进入分母");
  const onTime = metric(body, "ON_TIME_RATE");
  expect(onTime.current.display).toBe("96.16");
  const maturity = metric(body, "SERVICE_MATURITY");
  expect(maturity.current.display).toBe("92.00");
  expect(typeof onTime.current.high_precision).toBe("string");
  expect(typeof maturity.current.high_precision).toBe("string");

  expect(body.warnings.map((warning) => warning.code)).toContain("SERVICE_NOT_MATURE");
  expect(body.evidence.length).toBeGreaterThan(0);
  for (const item of body.evidence) {
    expect(item.source_result_id).toBe(body.result_id);
    expect(item.period).toEqual({ from: "2026-08", to: "2026-08" });
    expect(item.comparison).toBe("ACTUAL_VS_BUDGET");
    expect(item.filters).toEqual({ destination_country_id: ["GB"] });
    expect(item.group_by).toEqual([]);
    expect(item.source_refs).toContain("logiplan.active_country_order_fact");
    expect(typeof item.value).toBe("string");
  }
});
