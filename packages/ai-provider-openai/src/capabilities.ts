/**
 * 供应商能力声明与能力门（docs/gate2-design.md §1.3）。
 *
 * 中立布尔能力表：不含任何供应商专有字段。**能力缺失即失败关闭**——若某能力为 `false`
 * 且该角色需要它，适配器必须返回标准化错误，**不得静默降级为自由文本**。
 */

import type { AdapterRole } from "./roles";

export const PROVIDER_CAPABILITY_NAMES = [
  "structuredOutput",
  "reasoningControl",
  "dataRetentionToggle",
  "safetyIdentifier",
  "moderation",
] as const;

export type ProviderCapabilityName = (typeof PROVIDER_CAPABILITY_NAMES)[number];

export interface ProviderCapabilities {
  readonly structuredOutput: boolean;
  readonly reasoningControl: boolean;
  readonly dataRetentionToggle: boolean;
  readonly safetyIdentifier: boolean;
  readonly moderation: boolean;
}

export const allCapabilitiesGranted: ProviderCapabilities = {
  structuredOutput: true,
  reasoningControl: true,
  dataRetentionToggle: true,
  safetyIdentifier: true,
  moderation: true,
};

export const noCapabilitiesGranted: ProviderCapabilities = {
  structuredOutput: false,
  reasoningControl: false,
  dataRetentionToggle: false,
  safetyIdentifier: false,
  moderation: false,
};

/**
 * 各角色需要的能力（D-180 冻结参数）。
 *
 * OpenAI 适配器对**每个角色**都使用全部五项供应商特性，故三个角色都要求全部五项：
 * 结构化输出（`text.format` json_schema）、推理控制（`reasoning.effort`）、
 * 留存开关（`store: false`）、安全标识（`safety_identifier`）、内容审核
 * （调用前 `omni-moderation-latest`）。任一为 `false` 即无法安全服务该角色 → 失败关闭。
 *
 * **需求侧已与网关角色配置核对（切片 3b 协调项 1）**：中立层
 * `packages/ai/src/config/role-config.ts` 的 `AI_ROLE_ROUTES[*].requiredCapabilities`
 * 是需求侧的权威声明，此处是适配器侧的**同形视图**；两侧逐角色一致由
 * `packages/ai/src/adapter/adapter-compat.test.ts` 断言（原先「未消除的设计不确定性」
 * 已据此关闭）。
 */
export const requiredCapabilitiesForRole = (
  role: AdapterRole,
): readonly ProviderCapabilityName[] => {
  void role;
  return PROVIDER_CAPABILITY_NAMES;
};

/** 角色需要但供应商未声明（为 `false`）的能力。 */
export const missingRequiredCapabilities = (
  capabilities: ProviderCapabilities,
  required: readonly ProviderCapabilityName[],
): readonly ProviderCapabilityName[] => required.filter((name) => !capabilities[name]);

export type CapabilityGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly ProviderCapabilityName[] };

/** 能力门：任一必需能力为 `false` 即失败关闭，不做降级。 */
export const capabilityGate = (
  capabilities: ProviderCapabilities,
  required: readonly ProviderCapabilityName[],
): CapabilityGate => {
  const missing = missingRequiredCapabilities(capabilities, required);
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
};
