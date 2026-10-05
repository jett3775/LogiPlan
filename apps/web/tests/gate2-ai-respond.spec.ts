import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * 闸门二切片 1b 的浏览器验收（docs/gate2-implementation-plan.md 的 AC1.5 / AC1.9 /
 * AC1.10 / AC1.11 与 AC1.8 页面渲染部分）。
 *
 * 只新增文件：既有 spec 的断言、超时与用例选择零改动（AC1.1 要求闸门一逐项不变）。
 */

const AI_ENDPOINT = "/api/v1/ai/respond";
const ATTRIBUTION_URL =
  "/attribution?period=2026-08&comparison=ACTUAL_VS_BUDGET&destination=GB" +
  "&budget=BUDGET_2026_V1&actual=ACTUAL_2026_08_CLOSE_V1&method=CHAIN";

/** 归因页地址里的固定示例范围，即 AI 回答接口受理的页面范围。 */
const PAGE_ADDRESS = "/attribution?destination=GB&period=2026-08";

const QUESTION = "英国本月履约变动成本为什么超出 Budget？";

/** 固定示例引用的 15 条证据 ID（交接要点 1）。 */
const CITED_EVIDENCE_IDS = [
  "E01-country",
  "E05-bridge",
  "ATTRIBUTION_BRIDGE:VOLUME",
  "ATTRIBUTION_BRIDGE:MIX",
  "ATTRIBUTION_BRIDGE:EFFICIENCY",
  "ATTRIBUTION_BRIDGE:PRICE",
  "ATTRIBUTION_BRIDGE:FX",
  "DIAGNOSTIC_METRICS:AIR_SHARE:BASELINE",
  "DIAGNOSTIC_METRICS:AIR_SHARE:CURRENT",
  "DIAGNOSTIC_METRICS:CARRIER_C_SHARE:BASELINE",
  "DIAGNOSTIC_METRICS:CARRIER_C_SHARE:CURRENT",
  "DIAGNOSTIC_METRICS:ON_TIME_RATE:CURRENT",
  "DIAGNOSTIC_METRICS:SERVICE_MATURITY:CURRENT",
  "ATTRIBUTION_DRILLDOWN:FC:DE_FC",
  "ATTRIBUTION_DRILLDOWN:FC:FR_FC",
];

const REQUIRED_LIMITATION_LABEL = "相关性不等于因果 · 不得推断未记录的经营因果";

type AiRespondBody = {
  ok: boolean;
  status: string;
  status_label_zh: string;
  message_zh?: string;
  answer?: {
    scope_label: string;
    answer_type: string;
    analysis: {
      answer_type: string;
      evidence_snapshot_id: string;
      limitations: { text: string; evidence_ids: string[]; status_labels?: string[] };
    };
    evidence: Array<{ evidence_id: string; evidence_snapshot_id: string; scope: unknown }>;
  };
  request_id: string;
};

const postAi = (request: APIRequestContext, body: unknown) =>
  request.post(AI_ENDPOINT, {
    headers: { "Content-Type": "application/json" },
    data: body as Record<string, unknown>,
  });

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(serious).toEqual([]);
}

/** 在归因页提问并等到五区块渲染完成。 */
async function askQuestion(page: Page, question = QUESTION) {
  const region = page.getByRole("region", { name: "AI 管理分析提问" });
  await region.getByLabel("管理分析问题（最多 500 字）", { exact: true }).fill(question);
  await region.getByRole("button", { name: "获取管理分析" }).click();
  await expect(region.getByRole("status")).toContainText("固定示例 · 未调用任何模型");
  return region;
}

