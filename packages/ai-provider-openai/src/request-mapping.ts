/**
 * 中立请求 → 供应商请求映射（设计 §2「适配器内部职责」、D-180 冻结参数）。
 *
 * 冻结要求：**非流式**、`store: false`、**不开放工具调用**；推理强度按角色取最低 / 低；
 * 结构化输出用 `text.format` json_schema；`safety_identifier` 只用匿名派生值。
 *
 * 本模块是纯函数，不接触网络；`stream` / `tools` / `tool_choice` 一律**不出现**在结果对象里
 * （类型上也不允许），因此既不会开启流式，也不会开放工具调用。
 */

import type { JsonSchema } from "./contract";
import type { AdapterReasoningEffort, OpenAiResponsesCreateParams } from "./client-types";
import type { AdapterRole } from "./roles";
import type { AdapterRequest } from "./contract";

/** 结构化输出格式名（供应商要求 a-z/A-Z/0-9/_/-，≤64 字符）。 */
export const OUTPUT_FORMAT_NAME = "logiplan_structured_output";

/**
 * 角色 → 推理强度（D-180）：意图解析最低推理；管理分析低推理；受控回退与意图解析同模型，
 * 取同一档「最低推理」。
 */
export const reasoningEffortForRole = (role: AdapterRole): AdapterReasoningEffort =>
  role === "management_analysis" ? "low" : "minimal";

export interface ResolvedPromptAndSchema {
  readonly systemPrompt: string;
  readonly outputSchema: JsonSchema;
}

export const buildResponsesRequest = (
  request: AdapterRequest,
  resolved: ResolvedPromptAndSchema,
  safetyIdentifier: string,
): OpenAiResponsesCreateParams => ({
  model: request.model,
  instructions: resolved.systemPrompt,
  input: request.input,
  max_output_tokens: request.maxOutputTokens,
  store: false,
  reasoning: { effort: reasoningEffortForRole(request.role) },
  text: {
    format: {
      type: "json_schema",
      name: OUTPUT_FORMAT_NAME,
      schema: resolved.outputSchema,
      strict: true,
    },
  },
  safety_identifier: safetyIdentifier,
});
