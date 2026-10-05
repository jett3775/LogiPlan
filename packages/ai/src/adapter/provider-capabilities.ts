/**
 * 供应商能力声明（docs/gate2-design.md §1.3）。
 *
 * 中立布尔能力表：不含任何供应商专有字段。能力缺失即失败关闭，
 * 不得静默降级为自由文本（`capabilityGate` 返回标准化错误码）。
 */
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

/** 角色需要的能力缺失时返回的失败关闭判定。 */
export type CapabilityGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly ProviderCapabilityName[] };

export const missingRequiredCapabilities = (
  capabilities: ProviderCapabilities,
  required: readonly ProviderCapabilityName[],
): readonly ProviderCapabilityName[] => required.filter((name) => !capabilities[name]);

/** 能力门：任一必需能力为 `false` 即失败关闭，不做降级。 */
export const capabilityGate = (
  capabilities: ProviderCapabilities,
  required: readonly ProviderCapabilityName[],
): CapabilityGate => {
  const missing = missingRequiredCapabilities(capabilities, required);
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
};

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