test("AC1.11 五区块可读、键盘可达、焦点可见且中文可访问名称齐备", async ({ page }) => {
  await page.goto(ATTRIBUTION_URL);
  const region = page.getByRole("region", { name: "AI 管理分析提问" });
  await expect(region).toBeVisible();
  await expect(region.getByRole("heading", { name: "AI 管理分析提问" })).toBeVisible();

  // 未提问时不渲染五区块，也就不存在与闸门一既有断言重名的中文（见 ai-workspace.tsx 注释）。
  await expect(region.getByRole("heading", { name: "结论", exact: true })).toHaveCount(0);

  const textarea = region.getByLabel("管理分析问题（最多 500 字）", { exact: true });
  const submit = region.getByRole("button", { name: "获取管理分析" });
  // 键盘可达：表单控件按 Tab 顺序相邻，且都能取得焦点。
  await textarea.focus();
  await expect(textarea).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  // 焦点可见：全局 :focus-visible 规则给出 3px 轮廓（apps/web/app/globals.css:51）。
  const outlineWidth = await submit.evaluate((element) => getComputedStyle(element).outlineWidth);
  expect(outlineWidth).toBe("3px");

  await textarea.focus();
  await textarea.fill(QUESTION);
  await submit.press("Enter");
  await expect(region.getByRole("status")).toContainText("固定示例 · 未调用任何模型");

  for (const name of ["结论", "证据", "影响", "建议", "限制"]) {
    await expect(region.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(
    region.getByText(`范围：2026 年 8 月｜英国｜Actual vs Budget｜固定示例`, {
      exact: false,
    }),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

const ORDER_GRAIN_MESSAGE =
  "当前事实粒度为月 × 目的国 × 发货仓 × 承运商 × 运输方式，没有订单级收入、成本或订单—包裹关联，无法提供订单级成本明细或订单 Top 10；可以提供线路层下钻。";

test("AC1.5 订单粒度保护显示中文 message_zh，不向用户只显示内部错误码", async ({ page }) => {
  await page.goto(ATTRIBUTION_URL);
  const region = await askQuestion(page);
  const limitations = region.getByRole("region", { name: "限制", exact: true });

  // limitations.status_labels 必须直接显示核心限制标签（精确匹配，只命中标签本身）。
  await expect(limitations.getByText(REQUIRED_LIMITATION_LABEL, { exact: true })).toBeVisible();
  // 订单粒度保护显示 ORDER_LEVEL_NOT_AVAILABLE 对应的中文 message_zh（正文与状态标签各一处）。
  await expect(limitations).toContainText(ORDER_GRAIN_MESSAGE);
  await expect(
    limitations.getByText(`订单粒度不可得 · ${ORDER_GRAIN_MESSAGE}`, { exact: true }),
  ).toBeVisible();
  // 内部错误码本身不得作为面向用户的文案出现。
  await expect(region.getByText("ORDER_LEVEL_NOT_AVAILABLE", { exact: false })).toHaveCount(0);
  // 建议区的情景计算与可行性状态走穷尽中文映射。
  await expect(region.getByText("情景计算：尚未做情景计算", { exact: true }).first()).toBeVisible();
  await expect(region.getByText("可行性：未验证", { exact: true }).first()).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("交接要点 2：回答绑定服务端真实快照 ID，点击证据能打开数字证据面板", async ({ page }) => {
  await page.goto(ATTRIBUTION_URL);
  const region = await askQuestion(page);

  // 真实快照 ID 形如 ES-<uuid>；编造占位值 SNAPSHOT_GB_2026_08_V1 绝不能出现。
  await expect(region.getByText("ES-", { exact: false })).toHaveCount(0);
  const snapshotStatus = await region.evaluate(() => window.sessionStorage.length);
  expect(snapshotStatus).toBeGreaterThan(0);

  const links = region.getByRole("link");
  // 15 条被引用证据在五个区块里共出现多次（结论 3 + 证据 13 + 影响 6 + 建议 8 + 限制 2）。
  expect(await links.count()).toBeGreaterThanOrEqual(15);
  for (const id of CITED_EVIDENCE_IDS) {
    await expect(
      region.locator(`a[href*="evidence_id=${encodeURIComponent(id)}"]`),
    ).not.toHaveCount(0);
  }
  // E08／E09 的三个数字只在 limitations 正文里作为口径说明出现，不是证据链接。
  for (const label of ["589,251.0927", "12,299.5128", "432,453.0802"]) {
    await expect(region.getByText(label, { exact: false })).toBeVisible();
  }
  expect(await region.locator("a[href*='E08']").count()).toBe(0);
  expect(await region.locator("a[href*='EVIDENCE_NOT_FOUND']").count()).toBe(0);

  // 键盘操作打开证据面板：焦点落到链接上再按 Enter。
  const first = region.getByRole("link").first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/evidence_id=/u);
  await expect(page).toHaveURL(/evidence_snapshot_id=ES-/u);
  await expect(page).toHaveURL(/evidence_scope=/u);
  await expect(page.getByRole("dialog", { name: "数字证据", exact: true })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("AC1.9 服务端拒绝供应商名、模型名、任意证据 ID 与供应商参数", async ({ request }) => {
  const rejected: Array<[string, Record<string, unknown>, RegExp]> = [
    ["供应商名", { provider: "openai" }, /不得提交供应商名/u],
    ["模型名", { model: "gpt-5.6-terra" }, /不得提交模型名/u],
    ["证据 ID", { evidence_id: "E01-country" }, /不得提交证据 ID/u],
    ["证据快照 ID", { evidence_snapshot_id: "ES-any" }, /不得提交证据 ID/u],
    ["供应商参数", { temperature: 0.2 }, /不得提交供应商参数/u],
    ["未知字段", { top_n: 5 }, /不被接受的字段/u],
  ];
  for (const [label, extra, expected] of rejected) {
    const response = await postAi(request, {
      question: QUESTION,
      page_address: PAGE_ADDRESS,
      ...extra,
    });
    expect(response.status(), `${label} 应被拒绝`).toBe(400);
    const body = (await response.json()) as AiRespondBody;
    expect(body.ok, `${label} 不得返回回答`).toBe(false);
    expect(body.status).toBe("INPUT_REJECTED");
    expect(body.status_label_zh).toBe("输入未被接受");
    expect(body.message_zh, `${label} 必须给出受控中文原因`).toMatch(expected);
    expect(body.answer, `${label} 不得返回任何回答`).toBeUndefined();
  }

  // 合法请求仍可成功，且 answer_type 恒为 FIXED_EXAMPLE（本切片不调用任何模型）。
  const ok = await postAi(request, { question: QUESTION, page_address: PAGE_ADDRESS });
  expect(ok.status()).toBe(200);
  expect(ok.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
  const body = (await ok.json()) as AiRespondBody;
  expect(body.ok).toBe(true);
  expect(body.status).toBe("FIXED_EXAMPLE");
  expect(body.answer?.analysis.answer_type).toBe("FIXED_EXAMPLE");
  expect(body.answer?.analysis.evidence_snapshot_id).toMatch(/^ES-/u);
  expect(body.answer?.evidence.map((item) => item.evidence_id).sort()).toEqual(
    [...CITED_EVIDENCE_IDS].sort(),
  );
  expect(body.answer?.analysis.limitations.status_labels).toContain(REQUIRED_LIMITATION_LABEL);
});

test("AC1.10 输入超 500 Unicode 字符被拒并返回受控中文状态", async ({ request }) => {
  const overLimit = "分".repeat(501);
  const response = await postAi(request, { question: overLimit, page_address: PAGE_ADDRESS });
  expect(response.status()).toBe(400);
  const body = (await response.json()) as AiRespondBody;
  expect(body.ok).toBe(false);
  expect(body.status).toBe("INPUT_REJECTED");
  expect(body.status_label_zh).toBe("输入未被接受");
  expect(body.message_zh).toMatch(/超过 500 个字符上限/u);
  expect(body.answer).toBeUndefined();

  // 恰好 500 码点必须被受理，边界不含糊。
  const atLimit = await postAi(request, {
    question: "分".repeat(500),
    page_address: PAGE_ADDRESS,
  });
  expect(atLimit.status()).toBe(200);
});

test("接口与 /api/v1/query 同范式：content-type、体积上限与健康检查行为不变", async ({
  page,
  request,
}) => {
  const wrongType = await request.post(AI_ENDPOINT, {
    headers: { "Content-Type": "text/plain" },
    data: "question=hi",
  });
  expect(wrongType.status()).toBe(415);
  await expect(wrongType.json()).resolves.toMatchObject({
    status: "INPUT_REJECTED",
    status_label_zh: "输入未被接受",
  });

  const tooLarge = await request.post(AI_ENDPOINT, {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ question: "问".repeat(9_000), page_address: PAGE_ADDRESS }),
  });
  expect(tooLarge.status()).toBe(400);
  await expect(tooLarge.json()).resolves.toMatchObject({ message_zh: "请求体超过 16 KiB 限制" });

  const malformed = await request.post(AI_ENDPOINT, {
    headers: { "Content-Type": "application/json" },
    data: "{",
  });
  expect(malformed.status()).toBe(400);

  // 越界页面范围：驾驶舱范围与其它目的国都不受理，避免用错范围的证据回答问题。
  for (const address of ["/", "/attribution?destination=DE", "https://example.com/attribution"]) {
    const scoped = await postAi(request, { question: QUESTION, page_address: address });
    expect(scoped.status(), `${address} 应被拒绝`).toBe(400);
    await expect(scoped.json()).resolves.toMatchObject({ status: "INPUT_REJECTED" });
  }

  // AC1.11：/api/health/live 与 /api/health/ready 行为不变。
  const live = await request.get("/api/health/live");
  expect(live.status()).toBe(200);
  const ready = await request.get("/api/health/ready");
  expect(ready.status()).toBe(200);
  await expect(ready.json()).resolves.toMatchObject({ status: expect.any(String) });
  await page.goto(ATTRIBUTION_URL);
  await expect(page.getByRole("region", { name: "AI 管理分析提问" })).toBeVisible();
});
