import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * AC2.12：切片 2 结束时**仍无任何真实模型调用路径被激活**——用测试锁定。
 *
 * 自证口径：
 * 1. `packages/ai` 非测试源码中不存在 `LIVE_GENERATED`（沿用并强化 `neutral-boundary.test.ts`）；
 * 2. 不存在任何供应商适配器实现被导入或装配（`ProviderAdapter` 只作为**契约声明**出现）；
 * 3. 成本包围只产出「是否允许真实调用」的**许可**，不产出任何模型回答；
 * 4. 重试入口以**注入函数**给出，本包内没有任何具体适配器实例。
 */

const SRC_DIR = import.meta.dirname;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });

const relative = (file: string): string =>
  file
    .slice(SRC_DIR.length + 1)
    .split(sep)
    .join("/");

const productionSources = sourceFiles(SRC_DIR)
  .filter((file) => !file.endsWith(".test.ts"))
  .map((file) => ({ file: relative(file), text: readFileSync(file, "utf8") }));

describe("无真实模型调用路径（AC2.12）", () => {
  it("非测试源码中零处出现 LIVE_GENERATED", () => {
    const offenders = productionSources
      .filter((source) => source.text.includes("LIVE_GENERATED"))
      .map((source) => source.file);
    expect(offenders).toEqual([]);
  });

  it("ProviderAdapter 只作为契约声明出现，无任何实现被导入或装配", () => {
    const allowed = new Set(["adapter/adapter-contract.ts", "index.ts"]);
    const offenders = productionSources
      .filter((source) => /ProviderAdapter/u.test(source.text) && !allowed.has(source.file))
      .map((source) => source.file);
    expect(offenders).toEqual([]);
  });

  it("不导入任何供应商适配器包（packages/ai-provider-*）", () => {
    const offenders: string[] = [];
    for (const source of productionSources) {
      for (const match of source.text.matchAll(/from\s+"([^"]+)"/gu)) {
        const specifier = match[1] ?? "";
        if (specifier.includes("ai-provider")) offenders.push(`${source.file} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("控制面模块只产出许可与审计，不产出模型回答字段", () => {
    const controlPlane = productionSources.filter((source) =>
      source.file.startsWith("control-plane/"),
    );
    expect(controlPlane.length).toBeGreaterThanOrEqual(6);
    for (const source of controlPlane) {
      expect(source.text, source.file).not.toContain("structuredOutput");
      expect(source.text, source.file).not.toContain("providerRequestId");
    }
  });

  it("重试入口为注入函数，本包内无具体适配器实例", () => {
    const retry = productionSources.find((source) =>
      source.file.endsWith("gateway/retry-policy.ts"),
    );
    expect(retry).toBeDefined();
    // 只允许类型导入适配器契约；不得 import 任何适配器实现。
    const valueImports = [
      ...(retry?.text ?? "").matchAll(/import\s+(?!type\b)[^;]*from\s+"([^"]+)"/gu),
    ];
    for (const match of valueImports) {
      expect(match[1]).toMatch(/^\./u);
    }
  });
});

/**
 * P1-1 回归：主 barrel（`index.ts`）被**客户端组件**消费，因此从它出发的**静态模块图**
 * 不得可达 `@upstash/redis`（否则服务端基础设施会被打进浏览器包）。这条断言直接检查
 * 源码级可达性，比「`@upstash` 只出现在某个文件」更强：后者看不到 barrel 的再导出链。
 */
describe("主 barrel 静态可达性（P1-1 回归）", () => {
  const indexFile = join(SRC_DIR, "index.ts");

  const resolveRelative = (fromFile: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const base = join(dirname(fromFile), specifier);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  /** 从入口出发、跟随相对 `from "..."` 再导出/导入的可达文件集合。 */
  const reachableFrom = (entry: string): string[] => {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const file = stack.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/gu)) {
        const target = resolveRelative(file, match[1] ?? "");
        if (target !== null) stack.push(target);
      }
    }
    return [...seen];
  };

  it("从 index.ts 出发的模块图不可达 @upstash/redis，也不可达服务端装配入口", () => {
    const reachableRaw = reachableFrom(indexFile);
    const reachable = reachableRaw.map(relative);
    const offenders = reachableRaw
      .filter((file) => readFileSync(file, "utf8").includes("@upstash"))
      .map(relative);
    expect(offenders).toEqual([]);
    expect(reachable.some((file) => file.endsWith("control-plane/upstash-redis.ts"))).toBe(false);
    expect(reachable.some((file) => file.endsWith("control-plane/server.ts"))).toBe(false);
  });

  it("（正对照）可达性检查确实跟随相对再导出链", () => {
    const reachable = reachableFrom(indexFile).map(relative);
    expect(reachable.some((file) => file.endsWith("control-plane/control-plane.ts"))).toBe(true);
    expect(reachable.some((file) => file.endsWith("gateway/retry-policy.ts"))).toBe(true);
  });
});
