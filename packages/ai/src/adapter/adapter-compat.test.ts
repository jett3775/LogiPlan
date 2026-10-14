import {
  ADAPTER_EMITTED_ERROR_CODES,
  ADAPTER_ROLES,
  NEUTRAL_LAYER_ERROR_CODES,
  PROVIDER_CAPABILITY_NAMES,
  reasoningEffortForRole,
  requiredCapabilitiesForRole,
  type AdapterRequest as ProviderAdapterRequest,
  type AdapterResult as ProviderAdapterResult,
  type ProviderAdapter as ProviderAdapterContract,
} from "@logiplan/ai-provider-openai";
import { describe, expect, it } from "vitest";

import { AI_ROLE_ROUTES, roleConfigFor } from "../config/role-config";
import { GATEWAY_ERROR_CODES } from "../gateway/gateway-error-code";
import { ROLE_REASONING_EFFORTS } from "../routing/role-routing";
import type {
  AdapterRequest as NeutralAdapterRequest,
  AdapterResult as NeutralAdapterResult,
  ProviderAdapter as NeutralProviderAdapter,
} from "./adapter-contract";

/**
 * 契约类型双份的编译期兼容断言（切片 3b 协调项 3）与角色配置核对（协调项 1）。
 *
 * 3a 的 `packages/ai-provider-openai/src/contract.ts` 与中立层
 * `packages/ai/src/adapter/adapter-contract.ts` 各有一份结构相同的类型——因单向依赖
 * （`ai → ai-provider-*`）不能反向 import，两份无法合并。本测试在**中立层侧**用
 * 「适配器类型可赋给中立契约类型」的编译期断言把漂移暴露在 `typecheck` 阶段，
 * **不引入依赖环**（适配器包不 import 本包）。
 */

describe("编译期：适配器类型可赋给中立契约类型（结构兼容）", () => {
  it("AdapterRequest / AdapterResult / ProviderAdapter 三个方向均兼容", () => {
    const providerRequest = null as unknown as ProviderAdapterRequest;
    const neutralRequest: NeutralAdapterRequest = providerRequest;
    const providerResult = null as unknown as ProviderAdapterResult;
    const neutralResult: NeutralAdapterResult = providerResult;
    const providerAdapter = null as unknown as ProviderAdapterContract;
    const neutralAdapter: NeutralProviderAdapter = providerAdapter;
    expect([neutralRequest, neutralResult, neutralAdapter]).toEqual([null, null, null]);
  });
});

describe("角色配置与适配器需求侧逐角色一致（协调项 1）", () => {
  it("角色集合一致：配置覆盖全部适配器角色", () => {
    expect([...AI_ROLE_ROUTES.map((route) => route.role)].sort()).toEqual(
      [...ADAPTER_ROLES].sort(),
    );
  });

  it("每个角色的必需能力与适配器声明一致", () => {
    for (const role of ADAPTER_ROLES) {
      const route = roleConfigFor(role);
      expect(route, role).not.toBeNull();
      expect(route?.requiredCapabilities).toEqual(requiredCapabilitiesForRole(role));
      expect(route?.requiredCapabilities).toEqual(PROVIDER_CAPABILITY_NAMES);
    }
  });

  it("每个角色的推理强度与适配器一致（D-180）", () => {
    for (const role of ADAPTER_ROLES) {
      expect(roleConfigFor(role)?.reasoningEffort).toBe(reasoningEffortForRole(role));
      expect(ROLE_REASONING_EFFORTS).toContain(roleConfigFor(role)?.reasoningEffort);
    }
  });

  it("D-180 冻结的模型与输出上限", () => {
    expect(roleConfigFor("intent_parse")?.model).toBe("gpt-5.6-luna");
    expect(roleConfigFor("intent_parse")?.maxOutputTokens).toBe(400);
    expect(roleConfigFor("management_analysis")?.model).toBe("gpt-5.6-terra");
    expect(roleConfigFor("management_analysis")?.maxOutputTokens).toBe(1200);
    expect(roleConfigFor("fallback")?.model).toBe("gpt-5.6-luna");
    expect(roleConfigFor("fallback")?.maxOutputTokens).toBe(400);
  });
});

describe("错误码产出侧划分（AC3.2 基础）", () => {
  it("适配器侧 5 个 + 中立层 6 个 = 全部 11 个，且无交集、无遗漏", () => {
    expect(ADAPTER_EMITTED_ERROR_CODES).toHaveLength(5);
    expect(NEUTRAL_LAYER_ERROR_CODES).toHaveLength(6);
    const union = new Set<string>([...ADAPTER_EMITTED_ERROR_CODES, ...NEUTRAL_LAYER_ERROR_CODES]);
    expect(union.size).toBe(GATEWAY_ERROR_CODES.length);
    for (const code of GATEWAY_ERROR_CODES) expect(union.has(code), code).toBe(true);
    for (const code of union) expect(GATEWAY_ERROR_CODES as readonly string[]).toContain(code);
  });
});
