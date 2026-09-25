import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { childHasStopped, terminateProcessTree, waitForServer } from "./wait-for-server.mjs";

function runningChild() {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    pid: 1,
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("超时会中止已接受但永不响应的健康请求并自然释放资源", async () => {
  let requestAborted = false;
  const server = createServer((request) => {
    request.once("aborted", () => {
      requestAborted = true;
    });
  });
  const url = await listen(server);
  const port = Number(new URL(url).port);
  const child = runningChild();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const startedAt = Date.now();
  const pending = waitForServer(url, child, 120);
  const watchdog = Symbol("watchdog");
  let watchdogTimer;
  const watchdogPromise = new Promise((resolve) => {
    watchdogTimer = setTimeout(resolve, 600, watchdog);
  });

  try {
    const outcome = await Promise.race([
      pending.then(
        () => undefined,
        (error) => error,
      ),
      watchdogPromise,
    ]);
    clearTimeout(watchdogTimer);
    if (outcome === watchdog) server.closeAllConnections();
    const error = outcome === watchdog ? await pending.catch((caught) => caught) : outcome;
    assert.notEqual(outcome, watchdog, "waitForServer 超过外部看门狗仍未结束");
    assert(error instanceof Error);
    assert.equal(error.message, "等待本地 API 服务超时");
    assert(Date.now() - startedAt >= 80);
    assert(Date.now() - startedAt < 500);
    await delay(30);
    assert.equal(requestAborted, true);
    assert.deepEqual(unhandled, []);
    assert.equal(child.listenerCount("error"), 0);
  } finally {
    clearTimeout(watchdogTimer);
    process.removeListener("unhandledRejection", onUnhandled);
    await closeServer(server);
  }

  const rebound = createServer();
  await new Promise((resolve, reject) => {
    rebound.once("error", reject);
    rebound.listen(port, "127.0.0.1", resolve);
  });
  await closeServer(rebound);
});

test("健康响应成功后会清除该次请求的 deadline 定时器", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200).end("ok");
  });
  const url = await listen(server);
  const originalFetch = globalThis.fetch;
  let requestSignal;
  globalThis.fetch = (input, init) => {
    requestSignal = init?.signal;
    return originalFetch(input, init);
  };
  try {
    await waitForServer(url, runningChild(), 120);
    assert(requestSignal instanceof AbortSignal);
    await delay(180);
    assert.equal(requestSignal.aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
    await closeServer(server);
  }
});

test("连接失败后会在总 deadline 内重试并接受后续健康响应", async () => {
  const reservation = createServer();
  const url = await listen(reservation);
  await closeServer(reservation);
  const server = createServer((_request, response) => {
    response.writeHead(200).end("ok");
  });
  const delayedListen = delay(80).then(
    () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(new URL(url).port, "127.0.0.1", resolve);
      }),
  );
  try {
    await waitForServer(url, runningChild(), 800);
    await delayedListen;
  } finally {
    await closeServer(server);
  }
});

test("服务子进程已退出时保留提前退出错误", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: 17,
    signalCode: null,
    pid: 1,
  });
  await assert.rejects(
    waitForServer("http://127.0.0.1:1", child, 100),
    /本地 API 服务提前退出（code=17, signal=null）/u,
  );
});

test("服务子进程启动错误会在下一次轮询时报告", async () => {
  const child = runningChild();
  const pending = waitForServer("http://127.0.0.1:1", child, 800);
  setTimeout(() => child.emit("error", new Error("spawn failed")), 10);
  await assert.rejects(pending, /本地 API 服务无法启动：spawn failed/u);
});

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function waitForChildStop(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!childHasStopped(child) && Date.now() < deadline) {
    await delay(50);
  }
  assert(childHasStopped(child), "包装进程未在限定时间内退出");
}

async function waitForProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await delay(50);
  }
  assert.equal(isProcessAlive(pid), false, `后代进程 ${pid} 未被终止`);
}

test("进程树终止会一并结束后代进程", async () => {
  const wrapperSource = [
    'const { spawn } = require("node:child_process");',
    'const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {',
    '  stdio: "ignore",',
    "});",
    "process.stdout.write(String(grandchild.pid));",
    "setTimeout(() => {}, 60000);",
  ].join("\n");
  const wrapper = spawn(process.execPath, ["-e", wrapperSource], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: process.platform !== "win32",
  });
  let grandchildPid;
  try {
    grandchildPid = await new Promise((resolve, reject) => {
      let buffer = "";
      wrapper.once("error", reject);
      wrapper.once("exit", () => reject(new Error("包装进程提前退出")));
      wrapper.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        const parsed = Number.parseInt(buffer, 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) resolve(parsed);
      });
    });
    assert(isProcessAlive(grandchildPid), "后代进程应处于运行状态");

    terminateProcessTree(wrapper, "SIGKILL");
    await waitForChildStop(wrapper, 10_000);
    await waitForProcessGone(grandchildPid, 10_000);
  } finally {
    terminateProcessTree(wrapper, "SIGKILL");
  }
});

test("进程树终止在缺少 pid 时安全返回", () => {
  terminateProcessTree({ pid: undefined }, "SIGKILL");
});
