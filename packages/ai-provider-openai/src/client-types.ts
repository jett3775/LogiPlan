/**
 * 供应商 SDK 的**最小结构接口**（本包自己的中立类型，非 SDK 类型）。
 *
 * 约束（invariants）：本包的导出面**不得**出现供应商 SDK 类型——返回给上层的必须是本包
 * 自己的中立类型。因此这里只声明本包实际用到的那一小部分结构（Responses API 的
 * `responses.create` 与 Moderations API 的 `moderations.create`）。
 *
 * 真实的 `openai` 客户端在结构上满足本接口（切片 3b 注入真实客户端；本切片只注入假客户端）。
 * `create` 声明为方法以利用 TS 的方法双变性，放宽与真实 SDK 签名（含额外可选参数）的兼容。
 */

import type { JsonSchema } from "./contract";

/** 推理强度：本包只使用 D-180 冻结的两档（最低 / 低）。 */
export type AdapterReasoningEffort = "minimal" | "low";

/** Responses API 请求体：本包设置的全部字段，无 `stream`、无 `tools`。 */
export interface OpenAiResponsesCreateParams {
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly max_output_tokens: number;
  readonly store: boolean;
  readonly reasoning: { readonly effort: AdapterReasoningEffort };
  readonly text: {
    readonly format: {
      readonly type: "json_schema";
      readonly name: string;
      readonly schema: JsonSchema;
      readonly strict: boolean;
    };
  };
  /** 仅使用匿名派生值；不得传原始 IP 或 User-Agent（D-138、D-181）。 */
  readonly safety_identifier: string;
}

export interface OpenAiResponseOutputText {
  readonly type: "output_text";
  readonly text: string;
}

export interface OpenAiResponseOutputRefusal {
  readonly type: "refusal";
  readonly refusal: string;
}

export interface OpenAiResponseOutputMessage {
  readonly type: "message";
  readonly content: ReadonlyArray<OpenAiResponseOutputText | OpenAiResponseOutputRefusal>;
}

/** 其它输出项（推理、函数调用等）；本包只关心 `message` 的文本。 */
export interface OpenAiResponseOutputOther {
  readonly type: string;
}

export type OpenAiResponseOutputItem = OpenAiResponseOutputMessage | OpenAiResponseOutputOther;

export interface OpenAiResponsesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface OpenAiResponseLike {
  readonly id: string;
  readonly model?: string | undefined;
  readonly status?: string | undefined;
  readonly incomplete_details?: { readonly reason?: string | undefined } | null | undefined;
  readonly output?: ReadonlyArray<OpenAiResponseOutputItem> | undefined;
  readonly usage?: OpenAiResponsesUsage | null | undefined;
}

export interface OpenAiModerationCreateParams {
  readonly model: string;
  readonly input: string;
}

export interface OpenAiModerationResultLike {
  readonly flagged: boolean;
}

export interface OpenAiModerationResponseLike {
  readonly results: ReadonlyArray<OpenAiModerationResultLike>;
}

/** 本包需要的最小客户端面。真实 `openai` 客户端结构上满足之。 */
export interface OpenAiResponsesClient {
  readonly responses: {
    create(body: OpenAiResponsesCreateParams): Promise<OpenAiResponseLike>;
  };
  readonly moderations: {
    create(body: OpenAiModerationCreateParams): Promise<OpenAiModerationResponseLike>;
  };
}
