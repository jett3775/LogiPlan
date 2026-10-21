/**
 * 平台侧输入审核端口（D-193 决策三）。
 *
 * 审核在控制面的限流、L2 熔断检查与预算预留**之前**执行：命中或审核异常一律失败关闭，
 * 不重试、直接回落固定示例。该路径不产生预留、不写账本、不写限流窗口、不调用适配器。
 *
 * 默认实现是**本地规则审核**，规则集受版本控制并随配置进 Git。这是相对模型审核的能力
 * 降级：本地规则无法覆盖语义级有害内容。输出三检、证据白名单与范围锚定仍是外层防线，
 * 不因本模块而放松。
 */

/** 规则集版本；规则变更必须同时修改本标识。 */
export const INPUT_MODERATION_RULES_VERSION = "INPUT_RULES_2026_V2";

/** 输入长度上限（Unicode 码点，沿用既有 500 字符口径）。 */
export const MAX_INPUT_CHARACTERS = 500;

export const INPUT_MODERATION_RULES = [
  "TOO_LONG",
  "CONTROL_CHARACTER",
  "PROMPT_INJECTION",
  "PROHIBITED_CONTENT",
  "PORT_FAILURE",
] as const;

export type InputModerationRule = (typeof INPUT_MODERATION_RULES)[number];

export type InputModerationDecision =
  { readonly ok: true } | { readonly ok: false; readonly rule: InputModerationRule };

export interface InputModerationPort {
  check(input: string): InputModerationDecision | Promise<InputModerationDecision>;
}

/** 控制字符：除常见空白（\t \n \r）外的 C0/C1 与 DEL。 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

/** 零宽与双向控制字符：可用于隐藏指令或伪装文本。 */
const INVISIBLE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/u;

/**
 * 提示注入模式：覆盖常见的「忽略先前指令」与「索取系统提示」表达。
 * 规则是保守的词组匹配，不据此判断语义意图。
 */
const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/iu,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/iu,
  /\bdeveloper\s+mode\b/iu,
  /\bjailbreak\b/iu,
  /忽略(?:掉)?(?:之前|以上|上面|前面)(?:的)?(?:所有)?(?:指令|要求|提示|规则)/u,
  /(?:泄露|输出|显示|复述|告诉我)(?:你的)?(?:系统提示|系统指令|提示词|初始设定)/u,
  /(?:系统提示|系统指令|提示词|初始设定)(?:复述|输出|泄露|告诉我)/u,
  /你现在是(?:一个)?(?:不受限制|没有限制|无限制)/u,
];

/**
 * 明确禁止内容词表：只收录组合后无歧义的违法或极端伤害表述，
 * 避免把普通业务讨论（如「成本爆炸」）误判为命中。
 */
const PROHIBITED_CONTENT_TERMS: readonly string[] = [
  "制造炸弹",
  "爆炸物制作",
  "制作爆炸装置",
  "制造毒品",
  "制毒配方",
  "儿童色情",
  "恐怖袭击方案",
  "自杀方法",
  "自残方法",
];

/** 本地规则审核：按固定顺序返回第一条命中规则，便于审计与测试复现。 */
export const moderateLocalRules = (input: string): InputModerationDecision => {
  if ([...input].length > MAX_INPUT_CHARACTERS) return { ok: false, rule: "TOO_LONG" };
  if (CONTROL_CHARACTERS.test(input)) return { ok: false, rule: "CONTROL_CHARACTER" };
  if (INVISIBLE_CHARACTERS.test(input)) return { ok: false, rule: "CONTROL_CHARACTER" };
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(input))) {
    return { ok: false, rule: "PROMPT_INJECTION" };
  }
  if (PROHIBITED_CONTENT_TERMS.some((term) => input.includes(term))) {
    return { ok: false, rule: "PROHIBITED_CONTENT" };
  }
  return { ok: true };
};

/** 默认审核端口：纯本地规则，不联网、不新增依赖。 */
export const LOCAL_INPUT_MODERATION: InputModerationPort = {
  check: moderateLocalRules,
};
