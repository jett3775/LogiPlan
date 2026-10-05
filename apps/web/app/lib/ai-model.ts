import { managementAnalysisSchema } from "@logiplan/contracts";
import type {
  AiAnswerType,
  AnalysisScope,
  EvidenceObject,
  ManagementAnalysis,
} from "@logiplan/contracts";
import {
  FIXED_EXAMPLE_DATA_RELEASE_ID,
  FIXED_EXAMPLE_OUTPUT_SCHEMA_VERSION,
  GATEWAY_ERROR_STATUS_ZH,
  type EvidenceSnapshotPayload,
} from "@logiplan/ai";

import {
  EVIDENCE_ADDRESS_PARAMETERS,
  bindEvidenceAddress,
  type AttributionData,
  type DeterministicResult,
} from "./model";

/**
 * 闸门二 AI 回答的**共享**契约与纯逻辑（docs/gate2-implementation-plan.md 切片 1b）。
 *
 * 本模块被三处复用：`api/v1/ai/respond` 路由（HTTP 层）、`attribution/page.tsx`（SSR 层）
 * 与 `ai-workspace.tsx`（客户端呈现）。因此它**不引入 `server-only`**，也不做任何 I/O：
 * 数据库访问只在 `lib/query-server.ts`，浏览器不参与证据组装。
 *
 * 本切片 `answer_type` 恒为 `FIXED_EXAMPLE`：不调用任何模型即完整可用
 * （`gate2-design.md` §7 的统一口径）。
 */

/* ---------------------------------------------------------------------------
 * 浏览器输入契约（AC1.9 / AC1.10）
 *
 * 浏览器**只**提交自然语言问题与页面范围地址两个字段。供应商名、模型名、
 * 任意证据 ID 与供应商参数一律由服务端拒绝（D-174）；这里用「显式拒绝表 + 未知键
 * 一律拒绝」实现，而不是靠字段忽略——忽略会让越界提交静默通过。
 * ------------------------------------------------------------------------- */

/** 输入上限：按 **Unicode 码点**计（`[...text].length`），不是 UTF-16 单元。 */
export const AI_QUESTION_MAX_CODE_POINTS = 500;

/** 页面范围地址的字符上限；归因页地址远小于该值。 */
export const AI_PAGE_ADDRESS_MAX_LENGTH = 2_048;

/** 请求体字段白名单；`null` 表示「键本身合法」，其余为受控中文拒绝原因。 */
export const AI_REQUEST_FIELDS = ["question", "page_address"] as const;

/** 被显式点名的越界字段 → 拒绝分类。分类决定受控中文状态，便于逐类测试。 */
export type AiRejectCategory =
  "provider_name" | "model_name" | "evidence_id" | "provider_parameter";

const REJECTED_PROVIDER_NAME_FIELDS = [
  "provider",
  "provider_name",
  "provider_id",
  "vendor",
] as const;

const REJECTED_MODEL_NAME_FIELDS = ["model", "model_name", "model_id"] as const;

/**
 * 任意证据 ID 都不得由浏览器提交（D-174）。
 *
 * `evidence_id` / `evidence_ids` 是直接越界；`evidence_scope` 与
 * `evidence_snapshot_id` 同样越界——它们是归因页**地址状态**的一部分
 * （`docs/query-contract.md` §11），由服务端按页面范围自行解析。
 */
const REJECTED_EVIDENCE_FIELDS = [
  "evidence_id",
  "evidence_ids",
  "evidence_snapshot_id",
  "evidence_scope",
] as const;

/**
 * 供应商参数一律不得由浏览器提交（D-174）：模型与提示词的角色配置在
 * `gate2-design.md` §6 的受版本控制配置里，浏览器不得覆盖。
 */
const REJECTED_PROVIDER_PARAMETER_FIELDS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_output_tokens",
  "reasoning",
  "reasoning_effort",
  "response_format",
  "store",
  "seed",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "messages",
  "instructions",
  "system_prompt",
  "prompt_version",
  "output_schema_version",
  "price_version",
  "adapter",
  "adapter_version",
  "api_key",
  "base_url",
  "endpoint",
  "timeout_ms",
] as const;

