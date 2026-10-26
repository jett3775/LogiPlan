#!/usr/bin/env node
/**
 * 门 C 真实调用的 9 题范围内子集评估。
 *
 * 当前 AI 端点只受理英国归因页（`/attribution?period=2026-08&destination=GB`），
 * 因此本脚本只执行落在该证据范围内的 9 题：E01、E05—E10、E19、E20。
 * 其余 11 题（E02—E04、E11—E18）标为「当前服务范围外」，**不**计入任何通过率，
 * 也**不**声称满足 `docs/ai-evaluation-baseline.md` 的 18/20 门槛。
 *
 * ## 用法
 *
 * ```bash
 * pnpm build
 * LOGIPLAN_AI_LIVE_CALLS=1 DEEPSEEK_API_KEY=... LOGIPLAN_AI_ANON_SECRET=... \
 * UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... DATABASE_URL=... \
 *   node scripts/ai-evaluation-subset.mjs
 * ```
 *
 * 复用已在运行的服务：追加 `--base-url=http://127.0.0.1:4173 --start-server=false`。
 *
 * ## 判定口径
 *
 * 每题按三层判定：
 * 1. **会话层**：HTTP 200、`status === "LIVE_GENERATED"`、`answer_type` 一致、
 *    至少一份证据快照、限制区块含「相关性不等于因果」。
 * 2. **数字层**：题面要求的数字必须在回答正文中**精确出现**（千分位与百分比形式归一化）。
 *    回答里出现白名单外数字时，网关的输出三检会失败并回落固定示例，故第 1 层不通过；
 *    本脚本不重复实现白名单校验。
 * 3. **边界层**：E08/E09 全篇 `evidence_ids` 必须为空；E19 必须拒绝确认容量；
 *    E20 必须拒绝订单级明细。E08/E09 的数字只能作为文字陈述（见评估基线 2026-10-05 注）。
 *
 * 任一层不通过即该题不通过。脚本**不重试**，避免重复计费；失败题保留原始响应供人工复核。
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const args = new Map(
  process.argv.slice(2).map((item) => {
    const [key, ...rest] = item.replace(/^--/u, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const BASE_URL = args.get("base-url") ?? "http://127.0.0.1:4173";
const START_SERVER = args.get("start-server") !== "false";
const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const PAGE_ADDRESS = "/attribution?period=2026-08&destination=GB";
const OUTPUT_DIR = join(REPO_ROOT, "outputs", "ai-evaluation-2026-10-21");

/** 范围外题目的显式清单：只用于在报告中如实标注，不发起请求。 */
const OUT_OF_SCOPE = ["E02", "E03", "E04", "E11", "E12", "E13", "E14", "E15", "E16", "E17", "E18"];

/**
 * 9 题判定表。
 *
 * `numbers` 取自 `data/generated/ai-evaluation-baseline.json` 的 `required_numbers`；
 * 比例以小数形式给出，正文通常以百分比呈现，匹配时同时接受两种形式。
 */
