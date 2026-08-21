import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const composeArguments = process.argv.slice(2);
if (composeArguments.length === 0) {
  process.stderr.write("缺少 Docker Compose 参数\n");
  process.exit(1);
}

const windowsDockerFromWsl = "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe";
const candidates = [process.env.DOCKER_CLI, "docker"];
if (process.platform === "win32") {
  candidates.push("docker.exe");
} else if (existsSync(windowsDockerFromWsl)) {
  candidates.push(windowsDockerFromWsl);
}

let selected;
const failures = [];
for (const candidate of [...new Set(candidates.filter(Boolean))]) {
  const check = spawnSync(candidate, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (check.status === 0 && check.stdout.trim().length > 0) {
    selected = candidate;
    break;
  }
  failures.push(`${candidate}: ${(check.stderr || check.error?.message || "连接失败").trim()}`);
}

if (selected === undefined) {
  process.stderr.write(`无法连接 Docker 引擎：\n${failures.join("\n")}\n`);
  process.exit(1);
}

const result = spawnSync(selected, ["compose", ...composeArguments], {
  stdio: "inherit",
  windowsHide: true,
});
if (result.error !== undefined) {
  process.stderr.write(`Docker Compose 启动失败：${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
