import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import type { OpenAiResponsesClient } from "./client-types";
import { createFakeClient, fakeResponse, makeAdapter, sampleRequest } from "./test-doubles";

/**
 * 边界自证（切片 3a）：
 *
 * 1. 本包**非测试源码**不导入供应商 SDK、不读取环境变量 / 密钥、不含原始 IP / UA、
 *    不发起网络请求、不依赖 `@logiplan/ai`（单向依赖）；
 * 2. 导出面只有本包自己的中立类型（源码级断言 + 编译期结构兼容预检）；
 * 3. 本包只被 `packages/ai` 依赖、且不得从 `packages/ai` 的 barrel 导出；
 * 4. 运行期零网络：即便全局 `fetch` 被禁用，适配器仍只走注入的假客户端。
 */

const SRC_DIR = import.meta.dirname;
const PACKAGE_ROOT = join(SRC_DIR, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx|mts|cts)$/u.test(entry.name) ? [full] : [];
  });

const relative = (base: string, file: string): string =>
  file
    .slice(base.length + 1)
    .split(sep)
    .join("/");

const productionSources = sourceFiles(SRC_DIR)
  .filter((file) => !file.endsWith(".test.ts"))
  .map((file) => ({ file: relative(SRC_DIR, file), text: readFileSync(file, "utf8") }));

/**
 * 去掉注释后再做源码级断言：本包源码在 JSDoc 中**必须**写明「不得传原始 IP 或 User-Agent」
 * 等约束，若不去注释，这些合规文字会被误判为违规用法。
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");

const offendingFiles = (predicate: (text: string) => boolean): string[] =>
  productionSources.filter((source) => predicate(stripComments(source.text))).map((s) => s.file);

describe("供应商中立与零密钥（源码级）", () => {
  it("非测试源码不导入供应商 SDK（openai）", () => {
    expect(
      offendingFiles(
        (text) =>
          /\bfrom\s+["']openai["']/u.test(text) || /\brequire\(\s*["']openai["']/u.test(text),
      ),
    ).toEqual([]);
  });

  it("非测试源码不读取环境变量（不触碰任何 API key）", () => {
    expect(offendingFiles((text) => /\bprocess\.env\b/u.test(text))).toEqual([]);
  });

  it("非测试源码不含原始 IP / User-Agent 派生", () => {
    expect(
      offendingFiles((text) =>
        /x-forwarded-for|user-agent|userAgent|remoteAddress|remoteAddr|\.ip\b/iu.test(text),
      ),
    ).toEqual([]);
  });

  it("非测试源码不发起网络请求（无 fetch / http / axios / WebSocket）", () => {
    expect(
      offendingFiles((text) =>
        /\bfetch\s*\(|node:https?|from\s+["']axios["']|XMLHttpRequest|new WebSocket/u.test(text),
      ),
    ).toEqual([]);
  });

  it("非测试源码不依赖 @logiplan/ai（依赖方向单向）", () => {
    expect(offendingFiles((text) => /["']@logiplan\/ai["']/u.test(text))).toEqual([]);
  });

  it("依赖清单：精确版本 openai@7.5.0、private、无其它外部依赖", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      readonly name: string;
      readonly private: boolean;
      readonly dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe("@logiplan/ai-provider-openai");
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({ openai: "7.5.0" });
  });
});

describe("只被 packages/ai 依赖，且不进 packages/ai 的 barrel", () => {
  const importers = (): string[] => {
    const found: string[] = [];
    for (const root of [join(REPO_ROOT, "packages"), join(REPO_ROOT, "apps")]) {
      if (!existsSync(root)) continue;
      for (const file of sourceFiles(root)) {
        if (file.includes("ai-provider-openai")) continue;
        const text = stripComments(readFileSync(file, "utf8"));
        if (/["']@logiplan\/ai-provider-openai["']/u.test(text)) {
          found.push(relative(REPO_ROOT, file));
        }
      }
    }
    return found;
  };

  it("导入本包的包只能是 packages/ai（本切片为零）", () => {
    const offenders = importers().filter((file) => !file.startsWith("packages/ai/"));
    expect(offenders).toEqual([]);
  });

  it("packages/ai 的 barrel 不导出本包", () => {
    const barrel = join(REPO_ROOT, "packages", "ai", "src", "index.ts");
    expect(stripComments(readFileSync(barrel, "utf8"))).not.toContain("ai-provider-openai");
  });
});

describe("零网络（运行期自证）", () => {
  it("即便全局 fetch 被禁用，适配器仍只走注入的假客户端并成功", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): never => {
      throw new Error("network disabled in tests");
    };
    try {
      const { client, calls } = createFakeClient({ response: async () => fakeResponse() });
      const { adapter } = makeAdapter({ client });
      const result = await adapter.invoke(sampleRequest());
      expect(result.provider).toBe("openai");
      expect(calls.responses).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("切片 3b 接线预检：真实 SDK 客户端结构上可赋给中立客户端接口", () => {
  it("类型级断言（编译期）——真实 OpenAI 客户端满足本包的最小结构接口", () => {
    // 仅做类型检查，运行期不构造任何客户端、不读取密钥、不联网。
    const sdkClient = undefined as unknown as OpenAI;
    const compatible: OpenAiResponsesClient = sdkClient;
    expect(compatible).toBeUndefined();
  });
});
