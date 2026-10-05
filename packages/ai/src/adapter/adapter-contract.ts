import type { ProviderCapabilities } from "./provider-capabilities";
import type { AiRole } from "../routing/role-routing";

/**
 * 供应商适配器契约（docs/gate2-design.md §1.3）。
 *
 * 结构照设计文档 §1.3 的中立草案落地为真实 TS 类型：适配器向上只暴露一个
 * 中立调用入口，`structuredOutput` 仍是 `unknown`，**必须**再经公共 Zod 模式
 * 校验。本包不含任何供应商 SDK 导入、供应商错误类型或供应商响应结构。
 */

export interface AdapterRequest {
  readonly role: AiRole;
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
 * 能力缺失时的标准化错误由中立层的能力门（`capabilityGate`）判定。
 */
export interface ProviderAdapter {
  readonly adapterVersion: string;
  readonly capabilities: ProviderCapabilities;
  invoke(request: AdapterRequest): Promise<AdapterResult>;
}