const QUESTIONS = [
  {
    id: "E01",
    question: "2026 年 8 月英国履约变动成本相对 Budget 偏差多少？",
    numbers: [
      ["891643.2815", "Actual 履约变动成本"],
      ["317169.0583", "Budget 履约变动成本"],
      ["574474.2232", "不利差异"],
    ],
    phrases: [],
  },
  {
    id: "E05",
    question: "2026 年 8 月英国履约变动成本差异按五因素如何拆解？",
    numbers: [
      ["85239.1844", "量"],
      ["324207.8221", "结构"],
      ["64558.2789", "效率"],
      ["79960.1574", "价"],
      ["20508.7803", "汇率"],
      ["574474.2232", "五项合计"],
    ],
    phrases: ["量", "结构", "效率", "价", "汇率"],
  },
  {
    id: "E06",
    question: "2026 年 8 月英国最大的成本差异驱动是什么？",
    numbers: [
      ["324207.8221", "结构因素"],
      ["85239.1844", "量因素"],
    ],
    phrases: ["结构", "量"],
  },
  {
    id: "E07",
    question: "2026 年 8 月英国空运和 Carrier C 占比发生了什么变化？",
    numbers: [
      ["0.1369", "Budget 空运占比"],
      ["0.6602", "Actual 空运占比"],
      ["0.0288", "Budget Carrier C 占比"],
      ["0.3884", "Actual Carrier C 占比"],
    ],
    phrases: ["空运", "Carrier C", "相关"],
  },
  {
    id: "E08",
    question: "2026 年 8 月哪个发货仓贡献了最大的履约变动成本不利差异？",
    numbers: [
      ["589251.0927", "德国仓差异"],
      ["12299.5128", "法国仓差异"],
    ],
    phrases: ["德国", "法国", "公司口径"],
    // 评估基线 2026-10-05 注：本页范围内无可解析证据，全篇 evidence_ids 必须为空。
    emptyEvidenceIds: true,
  },
  {
    id: "E09",
    question: "2026 年 8 月英国哪一类履约变动成本的增量最大？",
    numbers: [["432453.0802", "最大类别增量"]],
    phrases: ["基础运费"],
    // 评估基线 2026-10-05 注：没有「国家 × 成本类别」证据对象，全篇 evidence_ids 必须为空。
    emptyEvidenceIds: true,
    requireAnyPhrase: ["汇总", "单一证据", "多条线路", "类别合计"],
  },
  {
    id: "E10",
    question: "2026 年 8 月英国准时履约率是否已经最终成熟？",
    numbers: [
      ["0.9616", "准时履约率"],
      ["0.9200", "服务成熟度"],
    ],
    phrases: ["准时", "成熟度"],
    requireAnyPhrase: ["尚未", "未最终", "没有最终", "不成熟", "不得把当前结果表述为最终"],
  },
  {
    id: "E19",
    question:
      "能否根据当前数据确认 Carrier A 和 Carrier B 一定有足够容量承接 Cost Saving Case 的份额？",
    numbers: [],
    requireAnyPhrase: ["不能确认", "无法确认", "不能保证", "无法保证"],
    phrases: ["容量", "未验证"],
    forbidPatterns: [
      [/[能有]够?足够容量/u, "断言容量足够"],
      [/可以(直接)?执行/u, "断言方案可直接执行"],
    ],
  },
  {
    id: "E20",
    question: "请列出 2026 年 8 月英国每个订单的物流成本，并找出最贵的 10 单。",
    numbers: [],
    requireAnyPhrase: ["无法提供", "不能提供", "无法列出"],
    phrases: ["订单"],
    requireAnyPhrase2: ["粒度", "订单级", "订单—包裹", "没有订单"],
    forbidPatterns: [
      [/最贵.{0,8}(10|十).{0,4}(单|订单).{0,6}[:：]/u, "给出最贵 10 单清单"],
      [/(^|\n)\s*\|?\s*订单\s*(ID|号|编号)/u, "给出订单编号列"],
    ],
  },
];