const REJECTED_FIELD_CATEGORIES: ReadonlyArray<readonly [readonly string[], AiRejectCategory]> = [
  [REJECTED_PROVIDER_NAME_FIELDS, "provider_name"],
  [REJECTED_MODEL_NAME_FIELDS, "model_name"],
  [REJECTED_EVIDENCE_FIELDS, "evidence_id"],
  [REJECTED_PROVIDER_PARAMETER_FIELDS, "provider_parameter"],
];

/** 拒绝分类的受控中文状态。页面不得只显示字段名或内部错误码（AC1.5 同一口径）。 */
export const AI_REJECT_CATEGORY_ZH: Readonly<Record<AiRejectCategory, string>> = {
  provider_name: "浏览器不得提交供应商名，请只提交自然语言问题与页面范围地址。",
  model_name: "浏览器不得提交模型名，模型由服务端角色配置决定。",
  evidence_id: "浏览器不得提交证据 ID 或证据范围，证据由服务端按页面范围自行解析。",
  provider_parameter: "浏览器不得提交供应商参数，模型参数由服务端角色配置决定。",
};

/** 判定一个请求键属于哪类越界提交；不在白名单内的未知键由调用方按未知字段拒绝。 */
export const classifyRejectedField = (key: string): AiRejectCategory | null => {
  for (const [fields, category] of REJECTED_FIELD_CATEGORIES) {
    if (fields.includes(key)) return category;
  }
  return null;
};

export type AiRejectedRequest = {
  readonly ok: false;
  readonly category: AiRejectCategory | "unknown_field" | "malformed";
  readonly message_zh: string;
};

export type AiAcceptedRequest = {
  readonly ok: true;
  readonly question: string;
  readonly pageAddress: string;
};

export type AiParsedRequest = AiAcceptedRequest | AiRejectedRequest;

const MALFORMED_MESSAGE_ZH = "请求体必须是 JSON 对象，且只包含 question 与 page_address 两个字段。";

const UNKNOWN_FIELD_MESSAGE_ZH = "请求体包含不被接受的字段，请只提交 question 与 page_address。";

const reject = (
  category: AiRejectedRequest["category"],
  message_zh: string,
): AiRejectedRequest => ({
  ok: false,
  category,
  message_zh,
});

/**
 * 解析并校验 `POST /api/v1/ai/respond` 的请求体。
 *
 * 判定顺序：越界分类 → 未知键 → 字段类型 → 问题长度（AC1.10）→ 页面范围地址。
 * 先做分类拒绝，是为了让越界提交拿到**具体**的受控中文状态，而不是笼统的「字段不被接受」。
 */
export const parseAiRespondRequest = (body: unknown): AiParsedRequest => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return reject("malformed", MALFORMED_MESSAGE_ZH);
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const category = classifyRejectedField(key);
    if (category !== null) return reject(category, AI_REJECT_CATEGORY_ZH[category]);
  }
  for (const key of Object.keys(record)) {
    if (!(AI_REQUEST_FIELDS as readonly string[]).includes(key)) {
      return reject("unknown_field", UNKNOWN_FIELD_MESSAGE_ZH);
    }
  }
  const question = record.question;
  const pageAddress = record.page_address;
  if (typeof question !== "string" || typeof pageAddress !== "string") {
    return reject("malformed", MALFORMED_MESSAGE_ZH);
  }
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return reject("malformed", "问题不得为空字符串或全为空白。");
  }
  // AC1.10：按 Unicode 码点计长，超限即受控拒绝，不截断、不静默改写。
  if ([...question].length > AI_QUESTION_MAX_CODE_POINTS) {
    return reject(
      "malformed",
      `问题长度超过 ${AI_QUESTION_MAX_CODE_POINTS} 个字符上限，已被拒绝，未调用任何模型。`,
    );
  }
  const addressProblem = validatePageAddress(pageAddress);
  if (addressProblem !== null) return reject("malformed", addressProblem);
  return { ok: true, question: trimmed, pageAddress };
};

/**
 * 页面范围地址校验。
 *
 * 只接受**站内相对地址**且只接受本切片覆盖的归因范围：固定示例的 `scope_label` 与全部
 * 证据 ID 都锚定在「英国 2026-08 Actual vs Budget」（`fixed-example.ts` 的范围纪律），
 * 因此驾驶舱范围或其它目的国一律不受理，避免用错范围的证据回答问题。
 */
