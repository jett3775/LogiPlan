#!/usr/bin/env node
/**
 * 门 C 小规模真实验收（D-192 阶段 2）。
 *
 * 走**正式网关路径**（HTTP `/api/v1/ai/respond`），因此验的是装配层 + 控制面 + 网关 + 适配器
 * 的真实组合，而不是某段替身逻辑。
 *
 * ## 用法
 *
 * ```bash
 * pnpm build
 * LOGIPLAN_AI_LIVE_CALLS=1 DEEPSEEK_API_KEY=... node --env-file-if-exists=.env \
 *   scripts/ai-live-acceptance.mjs --base-url=http://127.0.0.1:4173
 * ```
 *
 * 服务器需已用**同一组环境变量**启动（`pnpm --filter @logiplan/web start`）。本脚本不自己
 * 起服务：`next start` 的收尾在会话内不稳定，交给调用方控制生命周期。
 *
 * ## 两种模式
 *
 * - **开关关闭**（默认）：断言响应为 `FIXED_EXAMPLE` 且账本**零变化**——用于在**零花费**下
 *   验证验收装置本身可用。
 * - **开关打开**（`LOGIPLAN_AI_LIVE_CALLS=1`）：断言响应为 `LIVE_GENERATED`、输出三检通过、
 *   账本增量与结算一致——这才是真实调用验收。
 *
 * ## 预检（不花钱）
 *
 * ① `DEEPSEEK_API_KEY` 是否存在（D-193 决策五）；② API 是否可达；③ **配置的角色模型是否在
 * 账号模型表内**（`deepseek-flash`，D-193 决策一）；④ 控制面账本基线是否读得到。
 */

import { spawn } from "node:child_process";

const args = new Map(
  process.argv.slice(2).map((item) => {
    const [key, ...rest] = item.replace(/^--/u, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const BASE_URL = args.get("base-url") ?? "http://127.0.0.1:4173";
const LIVE = process.env["LOGIPLAN_AI_LIVE_CALLS"] === "1";
const START_SERVER = args.get("start-server") !== "false";
const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const PAGE_ADDRESS = "/attribution?destination=GB&period=2026-08";
const QUESTION = "2026 年 8 月英国履约变动成本相对 Budget 偏差多少？";

/** 冻结的角色配置（`packages/ai/src/config/role-config.ts`，D-193 决策一）。 */
const CONFIGURED_MODELS = ["deepseek-flash"];

const results = [];
const record = (ok, label, detail = "") => {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
};

/** 读取只读月度用量（AC2.11 CLI，只读、不写账本）。 */
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

/**
 * 起一个 `next start` 子进程并等它就绪。
 *
 * 为什么由本脚本起服务：Next 只在**项目目录**（`apps/web`）找 `.env`，仓库根的 `.env` 不会
 * 被加载 ⇒ `DATABASE_URL` 缺失 ⇒ 确定性查询失败、响应变成 `DETERMINISTIC_SOURCE_UNAVAILABLE`。
 * 本脚本以 `node --env-file-if-exists=.env` 启动，`process.env` 已含全部变量，子进程直接继承。
 */
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

const postAi = async () => {
  const response = await fetch(`${BASE_URL}/api/v1/ai/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: QUESTION, page_address: PAGE_ADDRESS }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const main = async () => {
  console.log(
    `\n=== 门 C 小规模真实验收（LIVE_CALLS=${LIVE ? "1（真实调用）" : "关闭（零花费）"}）===\n`,
  );

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

  try {
    await runChecks();
  } finally {
    if (server !== null) await stopServer(server.child);
  }
};

const runChecks = async () => {
  // ---- 预检（不花钱）----
  const apiKey = process.env["DEEPSEEK_API_KEY"];
  record(
    LIVE ? typeof apiKey === "string" && apiKey.length > 0 : true,
    "预检 ①：DEEPSEEK_API_KEY",
    LIVE ? (apiKey ? "已配置（值不打印）" : "**缺失**") : "开关关闭，跳过",
  );

  if (LIVE) {
    let reachable = false;
    try {
      const probe = await fetch("https://api.deepseek.com/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      reachable = probe.ok;
      record(probe.ok, "预检 ②：API 可达", `http=${probe.status}`);
      if (probe.ok) {
        const payload = await probe.json();
        const ids = new Set((payload.data ?? []).map((model) => model.id));
        const missing = CONFIGURED_MODELS.filter((model) => !ids.has(model));
        record(
          missing.length === 0,
          "预检 ③：角色配置模型在账号内可用",
          missing.length === 0 ? CONFIGURED_MODELS.join(", ") : `缺失：${missing.join(", ")}`,
        );
      }
    } catch (error) {
      record(false, "预检 ②：API 可达", String(error));
    }
    if (!reachable) console.log("\n⚠️ API 不可达 ⇒ 后续真实调用必然回落固定示例。");
  } else {
    console.log("PASS  预检 ②③：开关关闭，跳过 API 与模型可用性检查");
  }

  const before = await readUsage();
  record(
    before !== null,
    "预检 ④：控制面账本基线可读",
    before ? `used_cny=${before.used_cny}` : "读不到（控制面不可用？）",
  );

  // ---- 真实请求（走正式 HTTP 路径）----
  let outcome;
  try {
    outcome = await postAi();
  } catch (error) {
    record(false, "请求 /api/v1/ai/respond", String(error));
    return;
  }
  const body = outcome.body ?? {};
  record(
    outcome.status === 200 && body.ok === true,
    "HTTP 200 + ok:true",
    `http=${outcome.status}`,
  );

  const expectedStatus = LIVE ? "LIVE_GENERATED" : "FIXED_EXAMPLE";
  record(
    body.status === expectedStatus,
    `响应状态为 ${expectedStatus}`,
    `实际 ${String(body.status)}（status_label_zh=${String(body.status_label_zh)}）`,
  );

  if (body.answer) {
    const analysis = body.answer.analysis ?? {};
    record(
      analysis.answer_type === expectedStatus,
      "输出三检通过（answer_type 与状态一致）",
      `answer_type=${String(analysis.answer_type)}`,
    );
    record(
      Array.isArray(analysis.evidence_snapshot_ids) && analysis.evidence_snapshot_ids.length > 0,
      "多快照绑定（D-191）",
      `${(analysis.evidence_snapshot_ids ?? []).length} 份`,
    );
    const labels = analysis.limitations?.status_labels ?? [];
    record(
      labels.some((label) => String(label).includes("相关性不等于因果")),
      "强制限制标签存在",
    );
  } else {
    record(false, "响应携带 answer", `message_zh=${String(body.message_zh)}`);
  }

  // ---- 账本核对 ----
  const after = await readUsage();
  if (before !== null && after !== null) {
    const delta = Number((after.used_cny - before.used_cny).toFixed(6));
    if (LIVE) {
      record(delta > 0, "账本增量 > 0（预留已被结算为实际）", `Δused_cny=${delta}`);
    } else {
      record(delta === 0, "账本零变化（开关关闭时不预留、不结算）", `Δused_cny=${delta}`);
    }
  } else {
    record(false, "账本核对", "前后至少一次读不到用量");
  }

  const failed = results.filter((item) => !item.ok);
  console.log(
    `\n=== 结论：${failed.length === 0 ? "PASS" : `FAIL（${failed.length} 项未过）`} ===\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
};

await main();