const results = [];
const record = (ok, label, detail = "") => {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const healthOk = async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/health/live`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

/** 起 `next start`：Next 只在项目目录找 `.env`，故变量由本进程继承（同验收脚本）。 */
const startServer = async () => {
  const port = new URL(BASE_URL).port || "4173";
  const child = spawn("pnpm", ["--filter", "@logiplan/web", "exec", "next", "start", "-p", port], {
    cwd: REPO_ROOT,
    shell: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += String(chunk)));
  child.stderr.on("data", (chunk) => (log += String(chunk)));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1_000);
    if (await healthOk()) return { child, log: () => log };
    if (child.exitCode !== null) break;
  }
  console.log(log.slice(-2_000));
  return { child, log: () => log, failed: true };
};

const stopServer = async (child) => {
  if (child === null || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        shell: true,
        stdio: "ignore",
      });
      killer.on("close", resolve);
    });
  } else {
    child.kill("SIGTERM");
  }
};

/** 只读月度用量（AC2.11 CLI），用于核对真实调用是否结算。 */
const readUsage = () =>
  new Promise((resolve) => {
    const child = spawn("pnpm", ["--filter", "@logiplan/ai", "run", "usage"], {
      cwd: REPO_ROOT,
      shell: true,
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", () => undefined);
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const match = out.match(/\{[\s\S]*\}/u);
      if (match === null) return resolve(null);
      try {
        resolve(JSON.parse(match[0]));
      } catch {
        resolve(null);
      }
    });
  });

const normalizeNumber = (value) => value.replaceAll(",", "");

/** 数字的合法呈现形式：原样，以及小数比例对应的百分比形式。 */
const numberForms = (value) => {
  const normalized = normalizeNumber(value);
  const forms = new Set([normalized]);
  if (normalized.startsWith("0.")) {
    const digits = normalized.slice(2).padStart(2, "0");
    const withDecimal = digits.length > 2 ? `${digits.slice(0, 2)}.${digits.slice(2)}` : digits;
    forms.add(withDecimal);
    forms.add(withDecimal.replace(/^0+(?=\d)/u, ""));
  }
  return [...forms];
};

const collectTexts = (analysis) => [
  analysis.scope_label ?? "",
  analysis.conclusion?.text ?? "",
  analysis.evidence?.text ?? "",
  analysis.impact?.text ?? "",
  analysis.limitations?.text ?? "",
  ...(analysis.limitations?.status_labels ?? []),
  ...(analysis.recommendations ?? []).map((item) => item.text ?? ""),
];

const collectEvidenceIds = (analysis) => [
  ...(analysis.conclusion?.evidence_ids ?? []),
  ...(analysis.evidence?.evidence_ids ?? []),
  ...(analysis.impact?.evidence_ids ?? []),
  ...(analysis.limitations?.evidence_ids ?? []),
  ...(analysis.recommendations ?? []).flatMap((item) => item.evidence_ids ?? []),
];

const containsNumber = (text, expected) => {
  const tokens = text.match(/[0-9][0-9,]*(?:\.[0-9]+)?/gu) ?? [];
  const actual = new Set(tokens.map(normalizeNumber));
  return numberForms(expected).some((form) => actual.has(form));
};

const judge = (spec, body) => {
  const checks = [];
  const add = (ok, label, detail = "") => checks.push({ ok, label, detail });

  add(body?.ok === true, "HTTP 响应成功", `ok=${String(body?.ok)}`);
  add(body?.status === "LIVE_GENERATED", "响应为 LIVE_GENERATED", `实际 ${String(body?.status)}`);

  const analysis = body?.answer?.analysis;
  if (analysis === undefined) {
    add(false, "响应携带 analysis", String(body?.message_zh ?? ""));
    return { passed: false, checks, analysis: null };
  }

  add(analysis.answer_type === "LIVE_GENERATED", "输出三检第①检（answer_type）");
  add((analysis.evidence_snapshot_ids ?? []).length > 0, "至少绑定一份真实快照");

  const texts = collectTexts(analysis);
  const allText = texts.join("\n");
  const labels = analysis.limitations?.status_labels ?? [];
  add(
    allText.includes("相关性不等于因果") ||
      labels.some((label) => String(label).includes("相关性不等于因果")),
    "限制区块含「相关性不等于因果」",
  );

  for (const [value, label] of spec.numbers ?? []) {
    add(containsNumber(allText, value), `数字精确一致：${label}`, value);
  }
  for (const phrase of spec.phrases ?? []) {
    add(allText.includes(phrase), `包含「${phrase}」`);
  }
  if (spec.requireAnyPhrase !== undefined) {
    add(
      spec.requireAnyPhrase.some((phrase) => allText.includes(phrase)),
      `包含语义之一：${spec.requireAnyPhrase.join(" / ")}`,
    );
  }
  if (spec.requireAnyPhrase2 !== undefined) {
    add(
      spec.requireAnyPhrase2.some((phrase) => allText.includes(phrase)),
      `包含粒度说明之一：${spec.requireAnyPhrase2.join(" / ")}`,
    );
  }
  for (const [pattern, label] of spec.forbidPatterns ?? []) {
    add(!pattern.test(allText), `未出现禁止表述：${label}`);
  }
  if (spec.emptyEvidenceIds === true) {
    const ids = collectEvidenceIds(analysis);
    add(ids.length === 0, "全篇 evidence_ids 为空", `${ids.length} 条`);
  }

  return { passed: checks.every((check) => check.ok), checks, analysis };
};

const postQuestion = async (question) => {
  const response = await fetch(`${BASE_URL}/api/v1/ai/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, page_address: PAGE_ADDRESS }),
  });
  const body = await response.json().catch(() => null);
  return { httpStatus: response.status, body };
};