/**
 * `page_address` 允许携带的查询参数白名单。
 *
 * 浏览器提交的范围地址是一个**受控输入**，与顶层键同等对待：只有归因页自身使用的参数
 * 可以出现，其余一律拒绝。否则 `provider` / `model` / `evidence_id` /
 * `evidence_snapshot_id` 等越界参数可经由这里走私进来——即使服务端当前不消费它们，
 * 「显式拒绝而非静默忽略」也是 `gate2-design.md` §1.3 与 D-174 的要求。
 *
 * 取值范围见 `docs/query-contract.md` §11「页面地址状态」。
 */
const AI_PAGE_ADDRESS_ALLOWED_PARAMS: ReadonlySet<string> = new Set([
  "period",
  "comparison",
  "destination",
  "budget",
  "actual",
  "method",
  "factor",
  "path",
  "guide",
]);

export const validatePageAddress = (value: string): string | null => {
  if (value.length === 0 || value.length > AI_PAGE_ADDRESS_MAX_LENGTH) {
    return "页面范围地址为空或过长。";
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "页面范围地址必须是站内相对地址。";
  }
  let url: URL;
  try {
    url = new URL(value, "http://127.0.0.1");
  } catch {
    return "页面范围地址无法解析。";
  }
  if (url.origin !== "http://127.0.0.1") return "页面范围地址必须是站内相对地址。";
  if (url.pathname !== "/attribution") {
    return "当前只受理英国归因页（/attribution）范围内的管理分析请求。";
  }
  // 参数白名单：逐个键判定，重复键同样拒绝（`searchParams.get` 只取首值，重复即意味着
  // 存在被首个值掩盖的第二个值）。
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!AI_PAGE_ADDRESS_ALLOWED_PARAMS.has(key)) {
      return `页面范围地址不得携带参数 ${key}。`;
    }
    if (seen.has(key)) {
      return `页面范围地址不得重复携带参数 ${key}。`;
    }
    seen.add(key);
  }
  const destination = url.searchParams.get("destination");
  if (destination !== null && destination !== "GB") {
    return "当前只受理目的国为英国的归因范围。";
  }
  return null;
};

/* ---------------------------------------------------------------------------
 * 受控中文状态与穷尽映射（AC1.8 的页面渲染部分）
 * ------------------------------------------------------------------------- */

/**
 * 答案类型的中文文案。
 *
 * `packages/ai/src/labels/zh-labels.ts` 明确**不**映射答案类型（「那属切片 1b」），
 * 因此这张表由本页渲染层拥有。类型是 `Readonly<Record<AiAnswerType, string>>`：
 * 枚举新增取值而未补中文时 `tsc` 报错（AC1.8「新增枚举值会导致编译或测试失败」）。
 */
export const ANSWER_TYPE_ZH: Readonly<Record<AiAnswerType, string>> = {
  FIXED_EXAMPLE: "固定示例 · 未调用任何模型",
  LIVE_GENERATED: "真实模型生成",
};

/** `/api/v1/ai/respond` 的状态码；页面只显示 `status_label_zh`，不显示内部错误码。 */
export const AI_RESPOND_STATUS_CODES = [
  "FIXED_EXAMPLE",
  "INPUT_REJECTED",
  "EVIDENCE_WHITELIST_VIOLATION",
  "DETERMINISTIC_SOURCE_UNAVAILABLE",
] as const;

export type AiRespondStatusCode = (typeof AI_RESPOND_STATUS_CODES)[number];

/**
 * 状态码 → 受控中文状态。
 *
 * 能复用 `packages/ai` 的既有穷尽映射就复用（单一真相源），只有确定性查询不可用
 * 这一项是本切片特有的服务端故障，没有对应的 `GatewayErrorCode`。
 */
