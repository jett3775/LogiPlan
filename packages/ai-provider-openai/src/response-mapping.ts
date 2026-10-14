/**
 * 供应商响应 → 中立结果映射（设计 §2「适配器内部职责」）。
 *
 * 职责：结束原因标准化、用量标准化、结构化输出提取。**不做任何业务判断**——输出是否
 * 合规由中立层用公共 Zod 模式 + 证据白名单 + 数值回指三检判定（设计 §4.3）。
 *
 * 若模型返回的不是合法 JSON，本模块返回原始文本字符串（`unknown`）而不抛错：中立层的
 * 公共模式校验会据此判定 `SCHEMA_VALIDATION_FAILED`——`SCHEMA_VALIDATION_FAILED` 属
 * 中立层码值，本包不得产出。
 */

import type { AdapterUsage } from "./contract";
import type { OpenAiResponseLike, OpenAiResponseOutputItem } from "./client-types";

export interface NormalizedResponse {
  readonly providerRequestId: string;
  readonly structuredOutput: unknown;
  readonly usage: AdapterUsage;
  readonly finishReason: string;
}

/** 响应状态是否可用（可产出结果）。其余状态（failed/cancelled/queued/in_progress/缺失）视为不可用。 */
export const isUsableResponseStatus = (status: string | undefined): boolean =>
  status === "completed" || status === "incomplete";

/** 结束原因标准化：`completed` → `stop`；`incomplete` 按原因细分；其余按状态直出。 */
export const normalizeFinishReason = (
  status: string | undefined,
  incompleteReason: string | undefined,
): string => {
  if (status === "completed") return "stop";
  if (status === "incomplete") {
    if (incompleteReason === "max_output_tokens") return "length";
    if (incompleteReason === "content_filter") return "content_filter";
    return "incomplete";
  }
  return status ?? "unknown";
};

const isOutputMessage = (
  item: OpenAiResponseOutputItem,
): item is Extract<OpenAiResponseOutputItem, { readonly type: "message" }> =>
  item.type === "message" && "content" in item;

const isOutputText = (part: {
  readonly type: string;
}): part is { readonly type: "output_text"; readonly text: string } =>
  part.type === "output_text" && "text" in part;

/** 汇总全部 `output_text` 文本并解析为 JSON；非 JSON 时返回原始文本（交由中立层校验）。 */
export const extractStructuredOutput = (response: OpenAiResponseLike): unknown => {
  const text = (response.output ?? [])
    .filter(isOutputMessage)
    .flatMap((message) => message.content)
    .filter(isOutputText)
    .map((part) => part.text)
    .join("");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const finiteOrZero = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const mapResponse = (response: OpenAiResponseLike): NormalizedResponse => ({
  providerRequestId: response.id,
  structuredOutput: extractStructuredOutput(response),
  usage: {
    inputTokens: finiteOrZero(response.usage?.input_tokens),
    outputTokens: finiteOrZero(response.usage?.output_tokens),
  },
  finishReason: normalizeFinishReason(response.status, response.incomplete_details?.reason),
});
