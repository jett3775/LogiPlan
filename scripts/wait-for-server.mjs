import { spawn } from "node:child_process";

export function childHasStopped(child) {
  return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
}

// Windows 下 child.kill 只终止直接子进程，会遗留 pnpm、Playwright、浏览器与 Next 等后代；
// 必须按进程树终止。POSIX 下以进程组为单位终止，失败时退回直接子进程信号。
//
// 进程组终止必须用 process.kill，不能用 child.kill：ChildProcess.kill 只接受 `[signal]`
// 一个参数，把 `-child.pid` 传进去会被当作信号名解析并抛 ERR_UNKNOWN_SIGNAL
// （实测消息为 "Unknown signal: -45592"），于是 catch 分支必然触发、退化成只杀直接子进程，
// 后代进程全部残留。process.kill(pid, signal) 才接受 pid，并支持负的进程组 ID。
// 本模块的调用方一律以 `detached: process.platform !== "win32"` 启动子进程，
// 因此 POSIX 下 child.pid 就是该子进程组的 PGID，`-child.pid` 指向正确的进程组。
export function terminateProcessTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function waitForServer(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let launchError;
  const onError = (error) => {
    launchError = error;
  };
  child.once("error", onError);
  try {
    while (Date.now() < deadline) {
      if (launchError !== undefined) {
        throw new Error(`本地 API 服务无法启动：${launchError.message}`, {
          cause: launchError,
        });
      }
      if (childHasStopped(child)) {
        throw new Error(
          `本地 API 服务提前退出（code=${String(child.exitCode)}, signal=${String(child.signalCode)}）`,
        );
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("等待本地 API 服务超时");
      const controller = new AbortController();
      const requestDeadline = setTimeout(() => controller.abort(), remainingMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.ok) return;
      } catch (error) {
        if (controller.signal.aborted) throw new Error("等待本地 API 服务超时", { cause: error });
        // The server may still be starting.
      } finally {
        clearTimeout(requestDeadline);
      }
      const retryDelayMs = Math.min(250, deadline - Date.now());
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    throw new Error("等待本地 API 服务超时");
  } finally {
    child.removeListener("error", onError);
  }
}
