import { AI_OUTPUT_SCHEMA_VERSION } from "@logiplan/contracts";

import type { ProviderCapabilityName } from "../adapter/provider-capabilities";
import { resolveRoleRoute, type AiRole, type RoleRouteConfig } from "../routing/role-routing";

/**
 * 角色配置（docs/gate2-design.md §6；D-190 决策二）。
 *
 * ## 形态（D-190 决策二，明确排除混合方案）
 *
 * `provider` / `model` / 推理强度 / 输出上限 / 提示词与输出模式版本以**受版本控制的
 * 配置文件**表达，变更进 Git、走 review，**其 commit SHA 即配置版本标识**。
 *
 * **不得**用环境变量覆盖本文件的任何取值——D-190 决策二明确排除「配置文件为默认值、
 * 环境变量可覆盖」的混合方案：覆盖后实际生效值与 Git 记录不一致，追溯链断在一半。
 * 供应商密钥（`DEEPSEEK_API_KEY`）仍只走**服务端环境变量**，且**只有适配器装配处**读取
 * （见 `docs/gate2-design.md` §6 与 D-177）；本文件与整个中立层不读取任何密钥。
 *
 * ## 角色映射（D-180 冻结，D-193 切换供应商）
 *
 * | 角色                 | provider | model          | 推理强度 | 最大输出 |
 * | -------------------- | -------- | -------------- | -------- | -------- |
 * | `intent_parse`       | deepseek | deepseek-flash | minimal  | 400      |
 * | `management_analysis`| deepseek | deepseek-flash | low      | 1200     |
 * | `fallback`           | deepseek | deepseek-flash | minimal  | 400      |
 *
 * ## 能力需求（需求侧，切片 3b 协调项 1；D-193 收窄）
 *
 * 三个角色只要求**两项**供应商能力：结构化输出与推理控制。其余三项由平台侧或供应商
 * 构造性保证承担，并在 D-193 决策二逐项记录替代控制：无状态不存储由 DeepSeek Responses
 * API 的 `store` 恒为 `false` 保证；匿名标识仅平台内部使用、不传给供应商；内容审核由
 * `packages/ai` 的平台侧审核端口承担。删除必需项是显式决策，不是静默降级。
 *
 * `dataRetentionToggle` / `safetyIdentifier` / `moderation` 在适配器侧仍如实声明为 `false`，
 * 枚举本身不变。
 */

/** 需求侧必需能力：只保留供应商实际必须提供的两项（D-193 决策二）。 */
export const REQUIRED_PROVIDER_CAPABILITIES: readonly ProviderCapabilityName[] = [
  "structuredOutput",
  "reasoningControl",
];

/** 角色配置版本标识；真实版本标识为承载本文件的 commit SHA（D-190 决策二）。 */
export const AI_ROLE_CONFIG_VERSION = "AI_ROLE_CONFIG_2026_V2";

/** 三个角色的路由配置（受版本控制；不得被环境变量覆盖）。 */
export const AI_ROLE_ROUTES: readonly RoleRouteConfig[] = [
  {
    role: "intent_parse",
    provider: "deepseek",
    model: "deepseek-flash",
    reasoningEffort: "minimal",
    maxOutputTokens: 400,
    systemPromptVersion: "intent-v1",
    outputSchemaVersion: "intent-schema-v1",
    requiredCapabilities: REQUIRED_PROVIDER_CAPABILITIES,
    verified: true,
  },
  {
    role: "management_analysis",
    provider: "deepseek",
    model: "deepseek-flash",
    reasoningEffort: "low",
    maxOutputTokens: 1200,
    systemPromptVersion: "analysis-v1",
    // 输出模式版本取自公共契约（独立版本化），与固定示例同源，避免两处漂移。
    outputSchemaVersion: AI_OUTPUT_SCHEMA_VERSION,
    requiredCapabilities: REQUIRED_PROVIDER_CAPABILITIES,
    verified: true,
  },
  {
    role: "fallback",
    provider: "deepseek",
    model: "deepseek-flash",
    reasoningEffort: "minimal",
    maxOutputTokens: 400,
    systemPromptVersion: "fallback-v1",
    outputSchemaVersion: "fallback-schema-v1",
    requiredCapabilities: REQUIRED_PROVIDER_CAPABILITIES,
    verified: true,
  },
];

/** 角色配置里的全部角色键；用于穷尽性断言。 */
export const AI_CONFIGURED_ROLES: readonly AiRole[] = AI_ROLE_ROUTES.map((route) => route.role);

/** 按角色取受版本控制的配置；未知角色失败关闭。 */
export const roleConfigFor = (role: AiRole): RoleRouteConfig | null => {
  const resolution = resolveRoleRoute(AI_ROLE_ROUTES, role);
  return resolution.ok ? resolution.route : null;
};