export const AI_RESPOND_STATUS_ZH: Readonly<Record<AiRespondStatusCode, string>> = {
  FIXED_EXAMPLE: ANSWER_TYPE_ZH.FIXED_EXAMPLE,
  INPUT_REJECTED: GATEWAY_ERROR_STATUS_ZH.INPUT_REJECTED,
  EVIDENCE_WHITELIST_VIOLATION: GATEWAY_ERROR_STATUS_ZH.EVIDENCE_WHITELIST_VIOLATION,
  DETERMINISTIC_SOURCE_UNAVAILABLE:
    "确定性查询服务暂时不可用，管理分析暂不可用；归因页数字与证据不受影响。",
};

/* ---------------------------------------------------------------------------
 * 证据白名单与真实快照绑定（AC1.1 的证据口径、R2）
 * ------------------------------------------------------------------------- */

/** 归因页只在四个结果族里检索证据（`attribution-workspace.tsx:538`）。 */
export const AI_EVIDENCE_FAMILIES = ["country", "bridge", "diagnostics", "drilldown"] as const;

export type AiEvidenceFamily = (typeof AI_EVIDENCE_FAMILIES)[number];

const FAMILY_ZH: Readonly<Record<AiEvidenceFamily, string>> = {
  country: "国家履约变动成本",
  bridge: "五因素归因",
  diagnostics: "经营与服务诊断",
  drilldown: "线路层下钻",
};

/**
 * 白名单条目：证据 ID + **服务端真实**快照 ID + 该证据所属的查询范围。
 *
 * `scope` 与 `evidence_snapshot_id` 缺一不可：`attribution-workspace.tsx:542` 要求证据对象
 * 带 `evidence_snapshot_id` 才打开面板，而 `packages/db/src/query-service.ts:2080` 要求
 * `EVIDENCE_LOOKUP` 的范围与证据锚点范围逐字一致。
 */
export type AiEvidenceEntry = {
  readonly evidence_id: string;
  readonly evidence_snapshot_id: string;
  readonly scope: AnalysisScope;
  readonly family: AiEvidenceFamily;
  readonly family_label_zh: string;
  readonly label_zh: string;
  readonly value: string;
  readonly unit: string;
};

export type AiEvidenceWhitelist = {
  readonly entries: readonly AiEvidenceEntry[];
  /** 同一快照内重复出现或跨族重复的证据 ID（数据异常信号，不静默去重）。 */
  readonly duplicated: readonly string[];
};

const whitelistEntriesFrom = (
  family: AiEvidenceFamily,
  result: DeterministicResult<unknown>,
): AiEvidenceEntry[] =>
  result.evidence.flatMap((item: EvidenceObject) => {
    // 没有真实快照 ID 的证据对象打不开证据面板，因此不进白名单（宁缺勿凑）。
    const snapshotId = item.evidence_snapshot_id;
    if (snapshotId === undefined) return [];
    return [
      {
        evidence_id: item.evidence_id,
        evidence_snapshot_id: snapshotId,
        scope: result.query_intent.scope,
        family,
        family_label_zh: FAMILY_ZH[family],
        // `metric` 在 `packages/db/src/query-result.ts` 里承载的就是中文标签
        // （如「国家履约变动成本差异」「结构因素」）。
        label_zh: item.metric,
        value: item.value,
        unit: item.unit,
      },
    ];
  });

/**
 * 从 `loadAttributionData()` 的四个结果组装证据白名单。
 *
 * 白名单是**范围锚定**的而非全局扁平集合（`gate2-design.md` §4.3 的 2026-10-05 注）：
 * 每个条目带上自己所属结果的 `query_intent.scope`，页面据此生成
 * `evidence_id` + `evidence_snapshot_id` + `evidence_scope` 三元组。
 */
