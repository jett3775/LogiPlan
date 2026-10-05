import type { ProviderCapabilityName } from "../adapter/provider-capabilities";

/**
 * 角色路由（docs/gate2-design.md §6）。
 *
 * 模型选择只能来自服务端受版本控制的角色配置；浏览器不得提交供应商名、
 * 模型名或供应商参数。不允许自动路由到未经验证的模型，也不存在静默降级。
 */

/** 角色键；配置变更进 Git，commit SHA 即配置版本标识（D-190 决策二）。 */
export const AI_ROLES = ["intent_parse", "management_analysis", "fallback"] as const;

export type AiRole = (typeof AI_ROLES)[number];

export const isAiRole = (value: unknown): value is AiRole =>
  typeof value === "string" && (AI_ROLES as readonly string[]).includes(value);

export interface RoleRouteConfig {
  readonly role: AiRole;
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly systemPromptVersion: string;
  readonly outputSchemaVersion: string;
  readonly requiredCapabilities: readonly ProviderCapabilityName[];
  /** 未经验证的模型不得被路由到（D-174）。 */
  readonly verified: boolean;
}

/**
 * 路由结果：不返回可执行的路由配置，或返回标准化错误码。
 * 任何分支都不返回部分可用的路由。
 */
export type RoleRouteResolution =
  | { readonly ok: true; readonly route: RoleRouteConfig }
  | { readonly ok: false; readonly errorCode: "PROVIDER_UNAVAILABLE" | "PROVIDER_REQUEST_INVALID" };

const isNonBlank = (value: string): boolean => value.trim().length > 0;

/**
 * 解析角色路由。未知角色、未验证配置或参数不合法都失败关闭。
 */
export const resolveRoleRoute = (
  routes: readonly RoleRouteConfig[],
  role: AiRole,
): RoleRouteResolution => {
  const route = routes.find((candidate) => candidate.role === role);
  if (route === undefined) return { ok: false, errorCode: "PROVIDER_UNAVAILABLE" };
  if (!route.verified) return { ok: false, errorCode: "PROVIDER_UNAVAILABLE" };
  if (
    !isNonBlank(route.provider) ||
    !isNonBlank(route.model) ||
    !isNonBlank(route.systemPromptVersion) ||
    !isNonBlank(route.outputSchemaVersion) ||
    !Number.isInteger(route.maxOutputTokens) ||
    route.maxOutputTokens <= 0
  ) {
    return { ok: false, errorCode: "PROVIDER_REQUEST_INVALID" };
  }
  return { ok: true, route };
};

/** 能力门在路由上的合并判定：配置缺失能力即返回标准化错误码。 */
export type RoleRouteCapabilityResolution =
  | { readonly ok: true; readonly route: RoleRouteConfig }
  | {
      readonly ok: false;
      readonly errorCode: "PROVIDER_UNAVAILABLE" | "PROVIDER_REQUEST_INVALID";
      readonly missingCapabilities: readonly ProviderCapabilityName[];
    };

export const resolveRoleRouteWithCapabilities = (
  routes: readonly RoleRouteConfig[],
  role: AiRole,
  grantedCapabilities: readonly ProviderCapabilityName[],
): RoleRouteCapabilityResolution => {
  const resolution = resolveRoleRoute(routes, role);
  if (!resolution.ok) return { ...resolution, missingCapabilities: [] };
  const missingCapabilities = resolution.route.requiredCapabilities.filter(
    (name) => !grantedCapabilities.includes(name),
  );
  if (missingCapabilities.length > 0) {
    return { ok: false, errorCode: "PROVIDER_REQUEST_INVALID", missingCapabilities };
  }
  return resolution;
};
