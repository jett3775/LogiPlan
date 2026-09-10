import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

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
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "预算执行驾驶舱" })).toBeVisible();
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
  await page.getByRole("link", { name: "进入归因" }).click();
  await expect(page).toHaveURL(/\/attribution\?.*destination=GB/u);
  await expect(page.getByRole("heading", { name: "英国履约变动成本归因" })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
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
