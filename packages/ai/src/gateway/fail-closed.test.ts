import { describe, expect, it } from "vitest";

import { buildFixedExampleAnalysis } from "../fixed-example/fixed-example";
import {
  AI_ROLES,
  resolveRoleRoute,
  resolveRoleRouteWithCapabilities,
  type RoleRouteConfig,
} from "../routing/role-routing";
import { GATEWAY_ERROR_CODES } from "./gateway-error-code";
import {
  FAIL_CLOSED_TRIGGERS,
  allFailClosedDecisions,
  decideFailClosed,
  type FailClosedSource,
} from "./fail-closed";

/**
 * AC1.3：`answer_type` 恒为 `FIXED_EXAMPLE`，本切片不存在任何产生
 * `LIVE_GENERATED` 的路径。
 *
 * AC1.8（映射表部分）：错误码与失败关闭矩阵的穷尽性。
 */

const ANALYSIS = buildFixedExampleAnalysis();

describe("AC1.3 恒为固定示例", () => {
  it("固定示例出口的 answer_type 是 FIXED_EXAMPLE", () => {
    expect(ANALYSIS.answer_type).toBe("FIXED_EXAMPLE");
  });

  it("每个标准化错误码的失败关闭决策都落到固定示例", () => {
    for (const code of GATEWAY_ERROR_CODES) {
      const decision = decideFailClosed(code);
      expect(decision.answerType).toBe("FIXED_EXAMPLE");
      expect(decision.liveCallAllowed).toBe(false);
      expect(decision.deterministicAnalysisAffected).toBe(false);
      expect(decision.statusZh.length).toBeGreaterThan(0);
      expect(decision.triggersZh.length).toBeGreaterThan(0);
    }
    expect(allFailClosedDecisions()).toHaveLength(GATEWAY_ERROR_CODES.length);
  });

  it("不存在任何返回答案类型的路由或适配器出口", () => {
    const route = resolveRoleRoute(
      [
        {
          role: "management_analysis",
          provider: "PROVIDER_A",
          model: "MODEL_A",
          maxOutputTokens: 1_200,
          systemPromptVersion: "PROMPT_V1",
          outputSchemaVersion: "G2_ANSWER_V1_0",
          requiredCapabilities: ["structuredOutput"],
          verified: true,
        },
      ],
      "management_analysis",
    );
    expect(route.ok).toBe(true);
    expect(JSON.stringify(route)).not.toMatch(/answer_type|LIVE_GENERATED/u);
    expect(JSON.stringify(ANALYSIS)).not.toContain("LIVE_GENERATED");
  });
});

describe("AC1.8 错误码与失败关闭矩阵的穷尽性", () => {
  it("错误码集合与设计文档一致", () => {
    expect([...GATEWAY_ERROR_CODES]).toEqual([
      "INPUT_REJECTED",
      "SCHEMA_VALIDATION_FAILED",
      "EVIDENCE_WHITELIST_VIOLATION",
      "NUMERIC_MISMATCH",
      "PROVIDER_TIMEOUT",
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_REQUEST_INVALID",
      "BUDGET_EXCEEDED",
      "RATE_LIMITED",
      "CONTROL_PLANE_UNAVAILABLE",
    ]);
  });

  it("每个错误码都至少出现在矩阵的一行里（新增码必须补矩阵行）", () => {
    const matrixCodes = new Set(FAIL_CLOSED_TRIGGERS.map((trigger) => trigger.errorCode));
    for (const code of GATEWAY_ERROR_CODES) {
      expect(matrixCodes.has(code), `${code} 缺少失败关闭矩阵行`).toBe(true);
    }
  });

  it("矩阵每行都是失败关闭且中文说明非空", () => {
    for (const trigger of FAIL_CLOSED_TRIGGERS) {
      const decision = decideFailClosed(trigger.errorCode);
      expect(decision.answerType).toBe("FIXED_EXAMPLE");
      expect(decision.triggersZh).toContain(trigger.triggerZh);
      expect(trigger.triggerZh.trim().length).toBeGreaterThan(0);
    }
  });

  it("失败来源取值被冻结", () => {
    const sources = new Set<FailClosedSource>(FAIL_CLOSED_TRIGGERS.map((t) => t.source));
    expect([...sources].sort()).toEqual([
      "BUDGET",
      "CIRCUIT_BREAKER",
      "CONTROL_PLANE",
      "INPUT_VALIDATION",
      "OUTPUT_VALIDATION",
      "PROVIDER_TRANSPORT",
    ]);
  });

  it("角色集合被冻结为三个", () => {
    expect([...AI_ROLES]).toEqual(["intent_parse", "management_analysis", "fallback"]);
  });

  it("能力门缺失时返回标准化错误码，不降级", () => {
    const routes: RoleRouteConfig[] = [
      {
        role: "intent_parse",
        provider: "PROVIDER_A",
        model: "MODEL_A",
        maxOutputTokens: 400,
        systemPromptVersion: "PROMPT_V1",
        outputSchemaVersion: "G2_ANSWER_V1_0",
        requiredCapabilities: ["structuredOutput", "moderation"],
        verified: true,
      },
    ];
    expect(resolveRoleRouteWithCapabilities(routes, "intent_parse", ["structuredOutput"]).ok).toBe(
      false,
    );
    const denied = resolveRoleRouteWithCapabilities(routes, "intent_parse", ["structuredOutput"]);
    if (denied.ok) throw new Error("能力缺失时必须失败关闭");
    expect(denied.errorCode).toBe("PROVIDER_REQUEST_INVALID");
    expect(denied.missingCapabilities).toEqual(["moderation"]);
    expect(
      resolveRoleRouteWithCapabilities(routes, "intent_parse", ["structuredOutput", "moderation"]),
    ).toMatchObject({ ok: true });
  });
});
