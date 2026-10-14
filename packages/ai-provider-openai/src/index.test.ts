import { describe, expect, it } from "vitest";

import * as barrel from "./index";

/**
 * 导出面自证：barrel 只暴露本包的**中立**调用入口、能力声明与标准化工具；
 * 不含任何供应商 SDK 类型（类型级不可断言，故此处以「运行期符号齐备 + 无 SDK 值导出」佐证）。
 */
describe("barrel 导出面（中立调用入口与能力声明）", () => {
  it("暴露中立调用入口与能力声明", () => {
    expect(typeof barrel.createOpenAiAdapter).toBe("function");
    expect(barrel.PROVIDER_NAME).toBe("openai");
    expect(barrel.OPENAI_ADAPTER_VERSION).toBe("openai-responses-1");
    expect(barrel.PROVIDER_CAPABILITY_NAMES).toHaveLength(5);
    expect(barrel.allCapabilitiesGranted).toMatchObject({ structuredOutput: true });
  });

  it("暴露 11 个标准化错误码与显式产出侧划分", () => {
    expect(barrel.GATEWAY_ERROR_CODES).toHaveLength(11);
    expect(
      barrel.ADAPTER_EMITTED_ERROR_CODES.length + barrel.NEUTRAL_LAYER_ERROR_CODES.length,
    ).toBe(11);
    expect(barrel.isGatewayErrorCode("INPUT_REJECTED")).toBe(true);
    expect(barrel.isGatewayErrorCode("NOT_A_CODE")).toBe(false);
    expect(barrel.isAdapterEmittedErrorCode("PROVIDER_TIMEOUT")).toBe(true);
    expect(barrel.isAdapterEmittedErrorCode("RATE_LIMITED")).toBe(false);
    expect(barrel.isAdapterRole("intent_parse")).toBe(true);
    expect(barrel.isAdapterRole("nope")).toBe(false);
    expect(
      barrel.isProviderInvocationError(new barrel.ProviderInvocationError("INPUT_REJECTED")),
    ).toBe(true);
    expect(barrel.isProviderInvocationError(new Error("x"))).toBe(false);
  });

  it("暴露映射 / 审核 / 成本 / 超时工具（重试不在此包，协调项 2）", () => {
    expect(typeof barrel.mapProviderError).toBe("function");
    expect(typeof barrel.statusOfError).toBe("function");
    expect(typeof barrel.buildResponsesRequest).toBe("function");
    expect(typeof barrel.normalizeFinishReason).toBe("function");
    expect(typeof barrel.extractStructuredOutput).toBe("function");
    expect(typeof barrel.mapResponse).toBe("function");
    expect(typeof barrel.moderateInput).toBe("function");
    expect(typeof barrel.estimateCostUsd).toBe("function");
    expect(typeof barrel.toFailClosedCost).toBe("function");
    expect(typeof barrel.runWithHardTimeout).toBe("function");
    expect(barrel.HARD_TIMEOUT_MS).toBe(20_000);
    // 适配器侧重试已删除：这些符号不得再从本包导出。
    expect("shortRandomBackoffMs" in barrel).toBe(false);
    expect("isRetryableErrorCode" in barrel).toBe(false);
    expect("MAX_ATTEMPTS" in barrel).toBe(false);
    expect(barrel.isUsableResponseStatus("completed")).toBe(true);
    expect(barrel.MODERATION_MODEL).toBe("omni-moderation-latest");
    expect(barrel.OUTPUT_FORMAT_NAME).toBe("logiplan_structured_output");
    expect(barrel.reasoningEffortForRole("management_analysis")).toBe("low");
  });

  it("不导出任何供应商 SDK 值（无 SDK 模块被 barrel 转发）", () => {
    const exportedValues = Object.keys(barrel);
    expect(exportedValues).not.toContain("OpenAI");
    expect(exportedValues).not.toContain("APIPromise");
    expect(exportedValues.some((name) => name.startsWith("Response"))).toBe(false);
  });
});
