/**
 * 输出守卫：固定示例与任何未来输出都要过「数字可回指」与「无未经情景计算
 * 支持的节省金额」两道本切片守卫（docs/gate2-design.md §4.3、AC1.4）。
 *
 * 守卫只做机械判定，不做语义判断。
 */

/** 金额/比例呈现形式的判定：带千分位、带小数、或紧跟货币与百分比单位。 */
const MONEY_UNIT_SUFFIX = /^\s*(?:%|万元|亿元|元|万|亿|CNY|RMB|USD)/u;

const NUMBER_TOKEN = /[0-9][0-9,]*(?:\.[0-9]+)?/gu;

export interface OutputGuardViolation {
  readonly kind: "UNSUPPORTED_SAVINGS_AMOUNT" | "UNSUPPORTED_NUMBER";
  readonly value: string;
  readonly context: string;
}

export const isMoneyLikeToken = (token: string, suffix: string): boolean => {
  if (token.includes(",") || token.includes(".")) return true;
  return MONEY_UNIT_SUFFIX.test(suffix);
};

/** 归一化：`891,643.2815` → `891643.2815`。 */
export const normalizeNumberToken = (token: string): string => token.replaceAll(",", "");

/**
 * 百分比呈现形式：把小数点右移两位的字符串运算，避免浮点误差。
 * `0.1369` → `13.69`；`0.0288` → `02.88` 与 `2.88`。
 */
const percentForms = (normalized: string): readonly string[] => {
  if (!normalized.startsWith("0.")) return [];
  const digits = normalized.slice(2).padStart(2, "0");
  const withDecimal = digits.length > 2 ? `${digits.slice(0, 2)}.${digits.slice(2)}` : digits;
  const stripped = withDecimal.replace(/^0+(?=\d)/u, "");
  return stripped === withDecimal ? [withDecimal] : [withDecimal, stripped];
};

/** 构造一个数字的全部合法呈现形式。 */
export const supportedFormsOf = (requiredNumber: string): readonly string[] => {
  const normalized = normalizeNumberToken(requiredNumber);
  if (!/^\d+(\.\d+)?$/u.test(normalized)) return [];
  return [normalized, ...percentForms(normalized)];
};

const findNumberTokens = (text: string): readonly { value: string; index: number }[] => {
  const matches = text.matchAll(NUMBER_TOKEN);
  return [...matches].map((match) => ({ value: match[0], index: match.index }));
};

const contextAround = (text: string, index: number, length: number): string =>
  text.slice(Math.max(0, index - 12), Math.min(text.length, index + length + 12));

/**
 * 找出不能回指 `supportedNumbers` 的金额/比例 token。
 * 纯整数且不带货币单位的 token（如「Top 10 单」「2026 年」）不参与判定。
 */
export const findUnsupportedNumbers = (
  text: string,
  supportedNumbers: readonly string[],
): readonly OutputGuardViolation[] => {
  const allowed = new Set(supportedNumbers.flatMap(supportedFormsOf));
  const violations: OutputGuardViolation[] = [];
  for (const token of findNumberTokens(text)) {
    const suffix = text.slice(token.index + token.value.length);
    if (!isMoneyLikeToken(token.value, suffix)) continue;
    if (allowed.has(normalizeNumberToken(token.value))) continue;
    violations.push({
      kind: "UNSUPPORTED_NUMBER",
      value: token.value,
      context: contextAround(text, token.index, token.value.length),
    });
  }
  return violations;
};

/**
 * 「节省」类断言词；后接金额即视为未经情景计算支持的节省金额。
 *
 * 词表覆盖三类中文表述，任何一类漏掉都会让编造的节省金额通过守卫：
 * 1. 直接节省（节省、节约、省下、缩减、压缩、削减）；
 * 2. 降本口径（降本、降费、减少成本）；
 * 3. **方向性下降表述**（降低、下降、下调、回落、减少）——这类词本身不含
 *    「节省」二字，却同样是在承诺成本会下降，必须一并拦截。
 */
const SAVINGS_CLAIM =
  /(节省|节约|省下|降本|降费|回收|挽回|削减|压缩|缩减|降低|下降|下调|回落|减少)/gu;

/**
 * 找出「未经情景计算支持的节省金额」：节省类断言词附近出现金额或比例。
 * 只断言金额，不做语义判断。
 */
export const findUnsupportedSavingsClaims = (text: string): readonly OutputGuardViolation[] => {
  const violations: OutputGuardViolation[] = [];
  for (const claim of text.matchAll(SAVINGS_CLAIM)) {
    const start = claim.index ?? 0;
    const window = text.slice(start, start + 40);
    const tokens = findNumberTokens(window).filter((token) =>
      isMoneyLikeToken(token.value, window.slice(token.index + token.value.length)),
    );
    for (const token of tokens) {
      violations.push({
        kind: "UNSUPPORTED_SAVINGS_AMOUNT",
        value: token.value,
        context: contextAround(text, start + token.index, token.value.length),
      });
    }
  }
  return violations;
};

/** 汇总一段文本上的两类守卫结果。 */
export const inspectText = (
  text: string,
  supportedNumbers: readonly string[],
): readonly OutputGuardViolation[] => [
  ...findUnsupportedSavingsClaims(text),
  ...findUnsupportedNumbers(text, supportedNumbers),
];

/** 深度收集对象内所有字符串，用于对整个回答做守卫扫描。 */
export const collectStrings = (value: unknown, into: string[] = []): string[] => {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
  return into;
};

/**
 * 对整个回答对象跑守卫。
 *
 * 例外：`evidence_ids`、`evidence_snapshot_id`、`answer_id`、`evaluation_question_ids`
 * 是标识符而非陈述，扫描标识符只会制造噪音；五区块正文与建议正文才是可能编造
 * 数字或承诺节省的地方，因此只扫描这些陈述字段。
 */
export const inspectAnswerText = (
  answer: {
    readonly scope_label: string;
    readonly conclusion: { readonly text: string };
    readonly evidence: { readonly text: string };
    readonly impact: { readonly text: string };
    readonly recommendations: readonly { readonly text: string }[];
    readonly limitations: { readonly text: string };
  },
  supportedNumbers: readonly string[],
): readonly OutputGuardViolation[] =>
  [
    answer.scope_label,
    answer.conclusion.text,
    answer.evidence.text,
    answer.impact.text,
    answer.limitations.text,
    ...answer.recommendations.map((recommendation) => recommendation.text),
  ].flatMap((text) => inspectText(text, supportedNumbers));