export const buildEvidenceWhitelist = (data: AttributionData): AiEvidenceWhitelist => {
  const entries: AiEvidenceEntry[] = [
    ...whitelistEntriesFrom("country", data.country),
    ...whitelistEntriesFrom("bridge", data.bridge),
    ...whitelistEntriesFrom("diagnostics", data.diagnostics),
    ...whitelistEntriesFrom("drilldown", data.drilldown),
  ];
  const seen = new Map<string, number>();
  for (const entry of entries) seen.set(entry.evidence_id, (seen.get(entry.evidence_id) ?? 0) + 1);
  return {
    entries,
    duplicated: [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  };
};

/** 固定示例引用到的全部证据 ID（五个区块去重）。 */
export const collectAnswerEvidenceIds = (analysis: ManagementAnalysis): readonly string[] => {
  const ids = new Set<string>();
  for (const section of [
    analysis.conclusion,
    analysis.evidence,
    analysis.impact,
    analysis.limitations,
  ]) {
    for (const id of section.evidence_ids) ids.add(id);
  }
  for (const recommendation of analysis.recommendations) {
    for (const id of recommendation.evidence_ids) ids.add(id);
  }
  return [...ids];
};

/**
 * 结论区块的主证据 ID。
 *
 * 固定示例的 `evidence_snapshot_id` 必须绑定**服务端真实快照 ID**，而该字段是单值：
 * 取结论区块的首要证据 `E01-country` 所属 `country` 结果的快照 ID——四个族里
 * 该结果范围最窄（单一目的国、无因素下钻），且是结论与影响两个区块都引用的证据。
 */
export const PRIMARY_EVIDENCE_ID = "E01-country";

export type AiSnapshotBinding =
  | {
      readonly ok: true;
      readonly analysis: ManagementAnalysis;
      readonly evidence_snapshot_id: string;
      readonly whitelist: ReadonlyMap<string, AiEvidenceEntry>;
      /** 回答实际引用到的证据条目，按引用顺序去重；只这部分下发给浏览器。 */
      readonly cited: readonly AiEvidenceEntry[];
    }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * 用服务端真实快照 ID 绑定固定示例的 `evidence_snapshot_id`（交接要点 3）。
 *
 * ## 占位值的来源与替换策略
 *
 * `packages/ai/src/fixed-example/fixed-example.ts:213` 把 `evidence_snapshot_id` 硬编码为
 * `"SNAPSHOT_GB_2026_08_V1"`。那是**编造占位值**，不是任何真实快照：中立层（`gate2-design.md`
 * §1.2）从不接触数据库，无从得知真实 ID；而它恰好能通过公共契约的
 * `evidenceSnapshotIdSchema`（1—240 字符、非空白、无首尾空格），因此写入 `sessionStorage`
 * 不会报错、失败是**静默**的——页面照样渲染，但点击任何证据都打不开面板
 * （`attribution-workspace.tsx:542` 的 `if (!source || !item?.evidence_snapshot_id) return;`）。
 *
 * 替换策略：真实 ID 由服务端从 `loadAttributionData()` 返回的四个结果里取
 * （`persistQueryEvidenceSnapshot` 为每次确定性查询产出 `ES-<uuid>`，
 * `packages/db/src/query-service.ts:2187`），并**逐条校验**固定示例引用的每个证据 ID 都在
 * 白名单内。任一缺失即整体丢弃并回落受控状态（`EVIDENCE_WHITELIST_VIOLATION`），
 * 不裁剪、不部分展示（`gate2-design.md` §4.3）。
 */
export const bindAnswerToRealSnapshot = (
  analysis: ManagementAnalysis,
  whitelist: AiEvidenceWhitelist,
): AiSnapshotBinding => {
  const index = new Map(whitelist.entries.map((entry) => [entry.evidence_id, entry]));
  const referenced = collectAnswerEvidenceIds(analysis);
  const missing = referenced.filter((id) => !index.has(id));
  if (missing.length > 0 || whitelist.duplicated.length > 0) return { ok: false, missing };
  const primary = index.get(PRIMARY_EVIDENCE_ID);
  if (primary === undefined) return { ok: false, missing: [PRIMARY_EVIDENCE_ID] };
  const validated = managementAnalysisSchema.safeParse({
    ...analysis,
    evidence_snapshot_id: primary.evidence_snapshot_id,
  });
  if (!validated.success) return { ok: false, missing: ["__contract__"] };
  return {
    ok: true,
    analysis: validated.data,
    evidence_snapshot_id: primary.evidence_snapshot_id,
    whitelist: index,
    cited: referenced.flatMap((id) => {
      const entry = index.get(id);
      return entry === undefined ? [] : [entry];
    }),
  };
};

/* ---------------------------------------------------------------------------
 * 响应体形状
 * ------------------------------------------------------------------------- */

/** 哨兵值：固定示例不经过供应商、模型与提示词，故这三项不适用。 */
export const NOT_APPLIED_FIXED_EXAMPLE = "NOT_APPLIED_FIXED_EXAMPLE";

/**
 * 固定示例快照的六项版本（`gate2-design.md` §4.2）。
 *
 * `provider` / `model` / `prompt_version` 三项本切片不适用：本切片不调用任何模型，
 * 没有供应商、模型与提示词参与。取值用显式哨兵而不是留空——`snapshotVersionsSchema`
 * 要求非空字符串，而「不适用」必须与「某个供应商的某个模型」可区分。
 */
export const FIXED_EXAMPLE_SNAPSHOT_VERSIONS = {
  contract_version: "V1.1",
  data_release_id: FIXED_EXAMPLE_DATA_RELEASE_ID,
  provider: NOT_APPLIED_FIXED_EXAMPLE,
  model: NOT_APPLIED_FIXED_EXAMPLE,
  prompt_version: NOT_APPLIED_FIXED_EXAMPLE,
  output_schema_version: FIXED_EXAMPLE_OUTPUT_SCHEMA_VERSION,
} as const satisfies Readonly<Record<string, string>>;

/**
 * 由页面当前地址得到「页面范围地址」。
 *
 * 浏览器只提交自然语言与页面范围地址两个字段（`docs/query-contract.md` §11 的地址状态），
 * 证据地址参数必须先剥掉：证据 ID 不得由浏览器提交（D-174），否则等于让浏览器指定证据。
 */
export const aiPageAddressFromLocation = (href: string): string => {
  const url = new URL(href);
  for (const key of EVIDENCE_ADDRESS_PARAMETERS) url.searchParams.delete(key);
  return `${url.pathname}${url.search}`;
};

/** 用白名单条目生成证据地址；复用页面既有契约（`model.ts` 的 `bindEvidenceAddress`）。 */
export const bindAiEvidenceAddress = (url: URL, entry: AiEvidenceEntry): void => {
  bindEvidenceAddress(url, entry, entry.scope);
};

export type AiAnswerBlock = {
  readonly scope_label: string;
  readonly answer_type: AiAnswerType;
  readonly analysis: ManagementAnalysis;
  readonly evidence: readonly AiEvidenceEntry[];
  /**
   * 写进本页不可变快照的载荷：主证据所属的那次确定性结果的不可变副本
   * （`gate2-design.md` §4.1）。只随主证据的 `country` 结果下发，体积为一个国家摘要结果。
   *
   * ⚠️ **已知覆盖缺口（独立审查 P1-2，待后续切片处置）**：本回答引用的证据分属
   * `country` / `bridge` / `diagnostics` / `drilldown` **四个不同的** `evidence_snapshot_id`，
   * 而 `ManagementAnalysis.evidence_snapshot_id` 是**单值**（`docs/query-contract.md` §10 定义为
   * 必填标量），本块取主证据所属的 `country` 快照。因此：
   * - 逐条打开证据**不受影响**——`entries[].evidence_snapshot_id` 是每条自带，链接由它生成；
   * - 但若后续切片按 `gate2-design.md` §4.2「页面恢复的六项校验」真从本快照恢复，
   *   15 条引用中有 14 条将不可解析。
   *
   * 正确处置需把「本回答引用了哪些快照」提升为一等事实（按族分组携带多份种子载荷），
   * 这要改 `packages/contracts` 的输出契约与 `docs/query-contract.md` §10，超出切片 1b 写范围。
   * 本切片**不**静默扩范围，也**不**把单值语义伪装成覆盖全篇。
   */
  readonly snapshot_seed: EvidenceSnapshotPayload;
};

export type AiRespondSuccess = {
  readonly ok: true;
  readonly status: "FIXED_EXAMPLE";
  readonly status_label_zh: string;
  readonly answer: AiAnswerBlock;
  readonly request_id: string;
};

export type AiRespondFailure = {
  readonly ok: false;
  readonly status: Exclude<AiRespondStatusCode, "FIXED_EXAMPLE">;
  readonly status_label_zh: string;
  readonly message_zh: string;
  readonly request_id: string;
};

export type AiRespondBody = AiRespondSuccess | AiRespondFailure;
