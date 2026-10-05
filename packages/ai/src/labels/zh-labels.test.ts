import { describe, expect, it } from "vitest";

import {
  PROVIDER_CAPABILITY_NAMES,
  type ProviderCapabilityName,
} from "../adapter/provider-capabilities";
import { AI_ROLES, type AiRole } from "../routing/role-routing";
import { GATEWAY_ERROR_CODES, type GatewayErrorCode } from "../gateway/gateway-error-code";
import {
  FEASIBILITY_STATUS_ZH,
  GATEWAY_ERROR_STATUS_ZH,
  ORDER_GRAIN_LABEL_ZH,
  ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH,
  PROVIDER_CAPABILITY_ZH,
  REQUIRED_LIMITATION_LABEL_ZH,
  SCENARIO_NOT_RUN_LABEL_ZH,
  SCENARIO_VALIDATION_STATUS_ZH,
} from "./zh-labels";

/**
 * AC1.8（映射表与测试部分）：面向用户的枚举值走穷尽中文映射——
 * 新增枚举值会导致编译失败（`Record<枚举, string>` 缺键）或本测试失败。
 */

const SCENARIO_STATUS_KEYS = ["NOT_RUN", "RUN"] as const;
const FEASIBILITY_KEYS = ["NOT_VALIDATED", "PARTIALLY_VALIDATED", "VALIDATED"] as const;

describe("中文映射的穷尽性", () => {
  it("错误码映射恰好覆盖全部 GatewayErrorCode", () => {
    expect(Object.keys(GATEWAY_ERROR_STATUS_ZH).sort()).toEqual([...GATEWAY_ERROR_CODES].sort());
    for (const code of GATEWAY_ERROR_CODES) {
      expect(GATEWAY_ERROR_STATUS_ZH[code].trim().length).toBeGreaterThan(0);
      expect(GATEWAY_ERROR_STATUS_ZH[code]).not.toContain(code);
    }
  });

  it("情景计算状态与可行性状态映射恰好覆盖全部取值", () => {
    expect(Object.keys(SCENARIO_VALIDATION_STATUS_ZH).sort()).toEqual([...SCENARIO_STATUS_KEYS]);
    expect(Object.keys(FEASIBILITY_STATUS_ZH).sort()).toEqual([...FEASIBILITY_KEYS]);
    for (const key of SCENARIO_STATUS_KEYS) {
      expect(SCENARIO_VALIDATION_STATUS_ZH[key].trim().length).toBeGreaterThan(0);
    }
    for (const key of FEASIBILITY_KEYS) {
      expect(FEASIBILITY_STATUS_ZH[key].trim().length).toBeGreaterThan(0);
    }
  });

  it("能力项映射恰好覆盖全部能力名", () => {
    expect(Object.keys(PROVIDER_CAPABILITY_ZH).sort()).toEqual(
      [...PROVIDER_CAPABILITY_NAMES].sort(),
    );
    for (const name of PROVIDER_CAPABILITY_NAMES) {
      expect(PROVIDER_CAPABILITY_ZH[name].trim().length).toBeGreaterThan(0);
    }
  });

  it("映射只面向用户文案，不泄露内部码值", () => {
    const allLabels = [
      ...Object.values(GATEWAY_ERROR_STATUS_ZH),
      ...Object.values(SCENARIO_VALIDATION_STATUS_ZH),
      ...Object.values(FEASIBILITY_STATUS_ZH),
      ...Object.values(PROVIDER_CAPABILITY_ZH),
    ];
    for (const label of allLabels) {
      expect(label).not.toMatch(/[A-Z]{3,}_/u);
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it("订单粒度保护使用受控中文说明而非内部错误码", () => {
    expect(ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH).toContain("订单级");
    expect(ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH).toContain("线路层下钻");
    expect(ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH).not.toContain("ORDER_LEVEL_NOT_AVAILABLE");
    expect(ORDER_GRAIN_LABEL_ZH).toContain(ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH);
    expect(REQUIRED_LIMITATION_LABEL_ZH).toBe("相关性不等于因果 · 不得推断未记录的经营因果");
    expect(SCENARIO_NOT_RUN_LABEL_ZH).toContain("情景计算");
  });

  it("供穷尽性校验的辅助类型与枚举一致", () => {
    const errorCodes: readonly GatewayErrorCode[] = GATEWAY_ERROR_CODES;
    const roles: readonly AiRole[] = AI_ROLES;
    const capabilities: readonly ProviderCapabilityName[] = PROVIDER_CAPABILITY_NAMES;
    expect(errorCodes).toHaveLength(11);
    expect(roles).toHaveLength(3);
    expect(capabilities).toHaveLength(5);
  });
});
