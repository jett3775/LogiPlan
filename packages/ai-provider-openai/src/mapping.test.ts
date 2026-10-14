import { describe, expect, it } from "vitest";

import { estimateCostUsd, toFailClosedCost } from "./cost";
import { mapProviderError, statusOfError } from "./error-mapping";
import {
  OUTPUT_FORMAT_NAME,
  buildResponsesRequest,
  reasoningEffortForRole,
} from "./request-mapping";
import {
  extractStructuredOutput,
  isUsableResponseStatus,
  mapResponse,
  normalizeFinishReason,
} from "./response-mapping";
import { fakeResponse, httpStatusError, sampleRequest } from "./test-doubles";

describe("请求映射（D-180 冻结字段）", () => {
  const resolved = { systemPrompt: "系统提示词", outputSchema: { type: "object" } };
  const params = buildResponsesRequest(sampleRequest(), resolved, "anon-abc123");

  it("非流式：不出现 stream 字段", () => {
    expect("stream" in params).toBe(false);
  });

  it("不开放工具调用：不出现 tools / tool_choice 字段", () => {
    expect("tools" in params).toBe(false);
    expect("tool_choice" in params).toBe(false);
  });

  it("store 恒为 false", () => {
    expect(params.store).toBe(false);
  });

  it("结构化输出走 text.format json_schema + strict", () => {
    expect(params.text.format).toEqual({
      type: "json_schema",
      name: OUTPUT_FORMAT_NAME,
      schema: resolved.outputSchema,
      strict: true,
    });
  });

  it("透传 model / input / max_output_tokens / instructions", () => {
    const request = sampleRequest({ model: "gpt-5.6-terra", maxOutputTokens: 1200 });
    const built = buildResponsesRequest(request, resolved, "anon-abc123");
    expect(built.model).toBe("gpt-5.6-terra");
    expect(built.input).toBe(request.input);
    expect(built.max_output_tokens).toBe(1200);
    expect(built.instructions).toBe("系统提示词");
  });

  it("safety_identifier 只用传入的匿名派生值", () => {
    expect(params.safety_identifier).toBe("anon-abc123");
  });

  it("推理强度按角色取最低 / 低", () => {
    expect(reasoningEffortForRole("intent_parse")).toBe("minimal");
    expect(reasoningEffortForRole("management_analysis")).toBe("low");
    expect(reasoningEffortForRole("fallback")).toBe("minimal");
  });
});

describe("响应映射", () => {
  it("completed → finishReason stop，用量与结构化输出标准化", () => {
    const normalized = mapResponse(
      fakeResponse({ text: '{"answer":"ok"}', inputTokens: 120, outputTokens: 40 }),
    );
    expect(normalized.finishReason).toBe("stop");
    expect(normalized.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(normalized.structuredOutput).toEqual({ answer: "ok" });
    expect(normalized.providerRequestId).toBe("resp_test_1");
  });

  it("incomplete(max_output_tokens) → length；incomplete(content_filter) → content_filter", () => {
    expect(normalizeFinishReason("incomplete", "max_output_tokens")).toBe("length");
    expect(normalizeFinishReason("incomplete", "content_filter")).toBe("content_filter");
    expect(normalizeFinishReason("incomplete", undefined)).toBe("incomplete");
  });

  it("状态缺失 → unknown；其它状态直出", () => {
    expect(normalizeFinishReason(undefined, undefined)).toBe("unknown");
    expect(normalizeFinishReason("failed", undefined)).toBe("failed");
  });

  it("非 JSON 文本原样返回（交由中立层公共模式校验失败）", () => {
    expect(extractStructuredOutput(fakeResponse({ text: "not json" }))).toBe("not json");
  });

  it("无输出文本 → undefined；缺用量 → 0（不臆造数值）", () => {
    const normalized = mapResponse(fakeResponse({ text: "", usagePresent: false }));
    expect(normalized.structuredOutput).toBeUndefined();
    expect(normalized.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("仅 completed / incomplete 状态可用", () => {
    expect(isUsableResponseStatus("completed")).toBe(true);
    expect(isUsableResponseStatus("incomplete")).toBe(true);
    expect(isUsableResponseStatus("failed")).toBe(false);
    expect(isUsableResponseStatus(undefined)).toBe(false);
  });
});

describe("错误映射", () => {
  it("429 → PROVIDER_RATE_LIMITED；5xx → PROVIDER_UNAVAILABLE；4xx → PROVIDER_REQUEST_INVALID", () => {
    expect(mapProviderError(httpStatusError(429))).toBe("PROVIDER_RATE_LIMITED");
    expect(mapProviderError(httpStatusError(500))).toBe("PROVIDER_UNAVAILABLE");
    expect(mapProviderError(httpStatusError(503))).toBe("PROVIDER_UNAVAILABLE");
    expect(mapProviderError(httpStatusError(400))).toBe("PROVIDER_REQUEST_INVALID");
    expect(mapProviderError(httpStatusError(401))).toBe("PROVIDER_REQUEST_INVALID");
    expect(mapProviderError(httpStatusError(404))).toBe("PROVIDER_REQUEST_INVALID");
  });

  it("无 status（网络 / 连接错误）→ PROVIDER_UNAVAILABLE", () => {
    expect(mapProviderError(new Error("connection reset"))).toBe("PROVIDER_UNAVAILABLE");
    expect(mapProviderError("boom")).toBe("PROVIDER_UNAVAILABLE");
    expect(mapProviderError(null)).toBe("PROVIDER_UNAVAILABLE");
    expect(mapProviderError({ status: "429" })).toBe("PROVIDER_UNAVAILABLE");
  });

  it("非预期 3xx → PROVIDER_UNAVAILABLE（失败关闭）", () => {
    expect(mapProviderError(httpStatusError(302))).toBe("PROVIDER_UNAVAILABLE");
  });

  it("statusOfError 只取有限数字 status", () => {
    expect(statusOfError(httpStatusError(429))).toBe(429);
    expect(statusOfError({ status: Number.NaN })).toBeUndefined();
    expect(statusOfError(undefined)).toBeUndefined();
  });
});

describe("成本估算（失败关闭）", () => {
  const usage = { inputTokens: 1000, outputTokens: 500 };

  it("合法有限非负数原样返回", () => {
    expect(estimateCostUsd(() => 0.5, "PRICE_2026_V1", "gpt-5.6-luna", usage)).toBe(0.5);
    expect(toFailClosedCost(0)).toBe(0);
  });

  it("未知模型 / 未知版本（Infinity）→ 失败关闭，绝不当零成本放行", () => {
    expect(estimateCostUsd(() => Number.POSITIVE_INFINITY, "PRICE_2026_V1", "unknown", usage)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("NaN / 负数 / 抛错 → 归一为 Infinity", () => {
    expect(toFailClosedCost(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
    expect(toFailClosedCost(-1)).toBe(Number.POSITIVE_INFINITY);
    expect(
      estimateCostUsd(
        () => {
          throw new Error("price table missing");
        },
        "PRICE_2026_V1",
        "gpt-5.6-luna",
        usage,
      ),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
