import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AI_ROLE_CONFIG_VERSION, AI_ROLE_ROUTES, roleConfigFor } from "./role-config";
import {
  REGISTERED_OUTPUT_SCHEMA_VERSIONS,
  REGISTERED_SYSTEM_PROMPT_VERSIONS,
  resolveOutputSchema,
  resolveSystemPrompt,
} from "./registry";

/**
 * 角色配置与版本注册表（D-190 决策二；切片 3b 协调项 4）。
 */

describe("角色配置（D-190 决策二）", () => {
  it("三个角色齐全、均标记为已验证、provider 标识为中立字符串", () => {
    expect(AI_ROLE_ROUTES).toHaveLength(3);
    expect(AI_ROLE_CONFIG_VERSION.length).toBeGreaterThan(0);
    for (const route of AI_ROLE_ROUTES) {
      expect(route.verified).toBe(true);
      expect(route.provider).toBe("openai");
      expect(route.model.length).toBeGreaterThan(0);
    }
  });

  it("roleConfigFor：已知角色返回配置，未知角色失败关闭为 null", () => {
    expect(roleConfigFor("management_analysis")?.model).toBe("gpt-5.6-terra");
    expect(roleConfigFor("nope" as never)).toBeNull();
  });

  it("不得用环境变量覆盖（D-190 决策二明确排除混合方案）", () => {
    const source = readFileSync(join(import.meta.dirname, "role-config.ts"), "utf8");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("env.");
  });
});

describe("提示词 / 输出模式版本注册表（协调项 4）", () => {
  it("三个角色的提示词与输出模式版本都在注册表内（未知版本 → null）", () => {
    for (const route of AI_ROLE_ROUTES) {
      expect(resolveSystemPrompt(route.systemPromptVersion), route.role).not.toBeNull();
      expect(resolveOutputSchema(route.outputSchemaVersion), route.role).not.toBeNull();
      expect(REGISTERED_SYSTEM_PROMPT_VERSIONS).toContain(route.systemPromptVersion);
      expect(REGISTERED_OUTPUT_SCHEMA_VERSIONS).toContain(route.outputSchemaVersion);
    }
  });

  it("未知版本 → null（适配器据此返回 PROVIDER_REQUEST_INVALID）", () => {
    expect(resolveSystemPrompt("unknown-prompt")).toBeNull();
    expect(resolveOutputSchema("unknown-schema")).toBeNull();
    expect(resolveSystemPrompt("")).toBeNull();
  });

  it("管理分析输出模式由公共 Zod 模式生成，含十个顶层字段（不手抄，避免漂移）", () => {
    const schema = resolveOutputSchema("G2_ANSWER_V1_0");
    const properties = (schema as { readonly properties?: Record<string, unknown> }).properties;
    expect(properties).toBeDefined();
    expect(Object.keys(properties ?? {}).sort()).toEqual(
      [
        "answer_id",
        "answer_type",
        "conclusion",
        "evaluation_question_ids",
        "evidence",
        "evidence_snapshot_id",
        "impact",
        "limitations",
        "recommendations",
        "scope_label",
      ].sort(),
    );
  });
});
