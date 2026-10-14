/**
 * 角色键（docs/gate2-design.md §6）。
 *
 * 配置由 `packages/ai` 提供（provider / model 存在受版本控制的配置文件里，D-190 决策二）；
 * 本包只接受传入的 `model`，不持有角色配置。
 */

export const ADAPTER_ROLES = ["intent_parse", "management_analysis", "fallback"] as const;

export type AdapterRole = (typeof ADAPTER_ROLES)[number];

export const isAdapterRole = (value: unknown): value is AdapterRole =>
  typeof value === "string" && (ADAPTER_ROLES as readonly string[]).includes(value);
