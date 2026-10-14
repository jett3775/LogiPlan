import { describe, expect, it } from "vitest";

import {
  ADAPTER_EMITTED_ERROR_CODES,
  NEUTRAL_LAYER_ERROR_CODES,
  isAdapterEmittedErrorCode,
} from "./error-partition";
import { GATEWAY_ERROR_CODES } from "./gateway-error-code";

/**
 * AC3.2 基础：`GatewayErrorCode` 的产出侧划分必须**穷尽且互斥**——11 个码值每一个都被
 * 划分到适配器侧或中立层侧之一，且恰一侧。切片 3b 据此实现「全部错误码都有转换路径」。
 */
describe("GatewayErrorCode 产出侧划分（AC3.2 基础）", () => {
  it("两侧并集恰为全部 11 个码值，且交集为空", () => {
    const union = new Set<string>([...ADAPTER_EMITTED_ERROR_CODES, ...NEUTRAL_LAYER_ERROR_CODES]);
    expect(union.size).toBe(GATEWAY_ERROR_CODES.length);
    expect(ADAPTER_EMITTED_ERROR_CODES.length + NEUTRAL_LAYER_ERROR_CODES.length).toBe(
      GATEWAY_ERROR_CODES.length,
    );
  });

  it("逐个断言：11 个码值每一个都被划分到某一侧（穷尽性）", () => {
    const union = new Set<string>([...ADAPTER_EMITTED_ERROR_CODES, ...NEUTRAL_LAYER_ERROR_CODES]);
    for (const code of GATEWAY_ERROR_CODES) {
      expect(union.has(code), `码值 ${code} 未被划分到任何一侧`).toBe(true);
    }
    // 反向：划分里不存在设计之外的码值。
    for (const code of union) {
      expect(GATEWAY_ERROR_CODES as readonly string[]).toContain(code);
    }
  });

  it("两侧无交集", () => {
    const adapter = new Set<string>(ADAPTER_EMITTED_ERROR_CODES);
    const overlap = NEUTRAL_LAYER_ERROR_CODES.filter((code) => adapter.has(code));
    expect(overlap).toEqual([]);
  });

  it("isAdapterEmittedErrorCode 精确判定两侧", () => {
    for (const code of ADAPTER_EMITTED_ERROR_CODES) {
      expect(isAdapterEmittedErrorCode(code)).toBe(true);
    }
    for (const code of NEUTRAL_LAYER_ERROR_CODES) {
      expect(isAdapterEmittedErrorCode(code)).toBe(false);
    }
  });

  it("中立层码值（输出三检 / 限流 / 预算 / 控制面）不由适配器产出", () => {
    expect(NEUTRAL_LAYER_ERROR_CODES).toEqual([
      "SCHEMA_VALIDATION_FAILED",
      "EVIDENCE_WHITELIST_VIOLATION",
      "NUMERIC_MISMATCH",
      "BUDGET_EXCEEDED",
      "RATE_LIMITED",
      "CONTROL_PLANE_UNAVAILABLE",
    ]);
  });
});
