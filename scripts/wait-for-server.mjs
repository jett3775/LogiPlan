export function childHasStopped(child) {
  return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
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
