#!/usr/bin/env node
/**
 * DeepSeek 密钥中继（**在用户自己的机器上运行**，不在沙箱内运行）。
 *
 * 目的：让真实 `DEEPSEEK_API_KEY` 永远不进入评估沙箱。沙箱里的应用只持有
 * `RELAY_TOKEN` 与中继地址；中继校验令牌后，用自己的密钥向 DeepSeek 转发。
 *
 * ## 用法
 *
 * Windows PowerShell：
 *
 * ```powershell
 * $env:DEEPSEEK_API_KEY = "sk-..."          # 真实密钥，只存在于本机进程
 * $env:RELAY_TOKEN = "<随机串>"              # 沙箱使用的一次性令牌
 * node deepseek-relay.mjs
 * ```
 *
 * 另开一个终端把本机端口暴露为 HTTPS（任选其一）：
 *
 * ```powershell
 * cloudflared tunnel --url http://127.0.0.1:8787
 * ```
 *
 * ## 限制
 *
 * - 只允许 `GET /models` 与 `POST /responses`，其余路径一律 404。
 * - 只监听 `127.0.0.1`，外部访问必须经过隧道。
 * - 请求总数上限由 `MAX_REQUESTS` 控制（默认 40），超过后 429。
 * - 请求体上限 1 MiB；不记录请求体、响应体或任何请求头。
 * - 令牌用常量时间比较，避免长度/前缀侧信道。
 */

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL ?? "").replace(/\/+$/u, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 8787);
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS ?? 200);
const MAX_BODY_BYTES = 1024 * 1024;
const DEEPSEEK_UPSTREAM = "https://api.deepseek.com";

if (API_KEY.length === 0 || RELAY_TOKEN.length === 0) {
  console.error("缺少 DEEPSEEK_API_KEY 或 RELAY_TOKEN。");
  process.exit(1);
}
if ((UPSTASH_URL.length === 0) !== (UPSTASH_TOKEN.length === 0)) {
  console.error("UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN 必须同时提供。");
  process.exit(1);
}

let forwarded = 0;

const authorized = (header) => {
  if (typeof header !== "string") return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${RELAY_TOKEN}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const send = (response, status, payload) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const forward = async (response, url, method, body, token) => {
  forwarded += 1;
  try {
    const upstream = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    });
    response.end(text);
    console.log(`${method} ${new URL(url).pathname} -> ${upstream.status}`);
  } catch (error) {
    console.error(`${method} ${new URL(url).pathname} -> 上游失败：${String(error)}`);
    send(response, 502, { error: "UPSTREAM_UNAVAILABLE" });
  }
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`).pathname;

  if (!authorized(request.headers.authorization)) {
    send(response, 401, { error: "UNAUTHORIZED" });
    return;
  }
  if (forwarded >= MAX_REQUESTS) {
    send(response, 429, { error: "RELAY_QUOTA_EXHAUSTED", forwarded });
    return;
  }
  if (request.method === "GET" && path === "/models") {
    await forward(response, `${DEEPSEEK_UPSTREAM}/models`, "GET", undefined, API_KEY);
    return;
  }
  if (request.method === "POST" && path === "/responses") {
    try {
      const body = await readBody(request);
      await forward(response, `${DEEPSEEK_UPSTREAM}/responses`, "POST", body, API_KEY);
    } catch (error) {
      send(response, 413, { error: String(error) });
    }
    return;
  }
  if (UPSTASH_URL.length > 0 && path.startsWith("/upstash")) {
    try {
      const body = request.method === "GET" || request.method === "DELETE"
        ? undefined
        : await readBody(request);
      const suffix = path.slice("/upstash".length);
      await forward(response, `${UPSTASH_URL}${suffix}`, request.method, body, UPSTASH_TOKEN);
    } catch (error) {
      send(response, 413, { error: String(error) });
    }
    return;
  }
  send(response, 404, { error: "NOT_FOUND" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`中继已监听 http://127.0.0.1:${PORT}（上限 ${MAX_REQUESTS} 次）`);
  console.log("请用 cloudflared / ngrok 暴露为 HTTPS，然后把 URL 与 RELAY_TOKEN 写入沙箱 .env。");
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
