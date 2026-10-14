import { AI_OUTPUT_SCHEMA_VERSION, managementAnalysisSchema } from "@logiplan/contracts";
import { z } from "zod";

/**
 * 提示词 / 输出模式版本注册表（切片 3b 协调项 4）。
 *
 * 适配器只接受**版本字符串**，并由调用方注入解析器（`resolveSystemPrompt` /
 * `resolveOutputSchema`）；未知版本返回 `null`，适配器据此失败关闭为
 * `PROVIDER_REQUEST_INVALID`（见供应商适配器包的 `adapter.ts`）。
 * 本文件提供中立层的**真实注册表**，使版本字符串与具体文本/模式一一对应。
 *
 * ## 输出模式不重复维护（避免漂移）
 *
 * `management_analysis` 角色的输出模式直接由公共 Zod 模式
 * （`@logiplan/contracts` 的 `managementAnalysisSchema`）在运行时生成 JSON Schema
 * （`z.toJSONSchema`），**不手抄**——手抄会与公共契约漂移。因此本文件源码里不出现
 * 公共模式的枚举取值（如答案类型），只有版本键与提示词文本。
 *
 * ⚠️ 运行时生成的 JSON Schema 只是给供应商的结构化输出**提示**；权威校验仍是
 * `managementAnalysisSchema.parse`（输出三检第①检）。
 */

const ANALYSIS_SYSTEM_PROMPT = [
  "你是 LogiPlan 的管理分析文案助手，只做自然语言理解与受控文案生成，",
  "不承担确定性查询、证据生成、数字计算或权限判断。",
  "必须严格遵守：",
  "1. 输出为符合给定 JSON 模式的单个 JSON 对象，不得附加任何解释或代码块标记。",
  "2. 所有 evidence_ids 只能取自本次注入的证据白名单，不得引用白名单之外的证据。",
  "3. 正文中出现的每一个数字都必须来自本次注入的确定性结果，不得编造，不得跨范围引用。",
  "4. 建议不得给出任何节省金额或成本下降承诺。",
  "5. 限制区块必须写明「相关性不等于因果」，不得把相关性表述为确定因果。",
  "不得调用任何工具，不得在输出中出现供应商或模型名称。",
].join("\n");

const INTENT_SYSTEM_PROMPT = [
  "你是 LogiPlan 的意图解析助手，只把用户自然语言映射为受控的结构化意图。",
  "只输出符合给定 JSON 模式的单个 JSON 对象；不得输出供应商或模型名称，不得调用任何工具。",
].join("\n");

const FALLBACK_SYSTEM_PROMPT = [
  "你是 LogiPlan 的受控回退文案助手。只输出符合给定 JSON 模式的单个 JSON 对象，",
  "内容仅用于说明本次未能生成真实分析，不得编造任何数字或证据。",
].join("\n");

/** 系统提示词版本 → 文本；未知版本返回 `null`（失败关闭）。 */
export const SYSTEM_PROMPT_REGISTRY: Readonly<Record<string, string>> = {
  "intent-v1": INTENT_SYSTEM_PROMPT,
  "analysis-v1": ANALYSIS_SYSTEM_PROMPT,
  "fallback-v1": FALLBACK_SYSTEM_PROMPT,
};

const INTENT_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: {
    intent: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["intent"],
  additionalProperties: false,
};

const FALLBACK_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

/** 由公共 Zod 模式在运行时生成的 JSON Schema（不手抄，避免与契约漂移）。 */
const MANAGEMENT_ANALYSIS_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = z.toJSONSchema(
  managementAnalysisSchema,
  { io: "output" },
) as unknown as Readonly<Record<string, unknown>>;

/** 输出模式版本 → 中立 JSON Schema；未知版本返回 `null`（失败关闭）。 */
export const OUTPUT_SCHEMA_REGISTRY: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "intent-schema-v1": INTENT_OUTPUT_SCHEMA,
  "fallback-schema-v1": FALLBACK_OUTPUT_SCHEMA,
  [AI_OUTPUT_SCHEMA_VERSION]: MANAGEMENT_ANALYSIS_OUTPUT_SCHEMA,
};

/** 已注册的系统提示词版本（用于穷尽性断言与审计）。 */
export const REGISTERED_SYSTEM_PROMPT_VERSIONS: readonly string[] =
  Object.keys(SYSTEM_PROMPT_REGISTRY);

/** 已注册的输出模式版本（用于穷尽性断言与审计）。 */
export const REGISTERED_OUTPUT_SCHEMA_VERSIONS: readonly string[] =
  Object.keys(OUTPUT_SCHEMA_REGISTRY);

/** 版本 → 系统提示词；未知版本返回 `null`（适配器据此返回 `PROVIDER_REQUEST_INVALID`）。 */
export const resolveSystemPrompt = (version: string): string | null =>
  SYSTEM_PROMPT_REGISTRY[version] ?? null;

/** 版本 → 输出 JSON Schema；未知版本返回 `null`（适配器据此返回 `PROVIDER_REQUEST_INVALID`）。 */
export const resolveOutputSchema = (version: string): Readonly<Record<string, unknown>> | null =>
  OUTPUT_SCHEMA_REGISTRY[version] ?? null;
