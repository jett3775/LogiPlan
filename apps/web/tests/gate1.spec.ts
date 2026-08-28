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

test("@firefox-smoke dashboard core page is reachable, semantic, and keyboard navigable", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "LogiPlan 正式工程" })).toBeVisible();
  const attributionLink = page.getByRole("link", { name: "进入归因分析骨架" });
  await expect(attributionLink).toBeVisible();
  await attributionLink.focus();
  await expect(attributionLink).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);
});

test("@firefox-smoke attribution core page is reachable and accessible", async ({ page }) => {
  await page.goto("/attribution");
  await expect(page.getByRole("heading", { name: "归因分析" })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回驾驶舱" })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
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