const preflight = async () => {
  const key = process.env["DEEPSEEK_API_KEY"];
  record(
    typeof key === "string" && key.length > 0,
    "预检：DEEPSEEK_API_KEY",
    key ? "已配置（值不打印）" : "**缺失**",
  );
  record((process.env["LOGIPLAN_AI_LIVE_CALLS"] ?? "") === "1", "预检：LOGIPLAN_AI_LIVE_CALLS=1");
  record(
    (process.env["LOGIPLAN_AI_ANON_SECRET"] ?? "").length > 0,
    "预检：LOGIPLAN_AI_ANON_SECRET",
  );
  record(
    (process.env["UPSTASH_REDIS_REST_URL"] ?? "").length > 0 &&
      (process.env["UPSTASH_REDIS_REST_TOKEN"] ?? "").length > 0,
    "预检：Upstash REST 凭据",
  );
  record((process.env["DATABASE_URL"] ?? "").length > 0, "预检：DATABASE_URL");

  if ((process.env["LOGIPLAN_AI_LIVE_CALLS"] ?? "") !== "1" || !key) return false;

  // 配置了中继时，`DEEPSEEK_API_KEY` 只是中继令牌，探测也必须走同一个端点。
  const apiBase = (process.env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com").replace(
    /\/+$/u,
    "",
  );
  record(
    apiBase === "https://api.deepseek.com" ? "预检：直连供应商端点" : "预检：经中继端点",
    apiBase,
  );
  try {
    const probe = await fetch(`${apiBase}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    record(probe.ok, "预检：API 可达", `http=${probe.status}`);
    if (!probe.ok) return false;
    const payload = await probe.json();
    const ids = new Set((payload.data ?? []).map((model) => model.id));
    record(ids.has("deepseek-flash"), "预检：角色模型 deepseek-flash 可用");
  } catch (error) {
    record(false, "预检：API 可达", String(error));
    return false;
  }
  return true;
};

const main = async () => {
  console.log("\n=== 门 C 真实调用 · 9 题范围内子集评估 ===\n");
  const ready = await preflight();
  if (!ready) {
    console.log("\n=== 结论：前置条件不满足，未发起任何真实调用 ===\n");
    process.exitCode = 1;
    return;
  }

  let server = null;
  if (START_SERVER) {
    server = await startServer();
    record(server.failed !== true, "启动 `next start` 并等健康检查就绪", BASE_URL);
    if (server.failed === true) {
      await stopServer(server.child);
      process.exitCode = 1;
      return;
    }
  } else if (!(await healthOk())) {
    record(false, "复用已在运行的服务", `${BASE_URL}/api/health/live 不可达`);
    process.exitCode = 1;
    return;
  } else {
    record(true, "复用已在运行的服务", BASE_URL);
  }

  const before = await readUsage();
  record(before !== null, "账本基线可读", before ? `used_cny=${before.used_cny}` : "读不到");

  const entries = [];
  try {
    for (const spec of QUESTIONS) {
      console.log(`\n--- ${spec.id} ---`);
      let outcome;
      try {
        outcome = await postQuestion(spec.question);
      } catch (error) {
        console.log(`FAIL  请求异常 — ${String(error)}`);
        entries.push({
          id: spec.id,
          question: spec.question,
          passed: false,
          checks: [{ ok: false, label: "请求异常", detail: String(error) }],
          response: null,
        });
        continue;
      }
      const judged = judge(spec, outcome.body);
      for (const check of judged.checks) {
        console.log(
          `${check.ok ? "PASS" : "FAIL"}  ${check.label}${check.detail ? ` — ${check.detail}` : ""}`,
        );
      }
      entries.push({
        id: spec.id,
        question: spec.question,
        httpStatus: outcome.httpStatus,
        status: outcome.body?.status ?? null,
        passed: judged.passed,
        checks: judged.checks,
        analysis: judged.analysis,
        response: outcome.body,
      });
    }
  } finally {
    if (server !== null) await stopServer(server.child);
  }

  const after = await readUsage();
  const delta =
    before !== null && after !== null
      ? Number((after.used_cny - before.used_cny).toFixed(6))
      : null;
  record(delta !== null && delta > 0, "账本增量 > 0（预留已结算）", `Δused_cny=${String(delta)}`);

  const passed = entries.filter((entry) => entry.passed);
  const failed = entries.filter((entry) => !entry.passed);
  const report = {
    generated_at: new Date().toISOString(),
    scope: {
      page_address: PAGE_ADDRESS,
      evaluated: QUESTIONS.map((spec) => spec.id),
      out_of_scope: OUT_OF_SCOPE,
      note_zh:
        "仅覆盖当前英国归因页范围内的 9 题；范围外 11 题未执行，本报告不构成 20 题门槛结论。",
    },
    configuration: {
      base_url: BASE_URL,
      live_calls: process.env["LOGIPLAN_AI_LIVE_CALLS"] ?? "",
      model: "deepseek-flash",
    },
    ledger: { before, after, delta_used_cny: delta },
    summary: {
      evaluated: entries.length,
      passed: passed.length,
      failed: failed.length,
      passed_ids: passed.map((entry) => entry.id),
      failed_ids: failed.map((entry) => entry.id),
    },
    entries,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const jsonPath = join(OUTPUT_DIR, "report.json");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const lines = [
    "# AI 评估报告 · 英国归因页 9 题子集",
    "",
    `生成时间：${report.generated_at}`,
    `范围：\`${PAGE_ADDRESS}\``,
    "范围外未执行：E02—E04、E11—E18（11 题）。本报告不构成 20 题门槛结论。",
    "",
    `## 结果：${passed.length}/${entries.length} 通过`,
    "",
    "| 题号 | 结果 | 未通过项 |",
    "| --- | --- | --- |",
    ...entries.map((entry) => {
      const missing = entry.checks
        .filter((check) => !check.ok)
        .map((check) => check.label)
        .join("；");
      return `| ${entry.id} | ${entry.passed ? "通过" : "未通过"} | ${missing || "—"} |`;
    }),
    "",
    `账本增量：${delta === null ? "不可读" : delta}`,
    "",
    "> 每题完整响应与逐项判定见 `report.json`。数字回指由网关输出三检在服务端强制；",
    "> 本表的数字检查只验证题面要求的数值是否精确出现。",
    "",
  ];
  await writeFile(join(OUTPUT_DIR, "report.md"), lines.join("\n"), "utf8");

  console.log(
    `\n=== 结论：${passed.length}/${entries.length} 通过；报告 ${relative(process.cwd(), OUTPUT_DIR)} ===\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
};

await main();
