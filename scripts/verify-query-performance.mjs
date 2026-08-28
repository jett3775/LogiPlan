import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

const concurrency = 5;
const requestCount = 100;
const p95LimitMs = 1_000;
const port = Number.parseInt(process.env.LOGIPLAN_PERF_PORT ?? "3217", 10);
const origin = `http://127.0.0.1:${port}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert(value, `缺少环境变量：${name}`);
  return value;
}

function percentile(sorted, value) {
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
}

function canConnect() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const commonScope = {
  period: { from: "2026-01", to: "2026-12", grain: "MONTH" },
  comparison: "LATEST_OUTLOOK_VS_BUDGET",
  budget_version_id: "BUDGET_2026_V1",
  actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
  forecast_version_id: "FORECAST_2026_08_V1",
  calculation_version: "D-092",
};

const queries = [
  {
    question_type: "MONTHLY_COST_TREND",
    scope: commonScope,
    metrics: ["LOGISTICS_TOTAL_COST"],
    group_by: ["MONTH"],
    output_locale: "zh-CN",
    context_sources: ["FIXED_TEMPLATE"],
  },
  {
    question_type: "TOP_ADVERSE_ANOMALIES",
    scope: commonScope,
    metrics: ["FULFILLMENT_VARIABLE_COST"],
    group_by: ["MONTH", "DESTINATION_COUNTRY"],
    top_n: 5,
    output_locale: "zh-CN",
    context_sources: ["FIXED_TEMPLATE"],
  },
  {
    question_type: "FIXED_COST_BREAKDOWN",
    scope: { ...commonScope, period: { ...commonScope.period, grain: "RANGE" } },
    metrics: ["LOGISTICS_FIXED_COST"],
    group_by: ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"],
    output_locale: "zh-CN",
    context_sources: ["FIXED_TEMPLATE"],
  },
  {
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
  },
];

function assertServerRunning(state, logs) {
  if (state.spawnError) throw state.spawnError;
  if (state.exited) {
    throw new Error(
      `本次启动的应用进程提前退出（code=${state.code}, signal=${state.signal}）：${logs.join("").slice(-2_000)}`,
    );
  }
}

async function requestQuery(query, state, logs) {
  assertServerRunning(state, logs);
  const startedAt = performance.now();
  const response = await fetch(`${origin}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  assertServerRunning(state, logs);
  const body = await response.json();
  assert(
    response.status === 200,
    `${query.question_type} 返回 HTTP ${response.status}: ${JSON.stringify(body)}`,
  );
  assert(
    typeof body.result_id === "string" &&
      body.query_intent?.question_type === query.question_type &&
      body.payload !== null &&
      typeof body.payload === "object" &&
      Array.isArray(body.evidence),
    `${query.question_type} 未返回真实确定性查询 payload`,
  );
  if (query.question_type === "DIAGNOSTIC_METRICS") {
    const diagnostics = body.payload.diagnostics;
    const metric = (id) => diagnostics.find((item) => item.diagnostic_id === id);
    assert(
      metric("AIR_SHARE")?.current?.display === "66.02" &&
        metric("AIR_SHARE")?.delta?.display === "52.32" &&
        metric("CARRIER_C_SHARE")?.current?.display === "38.84" &&
        metric("CARRIER_C_SHARE")?.delta?.display === "35.96" &&
        metric("ON_TIME_RATE")?.current?.display === "96.16" &&
        metric("SERVICE_MATURITY")?.current?.display === "92.00",
      "DIAGNOSTIC_METRICS 固定值不一致",
    );
    assert(
      body.warnings?.some((warning) => warning.code === "SERVICE_NOT_MATURE"),
      "DIAGNOSTIC_METRICS 缺少服务未成熟警告",
    );
  }
  return performance.now() - startedAt;
}

async function waitForApplication(state, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertServerRunning(state, logs);
    try {
      const response = await fetch(`${origin}/api/health/live`, { redirect: "manual" });
      const body = await response.json();
      if (response.status === 200 && body.status === "ok" && /Ready in/i.test(logs.join("")))
        return;
    } catch {
      assertServerRunning(state, logs);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`构建后应用未在 30 秒内启动：${logs.join("").slice(-2_000)}`);
}

async function waitForExit(state, exitPromise, timeoutMs) {
  if (state.exited) return true;
  return Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function terminateServer(server, state, exitPromise) {
  if (!state.exited && !state.spawnError) {
    server.kill();
    if (!(await waitForExit(state, exitPromise, 2_000))) {
      if (process.platform === "win32" && server.pid !== undefined) {
        spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        server.kill("SIGKILL");
      }
      assert(await waitForExit(state, exitPromise, 5_000), "无法强制终止性能验收应用进程");
    }
  }
  const deadline = Date.now() + 5_000;
  while ((await canConnect()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(!(await canConnect()), `性能验收结束后端口 ${port} 仍被占用`);
}

async function verify() {
  const databaseUrl = new URL(requiredEnvironment("DATABASE_URL"));
  assert(
    ["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname),
    "性能验收只允许连接本地隔离数据库",
  );
  assert(Number.isInteger(port) && port > 0 && port <= 65_535, "LOGIPLAN_PERF_PORT 无效");
  assert(!(await canConnect()), `性能验收端口 ${port} 已被其他服务占用`);
  await access(new URL("../apps/web/.next/BUILD_ID", import.meta.url));

  const logs = [];
  const defaultServerEntry = fileURLToPath(
    new URL("../apps/web/node_modules/next/dist/bin/next", import.meta.url),
  );
  const serverEntry = process.env.LOGIPLAN_PERF_SERVER_ENTRY ?? defaultServerEntry;
  const server = spawn(
    process.execPath,
    [serverEntry, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: fileURLToPath(new URL("../apps/web", import.meta.url)),
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const state = { spawnError: null, exited: false, code: null, signal: null };
  const exitPromise = new Promise((resolve) => {
    server.once("exit", (code, signal) => {
      state.exited = true;
      state.code = code;
      state.signal = signal;
      resolve();
    });
  });
  server.once("error", (error) => {
    state.spawnError = error;
  });
  server.stdout.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    await waitForApplication(state, logs);
    for (const query of queries) await requestQuery(query, state, logs);

    const durations = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (true) {
          const index = cursor++;
          if (index >= requestCount) return;
          durations.push(await requestQuery(queries[index % queries.length], state, logs));
        }
      }),
    );

    const sorted = durations.toSorted((left, right) => left - right);
    const summary = {
      concurrency,
      requests: sorted.length,
      query_mix: Object.fromEntries(
        queries.map((query, index) => [
          query.question_type,
          Math.floor((requestCount + queries.length - 1 - index) / queries.length),
        ]),
      ),
      p50_ms: Number(percentile(sorted, 0.5).toFixed(3)),
      p95_ms: Number(percentile(sorted, 0.95).toFixed(3)),
      p99_ms: Number(percentile(sorted, 0.99).toFixed(3)),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    assert(summary.p95_ms <= p95LimitMs, `热查询 P95 ${summary.p95_ms} ms 超过 1000 ms`);
  } finally {
    await terminateServer(server, state, exitPromise);
  }
}

await verify().catch((error) => {
  const message = error instanceof Error ? error.message : "未知性能验证错误";
  process.stderr.write(`查询性能验证失败：${message}\n`);
  process.exitCode = 1;
});
