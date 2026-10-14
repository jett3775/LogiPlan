/**
 * 供应商中立适配器契约（docs/gate2-design.md §1.3）。
 *
 * 本包是**供应商适配器**，向上只暴露一个中立调用入口与能力声明；供应商的请求字段、
 * 响应结构、错误与用量在本包内全部标准化，使 `packages/ai` 完全看不到供应商专有结构
 * （设计 §1.1 硬约束）。
 *
 * 这些类型与 `packages/ai/src/adapter/adapter-contract.ts` **结构一致**——本包不得
 * `import` `packages/ai`（依赖方向单向 `ai → ai-provider-*`，反向 import 会成环）。
 * 切片 3b 接线时依赖 TS 结构类型兼容，故此处逐字段对齐设计 §1.3。
 */

import type { ProviderCapabilities } from "./capabilities";
import type { AdapterRole } from "./roles";

/**
 * 供应商中立的结构化输出约束：普通 JSON Schema 对象。
 *
 * 由调用方按 `outputSchemaVersion` 注入（公共 Zod 模式 → JSON Schema 的转换在中立层完成），
 * 本包只把它转成供应商的结构化输出约束，返回后再由中立层用公共 Zod 模式校验。
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface AdapterRequest {
  readonly role: AdapterRole;
  /** 由服务端角色配置提供；浏览器不得提交模型名。 */
  readonly model: string;
  readonly systemPromptVersion: string;
  readonly outputSchemaVersion: string;
  /** 已通过输入校验的自然语言。 */
  readonly input: string;
  /** 服务端注入的证据 ID 白名单。 */
  readonly evidenceWhitelist: readonly string[];
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface AdapterUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AdapterCostEstimate {
  readonly currency: "USD";
  readonly amount: number;
  readonly priceVersion: string;
}

export interface AdapterResult {
  /** 标准化供应商标识，不含供应商专有结构。 */
  readonly provider: string;
  readonly model: string;
  readonly providerRequestId: string;
  /** 仍须由公共 Zod 模式校验；此处不做任何业务判断。 */
  readonly structuredOutput: unknown;
  readonly usage: AdapterUsage;
  readonly finishReason: string;
  readonly latencyMs: number;
  readonly costEstimate: AdapterCostEstimate;
}

/**
 * 适配器实现契约。实现体落在 `packages/ai-provider-*`，不得含业务规则。
 * 失败以 `ProviderInvocationError`（携带标准化错误码）抛出；成功返回 `AdapterResult`。
 */
export interface ProviderAdapter {
  readonly adapterVersion: string;
  readonly capabilities: ProviderCapabilities;
  invoke(request: AdapterRequest): Promise<AdapterResult>;
}
