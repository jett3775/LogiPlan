import { describe, expect, it } from "vitest";

import {
  FIXED_EXAMPLE_DATA_RELEASE_ID,
  FIXED_EXAMPLE_OUTPUT_SCHEMA_VERSION,
  GATEWAY_ERROR_STATUS_ZH,
  SNAPSHOT_VERSION_FIELDS,
  buildFixedExampleAnalysis,
} from "@logiplan/ai";
import {
  aiAnswerTypeSchema,
  managementAnalysisSchema,
  type AnalysisScope,
  type AttributionFactor,
  type EvidenceObject,
  type ManagementAnalysis,
  type MoneyValue,
  type QueryIntent,
} from "@logiplan/contracts";

import {
  EVIDENCE_ADDRESS_PARAMETERS,
  attributionIntents,
  type AttributionData,
  type DeterministicResult,
} from "./model";
import {
  AI_EVIDENCE_FAMILIES,
  AI_PAGE_ADDRESS_MAX_LENGTH,
  AI_QUESTION_MAX_CODE_POINTS,
  AI_REJECT_CATEGORY_ZH,
  AI_REQUEST_FIELDS,
  AI_RESPOND_STATUS_CODES,
  AI_RESPOND_STATUS_ZH,
  ANSWER_TYPE_ZH,
  FIXED_EXAMPLE_SNAPSHOT_VERSIONS,
  NOT_APPLIED_FIXED_EXAMPLE,
  aiPageAddressFromLocation,
  bindAiEvidenceAddress,
  bindAnswerToRealSnapshot,
  buildAnswerSnapshotSeeds,
  buildEvidenceWhitelist,
  classifyRejectedField,
  collectAnswerEvidenceIds,
  parseAiRespondRequest,
  validatePageAddress,
  type AiAcceptedRequest,
  type AiEvidenceEntry,
  type AiEvidenceFamily,
  type AiEvidenceWhitelist,
  type AiRejectCategory,
  type AiRejectedRequest,
} from "./ai-model";

/**
 * 闸门二切片 1b（`docs/gate2-implementation-plan.md`）共享边界的单元测试。
 *
 * 本模块是「浏览器只提交自然语言与页面范围地址」（D-174、AC1.9 / AC1.10）这条边界的
 * 唯一实现点，此前**零单元测试**。切片 1b 的 P1 缺陷——`page_address` 可走私
 * `provider` / `model` / `evidence_id` 并全部返回 200——是人工对抗性审查发现的，
 * 没有任何自动化测试本该拦住它；本文件把该缺陷面固化为回归测试。
 *
 * 覆盖的契约面：
 * - AC1.9：顶层键与 `page_address` 查询参数**逐键白名单**，白名单外与重复键一律拒绝；
 * - AC1.10：问题长度按 Unicode **码点**计（`[...text].length`），超限受控拒绝；
 * - AC1.8：答案类型与状态码走穷尽中文映射，枚举新增取值会导致本测试失败；
 * - AC1.1 / R2：证据白名单**范围锚定**（逐条带自身 `query_intent.scope`），
 *   固定示例的占位 `evidence_snapshot_id` 必须被替换为服务端真实快照 ID。
 */

/* ---------------------------------------------------------------------------
 * 契约常量：被测源文件里四张显式拒绝表、页面参数白名单与族标签的独立抄录
 *
 * 这些值在源文件里都不导出（`REJECTED_*`、`AI_PAGE_ADDRESS_ALLOWED_PARAMS`、
 * `FAMILY_ZH` 是模块私有的）。抄录而非导入，正是为了让「表里多一个键 / 少一个键 /
 * 改一个标签」这类改动必然让本测试失败。
 * ------------------------------------------------------------------------- */

const REJECTED_PROVIDER_NAME_FIELDS = [
  "provider",
  "provider_name",
  "provider_id",
  "vendor",
] as const;

const REJECTED_MODEL_NAME_FIELDS = ["model", "model_name", "model_id"] as const;

const REJECTED_EVIDENCE_FIELDS = [
  "evidence_id",
  "evidence_ids",
  "evidence_snapshot_id",
  "evidence_snapshot_ids",
  "evidence_scope",
] as const;

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

const REJECT_CATEGORIES = [
  "provider_name",
  "model_name",
  "evidence_id",
  "provider_parameter",
] as const;

/** 四张拒绝表的扁平展开：`[字段名, 期望分类]`，逐条断言用的唯一真源。 */
const REJECTED_FIELDS: readonly (readonly [string, AiRejectCategory])[] = [
  ...REJECTED_PROVIDER_NAME_FIELDS.map((field): readonly [string, AiRejectCategory] => [
    field,
    "provider_name",
  ]),
  ...REJECTED_MODEL_NAME_FIELDS.map((field): readonly [string, AiRejectCategory] => [
    field,
    "model_name",
  ]),
  ...REJECTED_EVIDENCE_FIELDS.map((field): readonly [string, AiRejectCategory] => [
    field,
    "evidence_id",
  ]),
  ...REJECTED_PROVIDER_PARAMETER_FIELDS.map((field): readonly [string, AiRejectCategory] => [
    field,
    "provider_parameter",
  ]),
];

/** `docs/query-contract.md` §11「页面地址状态」里归因页自身使用的九个参数。 */
const PAGE_ADDRESS_ALLOWED_PARAMS = [
  "period",
  "comparison",
  "destination",
  "budget",
  "actual",
  "method",
  "factor",
  "path",
  "guide",
] as const;

/** 每个白名单参数取一个**本身也合法**的取值（`destination` 必须是 `GB`）。 */
const PAGE_ADDRESS_PARAM_VALUES: Readonly<
  Record<(typeof PAGE_ADDRESS_ALLOWED_PARAMS)[number], string>
> = {
  period: "2026-08",
  comparison: "ACTUAL_VS_BUDGET",
  destination: "GB",
  budget: "BUDGET_2026_V1",
  actual: "ACTUAL_2026_08_CLOSE_V1",
  method: "CHAIN",
  factor: "MIX",
  path: "/attribution",
  guide: "GB_TRANSPORT_GUIDE",
};

/** 白名单之外的参数：前四项正是切片 1b 的 P1 走私面，其余是同类越界与无关键。 */
const PAGE_ADDRESS_FORBIDDEN_PARAMS = [
  "provider",
  "model",
  "evidence_id",
  "evidence_ids",
  "evidence_snapshot_id",
  "evidence_snapshot_ids",
  "evidence_scope",
  "temperature",
  "api_key",
  "locale",
  "tab",
] as const;

/**
 * **独立于上方两张表**的第三组键：语义上「最可能被顺手加进白名单」的参数。
 *
 * 上两张表只能抓住「删键」与「白名单外随机键」；「往白名单里加键」这个失效方向需要
 * 一份**不参与遍历抄录表**的独立声明才能被测到——切片 1b 的 P1 缺陷本体正是
 * `provider` / `model` / `evidence_id` 被放行，`factor_id` 则是现实中最可能被顺手加进去
 * 的参数（`AnalysisScope` 里的字段名就叫 `factor_id`，而白名单里是 `factor`）。
 *
 * 因此这组键**不得**并入 `PAGE_ADDRESS_ALLOWED_PARAMS` 或
 * `PAGE_ADDRESS_FORBIDDEN_PARAMS`，否则断言会退化成遍历自己抄的表。
 */
const PAGE_ADDRESS_SEMANTIC_TRAPS = [
  "factor_id",
  "intent",
  "evidence",
  "evidence_panel",
  "section",
  "format",
  "view",
  "filter",
  "lang",
  "currency",
  "granularity",
  "q",
  "from",
  "to",
  "compare",
  "scope",
  "locale",
  "fields",
  "expand",
  "include",
  "depth",
] as const;

/** 四个证据族的受控中文标签（`attribution-workspace.tsx` 的呈现口径）。 */
const FAMILY_LABELS_ZH: Readonly<Record<AiEvidenceFamily, string>> = {
  country: "国家履约变动成本",
  bridge: "五因素归因",
  diagnostics: "经营与服务诊断",
  drilldown: "线路层下钻",
};

const VALID_PAGE_ADDRESS = "/attribution?period=2026-08&destination=GB";
const PRIMARY_EVIDENCE_ID = "E01-country";

/* ---------------------------------------------------------------------------
 * 夹具：证据对象、确定性结果与归因数据
 *
 * `buildEvidenceWhitelist` 只读 `result.evidence[]` 的四个字段与 `result.query_intent.scope`，
 * 但类型上仍要求四个完整 payload。四个 payload 的数组字段一律取空数组，
 * 因此夹具类型完全合法，不需要任何 `any` / `never` 断言。
 * ------------------------------------------------------------------------- */

const FAMILY_SNAPSHOT_IDS: Readonly<Record<AiEvidenceFamily, string>> = {
  country: "ES-00000000-0000-4000-8000-0000000000c1",
  bridge: "ES-00000000-0000-4000-8000-0000000000b1",
  diagnostics: "ES-00000000-0000-4000-8000-0000000000d1",
  drilldown: "ES-00000000-0000-4000-8000-0000000000e1",
};

const money = (amount: string): MoneyValue => ({
  high_precision: amount,
  report: amount,
  display: amount,
  currency: "CNY",
});

const comparison = attributionIntents().country.scope.comparison;

/**
 * 证据对象夹具里三个展示字段的字面量。
 *
 * 单独提出常量，是为了让 `buildEvidenceWhitelist` 的断言能与夹具**逐字等值**比较
 * （而不是「非空」），这样 `label_zh` 被改成 `item.unit`、被大写、或 `value` 被换成
 * 硬编码值这类变异都会让测试变红。
 */
const EVIDENCE_METRIC_ZH = "国家履约变动成本差异";
const EVIDENCE_VALUE = "1234.5600";
const EVIDENCE_UNIT = "CNY";

/**
 * 第二条 `metric` 夹具：**刻意含大小写敏感的 ASCII 片段**。
 *
 * `EVIDENCE_METRIC_ZH` 全是非 ASCII 字符，`toUpperCase()` / `toLowerCase()` 对它是恒等
 * 变换，因此只用它做等值断言时，「把 label_zh 大写/小写化」这类变异会存活（已实测）。
 * 补一条含 `Carrier C` / `Air Share` 的 metric 后，大小写改写即可被逮住。
 */
const EVIDENCE_METRIC_WITH_CASE = "Carrier C 空运占比 (Air Share)";

const evidenceObject = (
  evidenceId: string,
  options: { readonly snapshotId?: string | undefined; readonly metric?: string } = {},
): EvidenceObject => ({
  evidence_id: evidenceId,
  evidence_snapshot_id: options.snapshotId,
  data_release_id: FIXED_EXAMPLE_DATA_RELEASE_ID,
  metric: options.metric ?? EVIDENCE_METRIC_ZH,
  value: EVIDENCE_VALUE,
  unit: EVIDENCE_UNIT,
  period: { from: "2026-08", to: "2026-08" },
  comparison,
  filters: { destination_country_id: ["GB"] },
  group_by: ["DESTINATION_COUNTRY"],
  versions: {
    budget: "BUDGET_2026_V1",
    actual: "ACTUAL_2026_08_CLOSE_V1",
    calculation: "D-092",
  },
  calculation_method: "SUBTRACTION",
  source_result_id: "RESULT-ATTRIBUTION",
  snapshot_generated_at: "2026-09-01T00:00:00.000Z",
  source_refs: [],
});

const deterministicResult = <T>(
  queryIntent: QueryIntent,
  payload: T,
  evidence: readonly EvidenceObject[],
): DeterministicResult<T> => ({
  contract_version: "V1.1",
  result_id: "RESULT-ATTRIBUTION",
  query_intent: queryIntent,
  scope_label: "2026 年 8 月｜英国｜Actual vs Budget",
  data_as_of: "2026-08-31",
  generated_at: "2026-09-01T00:00:00.000Z",
  reporting_currency: "CNY",
  precision: { calculation: "HIGH_PRECISION_DECIMAL", report_places: 4, display_places: 2 },
  payload,
  evidence: [...evidence],
  warnings: [],
});

/**
 * 按证据 ID 前缀归族，与 `packages/db` 实际产出的四族结果一致：
 * `E01-*` → country、`ATTRIBUTION_BRIDGE:*` → bridge、`DIAGNOSTIC_METRICS:*` → diagnostics、
 * `ATTRIBUTION_DRILLDOWN:*` → drilldown。
 */
const familyOfEvidenceId = (evidenceId: string): AiEvidenceFamily => {
  if (evidenceId.startsWith("ATTRIBUTION_BRIDGE:")) return "bridge";
  if (evidenceId.startsWith("DIAGNOSTIC_METRICS:")) return "diagnostics";
  if (evidenceId.startsWith("ATTRIBUTION_DRILLDOWN:")) return "drilldown";
  return "country";
};

const FIXED_EXAMPLE_EVIDENCE_IDS = collectAnswerEvidenceIds(buildFixedExampleAnalysis());

/** 白名单夹具：固定示例引用的每条证据按族落位，快照 ID 按族不同。 */
const attributionDataOf = (
  options: {
    readonly factor?: AttributionFactor | undefined;
    readonly extraCountry?: readonly EvidenceObject[];
    readonly naked?: readonly EvidenceObject[];
  } = {},
): AttributionData => {
  const intents = attributionIntents(options.factor);
  const grouped: Record<AiEvidenceFamily, EvidenceObject[]> = {
    country: [],
    bridge: [],
    diagnostics: [],
    drilldown: [],
  };
  for (const evidenceId of FIXED_EXAMPLE_EVIDENCE_IDS) {
    const family = familyOfEvidenceId(evidenceId);
    grouped[family].push(evidenceObject(evidenceId, { snapshotId: FAMILY_SNAPSHOT_IDS[family] }));
  }
  grouped.country.push(...(options.extraCountry ?? []), ...(options.naked ?? []));
  return {
    country: deterministicResult(
      intents.country,
      {
        destination_country_id: "GB",
        baseline: money("317169.0583"),
        current: money("891643.2815"),
        variance: money("574474.2232"),
      },
      grouped.country,
    ),
    bridge: deterministicResult(
      intents.bridge,
      {
        baseline: money("317169.0583"),
        factors: [],
        current: money("891643.2815"),
        reconciliation_delta: money("0.0000"),
        method: "CHAIN",
      },
      grouped.bridge,
    ),
    diagnostics: deterministicResult(
      intents.diagnostics,
      {
        diagnostics: [],
        service_evaluation: {
          maturity_status: "FINAL",
          status_label_zh: "服务成熟度已定稿",
          on_time_denominator_policy_zh: "分母口径：已完成履约的订单",
          maturity_definition_zh: "成熟度定义：已记录的履约服务水平",
        },
      },
      grouped.diagnostics,
    ),
    drilldown: deterministicResult(
      intents.drilldown,
      { rows: [], primary_contribution: "MIX", method: "CHAIN" },
      grouped.drilldown,
    ),
  };
};

const ATTRIBUTION_DATA = attributionDataOf();

/* ---------------------------------------------------------------------------
 * 夹具：管理分析与白名单条目
 * ------------------------------------------------------------------------- */

/** 固定示例里的编造占位值（`fixed-example.ts`）：能通过公共契约，因此失败是静默的。 */
const PLACEHOLDER_SNAPSHOT_IDS = buildFixedExampleAnalysis().evidence_snapshot_ids;

const analysisWithEvidence = (groups: {
  readonly conclusion?: readonly string[];
  readonly evidence?: readonly string[];
  readonly impact?: readonly string[];
  readonly limitations?: readonly string[];
  readonly recommendations?: readonly (readonly string[])[];
}): ManagementAnalysis => ({
  answer_id: "ANSWER-UNIT-TEST",
  answer_type: "FIXED_EXAMPLE",
  scope_label: "2026 年 8 月｜英国｜Actual vs Budget｜固定示例",
  conclusion: { text: "结论段落。", evidence_ids: [...(groups.conclusion ?? [])] },
  evidence: { text: "证据段落。", evidence_ids: [...(groups.evidence ?? [])] },
  impact: { text: "影响段落。", evidence_ids: [...(groups.impact ?? [])] },
  limitations: { text: "局限段落。", evidence_ids: [...(groups.limitations ?? [])] },
  recommendations: (groups.recommendations ?? [[]]).map((evidenceIds, index) => ({
    text: `建议 ${index + 1}。`,
    evidence_ids: [...evidenceIds],
    scenario_validation_status: "NOT_RUN" as const,
    feasibility_status: "NOT_VALIDATED" as const,
  })),
  evidence_snapshot_ids: [...PLACEHOLDER_SNAPSHOT_IDS],
  evaluation_question_ids: ["E01"],
});

const entryOf = (
  evidenceId: string,
  options: { readonly family?: AiEvidenceFamily | undefined } = {},
): AiEvidenceEntry => {
  const family = options.family ?? "country";
  return {
    evidence_id: evidenceId,
    evidence_snapshot_id: FAMILY_SNAPSHOT_IDS[family],
    scope: attributionIntents().country.scope,
    family,
    family_label_zh: FAMILY_LABELS_ZH[family],
    label_zh: EVIDENCE_METRIC_ZH,
    value: EVIDENCE_VALUE,
    unit: EVIDENCE_UNIT,
  };
};

const whitelistOf = (entries: readonly AiEvidenceEntry[]): AiEvidenceWhitelist => ({
  entries,
  duplicated: [],
});

const accepted = (body: unknown): AiAcceptedRequest => {
  const parsed = parseAiRespondRequest(body);
  if (!parsed.ok) throw new Error(`预期接受，实际拒绝：${parsed.category} ${parsed.message_zh}`);
  return parsed;
};

const rejected = (body: unknown): AiRejectedRequest => {
  const parsed = parseAiRespondRequest(body);
  if (parsed.ok) throw new Error(`预期拒绝，实际接受：${parsed.pageAddress}`);
  return parsed;
};

const boundOrThrow = (
  analysis: ManagementAnalysis,
  whitelist: AiEvidenceWhitelist,
): Extract<ReturnType<typeof bindAnswerToRealSnapshot>, { readonly ok: true }> => {
  const binding = bindAnswerToRealSnapshot(analysis, whitelist);
  if (!binding.ok) throw new Error(`预期绑定成功，实际失败关闭：${binding.missing.join(", ")}`);
  return binding;
};

/* ---------------------------------------------------------------------------
 * 输入契约常量
 * ------------------------------------------------------------------------- */

describe("浏览器输入契约常量", () => {
  it("请求体字段白名单恰好是 question 与 page_address 两个键", () => {
    expect([...AI_REQUEST_FIELDS]).toEqual(["question", "page_address"]);
  });

  it("长度上限是显式常量，不是散落在实现里的魔数", () => {
    expect(AI_QUESTION_MAX_CODE_POINTS).toBe(500);
    expect(AI_PAGE_ADDRESS_MAX_LENGTH).toBe(2_048);
  });
});

/* ---------------------------------------------------------------------------
 * 越界字段的显式拒绝分类（D-174）
 * ------------------------------------------------------------------------- */

describe("越界字段的显式拒绝分类", () => {
  it("四张拒绝表共 37 个字段，逐条命中既定分类，没有一条落入 null", () => {
    expect(REJECTED_FIELDS).toHaveLength(37);
    for (const [field, category] of REJECTED_FIELDS) {
      expect(classifyRejectedField(field), field).toBe(category);
    }
  });

  it.each(REJECT_CATEGORIES)("分类 %s 至少有一条字段，且理由是非空中文", (category) => {
    const fields = REJECTED_FIELDS.filter(([, mapped]) => mapped === category).map(
      ([field]) => field,
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(classifyRejectedField(field)).toBe(category);
    }
    expect(AI_REJECT_CATEGORY_ZH[category].trim().length).toBeGreaterThan(0);
  });

  it("四张表的大小被冻结", () => {
    expect(REJECTED_PROVIDER_NAME_FIELDS).toHaveLength(4);
    expect(REJECTED_MODEL_NAME_FIELDS).toHaveLength(3);
    expect(REJECTED_EVIDENCE_FIELDS).toHaveLength(5);
    expect(REJECTED_PROVIDER_PARAMETER_FIELDS).toHaveLength(25);
  });

  it("拒绝表里没有重复键，也没有把合法字段误列为越界", () => {
    const fields = REJECTED_FIELDS.map(([field]) => field);
    expect(new Set(fields).size).toBe(fields.length);
    for (const field of AI_REQUEST_FIELDS) {
      expect(classifyRejectedField(field), field).toBeNull();
    }
  });

  it("白名单外的未知键返回 null，由调用方按未知字段拒绝", () => {
    const unknown = [
      "",
      " ",
      "questions",
      "question ",
      "PAGE_ADDRESS",
      "prompt",
      "topP",
      "__proto__",
      "constructor",
    ];
    for (const key of unknown) {
      expect(classifyRejectedField(key), JSON.stringify(key)).toBeNull();
    }
  });

  it("四个分类的中文理由恰好穷尽，且都不泄露内部码值", () => {
    expect(Object.keys(AI_REJECT_CATEGORY_ZH).sort()).toEqual([...REJECT_CATEGORIES].sort());
    for (const category of REJECT_CATEGORIES) {
      const message = AI_REJECT_CATEGORY_ZH[category];
      expect(message.trim().length).toBeGreaterThan(0);
      expect(message).not.toContain(category.toUpperCase());
    }
  });

  it("拒绝理由面向用户：说明被拒的是什么、应该提交什么", () => {
    expect(AI_REJECT_CATEGORY_ZH.provider_name).toContain("供应商名");
    expect(AI_REJECT_CATEGORY_ZH.model_name).toContain("模型名");
    expect(AI_REJECT_CATEGORY_ZH.evidence_id).toContain("证据");
    expect(AI_REJECT_CATEGORY_ZH.provider_parameter).toContain("供应商参数");
  });
});

/* ---------------------------------------------------------------------------
 * 页面范围地址校验（AC1.9）
 * ------------------------------------------------------------------------- */

describe("页面范围地址校验", () => {
  it.each(PAGE_ADDRESS_ALLOWED_PARAMS)("白名单参数 %s 单独出现即放行", (param) => {
    const value = `/attribution?${param}=${encodeURIComponent(PAGE_ADDRESS_PARAM_VALUES[param])}`;
    expect(validatePageAddress(value), value).toBeNull();
  });

  it("九个白名单参数同时出现仍然放行", () => {
    expect(PAGE_ADDRESS_ALLOWED_PARAMS).toHaveLength(9);
    const query = PAGE_ADDRESS_ALLOWED_PARAMS.map(
      (param) => `${param}=${encodeURIComponent(PAGE_ADDRESS_PARAM_VALUES[param])}`,
    ).join("&");
    expect(validatePageAddress(`/attribution?${query}`)).toBeNull();
  });

  it("无参数的归因页地址放行", () => {
    expect(validatePageAddress("/attribution")).toBeNull();
    expect(validatePageAddress(VALID_PAGE_ADDRESS)).toBeNull();
  });

  // 切片 1b 的 P1 缺陷面：白名单外参数此前被静默忽略，全部返回 200。
  it.each(PAGE_ADDRESS_FORBIDDEN_PARAMS)("白名单外参数 %s 逐个被拒绝", (param) => {
    expect(validatePageAddress(`/attribution?${param}=x`)).toBe(
      `页面范围地址不得携带参数 ${param}。`,
    );
  });

  it("provider / model / evidence_id 走私面即使排在最后也照样拒绝", () => {
    const smuggled = ["provider", "model", "evidence_id", "evidence_snapshot_id", "evidence_scope"];
    for (const param of smuggled) {
      const value = `/attribution?period=2026-08&destination=GB&${param}=x`;
      expect(validatePageAddress(value), param).toBe(`页面范围地址不得携带参数 ${param}。`);
    }
  });

  // 「往白名单里加键」是这条边界的真实失效方向，遍历抄录表抓不到，必须由独立声明来测。
  it.each(PAGE_ADDRESS_SEMANTIC_TRAPS)("语义上易被误加进白名单的参数 %s 一律被拒绝", (param) => {
    expect(validatePageAddress(`/attribution?${param}=x`)).toBe(
      `页面范围地址不得携带参数 ${param}。`,
    );
  });

  it("语义陷阱键与合法键混排时被拒绝的参数逐个点名为真", () => {
    const query = [
      "period=2026-08",
      ...PAGE_ADDRESS_SEMANTIC_TRAPS.slice(0, 6).map((param) => `${param}=x`),
    ].join("&");
    const problem = validatePageAddress(`/attribution?${query}`);
    expect(problem).toBe(`页面范围地址不得携带参数 ${PAGE_ADDRESS_SEMANTIC_TRAPS[0]}。`);
  });

  it("语义陷阱键与白名单完全不相交，且与前一张表重叠时结论一致", () => {
    const traps = new Set<string>(PAGE_ADDRESS_SEMANTIC_TRAPS);
    expect(PAGE_ADDRESS_SEMANTIC_TRAPS).toHaveLength(21);
    expect(new Set(traps).size).toBe(PAGE_ADDRESS_SEMANTIC_TRAPS.length);
    for (const param of PAGE_ADDRESS_ALLOWED_PARAMS) {
      expect(traps.has(param), param).toBe(false);
    }
    // 与「白名单外参数」表允许重叠（如 `locale`）：两张表对同一键必须给出同一句拒绝。
    for (const param of PAGE_ADDRESS_FORBIDDEN_PARAMS) {
      if (!traps.has(param)) continue;
      expect(validatePageAddress(`/attribution?${param}=x`), param).toBe(
        `页面范围地址不得携带参数 ${param}。`,
      );
    }
  });

  // 加键方向的覆盖面**只有** `PAGE_ADDRESS_SEMANTIC_TRAPS` 那 21 个语义键：不在其中的键名
  // （如 `zzz`、`guide2`）往实现侧白名单里加，本文件**测不出来**（已用外部变异实测）。
  // 原因：实现侧的 `AI_PAGE_ADDRESS_ALLOWED_PARAMS` 是 `ai-model.ts` 的模块私有常量，
  // 从未导出也无法导入，因此不存在「断言实现白名单的键数」这种写法——
  // 任何针对 `PAGE_ADDRESS_ALLOWED_PARAMS` 自身长度的断言都是拿抄录表跟自己比，
  // 无论实现怎么改都恒真，故此处刻意不写。缩键方向则由
  // `it.each(PAGE_ADDRESS_ALLOWED_PARAMS)`（逐个放行）兜住：删掉实现里的任何一个键，
  // 对应的放行断言会先于任何计数断言失败。
  it("factor_id 与 factor 不可互换：范围地址只接受 factor", () => {
    expect(validatePageAddress("/attribution?factor_id=MIX")).toBe(
      "页面范围地址不得携带参数 factor_id。",
    );
    expect(validatePageAddress("/attribution?factor=MIX")).toBeNull();
  });

  it("越界键后面再跟一个合法键也不会被放行", () => {
    expect(validatePageAddress("/attribution?model=gpt&period=2026-08")).toBe(
      "页面范围地址不得携带参数 model。",
    );
  });

  it("重复键一律拒绝，即使两个取值完全相同", () => {
    expect(validatePageAddress("/attribution?period=2026-08&period=2026-08")).toBe(
      "页面范围地址不得重复携带参数 period。",
    );
    expect(validatePageAddress("/attribution?destination=GB&destination=US")).toBe(
      "页面范围地址不得重复携带参数 destination。",
    );
    expect(validatePageAddress("/attribution?period=2026-08&period=2026-09&destination=GB")).toBe(
      "页面范围地址不得重复携带参数 period。",
    );
  });

  it("白名单判定先于重复键判定，越界键不会被重复键理由掩盖", () => {
    expect(validatePageAddress("/attribution?provider=a&provider=b")).toBe(
      "页面范围地址不得携带参数 provider。",
    );
  });

  it("协议相对地址与缺失前导斜杠的地址一律拒绝", () => {
    const rejectedValues = [
      "//evil.example/attribution",
      "//evil.example/attribution?period=2026-08",
      "//127.0.0.1/attribution",
      "attribution",
      "attribution?period=2026-08",
    ];
    for (const value of rejectedValues) {
      expect(validatePageAddress(value), value).toBe("页面范围地址必须是站内相对地址。");
    }
  });

  it("反斜杠伪装的跨站地址被同源判定拦下", () => {
    // `/\/evil.example` 不以 `//` 开头，但 WHATWG URL 把反斜杠当斜杠，解析结果是跨站地址。
    const disguised = "/\\/evil.example";
    expect(disguised.startsWith("/")).toBe(true);
    expect(disguised.startsWith("//")).toBe(false);
    expect(validatePageAddress(disguised)).toBe("页面范围地址必须是站内相对地址。");
  });

  it("绝对地址即便路径正确也拒绝", () => {
    const absolute = [
      "http://127.0.0.1/attribution",
      "https://127.0.0.1/attribution",
      "http://evil.example/attribution",
    ];
    for (const value of absolute) {
      expect(validatePageAddress(value), value).toBe("页面范围地址必须是站内相对地址。");
    }
  });

  it.each([
    "/",
    "/attribution/",
    "/attribution/extra",
    "/ATTRIBUTION",
    "/attributions",
    "/dashboard",
  ])("非归因页路径 %s 被拒绝", (value) => {
    expect(validatePageAddress(value)).toBe(
      "当前只受理英国归因页（/attribution）范围内的管理分析请求。",
    );
  });

  it("目的国只受理英国：GB 放行，任何其它取值拒绝", () => {
    expect(validatePageAddress("/attribution?destination=GB")).toBeNull();
    const rejectedDestinations = ["US", "gb", "Gb", "GB,US", "", "CN", "G B"];
    for (const destination of rejectedDestinations) {
      const value = `/attribution?destination=${encodeURIComponent(destination)}`;
      expect(validatePageAddress(value), value).toBe("当前只受理目的国为英国的归因范围。");
    }
  });

  it("长度边界：2048 放行，2049 与空串拒绝", () => {
    const prefix = "/attribution?period=";
    const atLimit = `${prefix}${"a".repeat(AI_PAGE_ADDRESS_MAX_LENGTH - prefix.length)}`;
    expect(atLimit).toHaveLength(AI_PAGE_ADDRESS_MAX_LENGTH);
    expect(validatePageAddress(atLimit)).toBeNull();
    expect(validatePageAddress(`${atLimit}a`)).toBe("页面范围地址为空或过长。");
    expect(validatePageAddress("")).toBe("页面范围地址为空或过长。");
  });

  it("目的国判定在参数白名单之后，白名单键拼写错误不会漏过目的国检查", () => {
    expect(validatePageAddress("/attribution?destinations=GB")).toBe(
      "页面范围地址不得携带参数 destinations。",
    );
  });

  it("空查询串（裸问号、裸与号）不产生任何参数，因此放行", () => {
    for (const suffix of ["?", "?#", "?&&"]) {
      expect(validatePageAddress(`/attribution${suffix}`), suffix).toBeNull();
    }
    // 裸 `&` 不带 `?`，因此它属于路径而不是查询串。
    expect(validatePageAddress("/attribution&")).toBe(
      "当前只受理英国归因页（/attribution）范围内的管理分析请求。",
    );
  });

  it("裸等号产生一个空键名，空键同样不在白名单内", () => {
    // `URLSearchParams` 会把 `=` 解析成键名空、值为空的参数；白名单按键判定，故被拒绝。
    expect(validatePageAddress("/attribution?=")).toBe("页面范围地址不得携带参数 。");
  });

  it("查询串里的每个键都被逐个判定，不存在只看首键的路径", () => {
    expect(validatePageAddress("/attribution?period=2026-08&b=1")).toBe(
      "页面范围地址不得携带参数 b。",
    );
    expect(validatePageAddress("/attribution?a=1&period=2026-08")).toBe(
      "页面范围地址不得携带参数 a。",
    );
  });

  it("反斜杠空主机形态触发解析失败分支，返回受控中文原因而不是抛出", () => {
    // 值以单个 `/` 开头且第 2 字符是 `\` 时，WHATWG 会提升为 authority 前缀；`//` 被
    // `startsWith("//")` 挡下，但 `/\` 不被挡，而 special scheme 下空主机非法，
    // 因此 `new URL(value, base)` 抛 `TypeError` 并落到「无法解析」这条受控拒绝上。
    // `ai-model.ts:468` 的死三元是全文件唯一不可覆盖的分支，本处必须覆盖到 240 行。
    const emptyHost = ["/\\", "/\\\\", "/\\?", "/\\#"];
    for (const value of emptyHost) {
      expect(value.startsWith("/"), JSON.stringify(value)).toBe(true);
      expect(value.startsWith("//"), JSON.stringify(value)).toBe(false);
      expect(validatePageAddress(value), JSON.stringify(value)).toBe("页面范围地址无法解析。");
    }
    // 反斜杠 + 有主机形态则不抛，而是被同源判定拦下——两条分支都必须被覆盖。
    expect(validatePageAddress("/\\/evil.example")).toBe("页面范围地址必须是站内相对地址。");
  });

  it("对抗性输入永不抛出异常，一律返回受控中文原因或 null", () => {
    const adversarial = [
      "/%",
      "/%zz",
      "/attribution?period=%E4%B8",
      "/attribution?period",
      "/attribution?%%%",
      "/../attribution",
      "/attribution/../../attribution",
      "/attribution?destination=%00",
      "/attribution\n",
      "\t/attribution",
      "/attribution?path=../../etc/passwd",
      "http://",
      "://attribution",
      "//////",
      "/attribution?period=2026-08&period=%FF",
      "/\\",
      "/\\\\",
      "/\\?",
      "/\\#",
    ];
    for (const value of adversarial) {
      const outcome = validatePageAddress(value);
      if (outcome !== null) {
        expect(typeof outcome, value).toBe("string");
        expect(outcome.trim().length, value).toBeGreaterThan(0);
        expect(outcome, value).not.toContain("undefined");
        expect(outcome, value).not.toMatch(/[A-Z]{3,}_/u);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * 请求体解析（AC1.9 / AC1.10）
 * ------------------------------------------------------------------------- */

describe("请求体解析", () => {
  it("合法请求被接受：问题按 trim 后的值返回，地址逐字保留", () => {
    const parsed = accepted({
      question: "  英国本月履约变动成本为何上升？  ",
      page_address: VALID_PAGE_ADDRESS,
    });
    expect(parsed.question).toBe("英国本月履约变动成本为何上升？");
    expect(parsed.pageAddress).toBe(VALID_PAGE_ADDRESS);
  });

  it.each([
    ["null", null],
    ["字符串", "question"],
    ["数字", 42],
    ["布尔", true],
    ["未定义", undefined],
    ["数组", ["question"]],
    ["空数组", []],
  ])("非 JSON 对象的请求体（%s）判为 malformed", (_label, body) => {
    const parsed = rejected(body);
    expect(parsed.category).toBe("malformed");
    expect(parsed.message_zh).toBe(
      "请求体必须是 JSON 对象，且只包含 question 与 page_address 两个字段。",
    );
  });

  it.each(REJECT_CATEGORIES)("越界提交按 %s 分类拒绝，且拿到该分类自己的中文状态", (category) => {
    const field = REJECTED_FIELDS.find(([, mapped]) => mapped === category)?.[0];
    expect(field, category).toBeDefined();
    if (field === undefined) return;
    const parsed = rejected({
      question: "问题",
      page_address: VALID_PAGE_ADDRESS,
      [field]: "x",
    });
    expect(parsed.category).toBe(category);
    expect(parsed.message_zh).toBe(AI_REJECT_CATEGORY_ZH[category]);
  });

  it("白名单外的未知键判为 unknown_field，且理由不点名具体键", () => {
    for (const key of ["locale", "tab", "questions", "Question"]) {
      const parsed = rejected({ question: "问题", page_address: VALID_PAGE_ADDRESS, [key]: "x" });
      expect(parsed.category, key).toBe("unknown_field");
      expect(parsed.message_zh).toBe(
        "请求体包含不被接受的字段，请只提交 question 与 page_address。",
      );
    }
  });

  it("缺字段或字段类型不对判为 malformed", () => {
    const bodies: readonly unknown[] = [
      {},
      { question: "问题" },
      { page_address: VALID_PAGE_ADDRESS },
      { question: 1, page_address: VALID_PAGE_ADDRESS },
      { question: "问题", page_address: 202608 },
      { question: null, page_address: VALID_PAGE_ADDRESS },
      { question: ["问题"], page_address: VALID_PAGE_ADDRESS },
      { question: { text: "问题" }, page_address: VALID_PAGE_ADDRESS },
      { question: "问题", page_address: null },
    ];
    for (const body of bodies) {
      const parsed = rejected(body);
      expect(parsed.category, JSON.stringify(body)).toBe("malformed");
      expect(parsed.message_zh, JSON.stringify(body)).toBe(
        "请求体必须是 JSON 对象，且只包含 question 与 page_address 两个字段。",
      );
    }
  });

  it("空白问题给出专用的受控理由，而不是通用的 malformed 理由", () => {
    for (const question of ["", " ", "\t", "\n", "   \t\n  "]) {
      const parsed = rejected({ question, page_address: VALID_PAGE_ADDRESS });
      expect(parsed.category, JSON.stringify(question)).toBe("malformed");
      expect(parsed.message_zh, JSON.stringify(question)).toBe("问题不得为空字符串或全为空白。");
    }
  });

  it("500 码点放行、501 码点拒绝，拒绝理由点明上限与「未调用任何模型」", () => {
    const atLimit = "问".repeat(AI_QUESTION_MAX_CODE_POINTS);
    expect(accepted({ question: atLimit, page_address: "/attribution" }).question).toBe(atLimit);
    const parsed = rejected({
      question: "问".repeat(AI_QUESTION_MAX_CODE_POINTS + 1),
      page_address: "/attribution",
    });
    expect(parsed.category).toBe("malformed");
    expect(parsed.message_zh).toBe(
      `问题长度超过 ${AI_QUESTION_MAX_CODE_POINTS} 个字符上限，已被拒绝，未调用任何模型。`,
    );
  });

  it("长度按 Unicode 码点计而非 UTF-16 单元：非 BMP 字符不被多算", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);
    expect([...emoji].length).toBe(1);

    // 251 个 emoji 的 UTF-16 长度已越过上限，码点数却只有 251，必须放行。
    const discriminates = emoji.repeat(251);
    expect(discriminates.length).toBe(502);
    expect([...discriminates].length).toBe(251);
    expect(accepted({ question: discriminates, page_address: "/attribution" }).question).toBe(
      discriminates,
    );

    // 500 个 emoji 的 UTF-16 长度是上限的两倍，码点数正好落在上限上。
    const atLimit = emoji.repeat(AI_QUESTION_MAX_CODE_POINTS);
    expect(atLimit.length).toBe(1_000);
    expect([...atLimit].length).toBe(AI_QUESTION_MAX_CODE_POINTS);
    expect(accepted({ question: atLimit, page_address: "/attribution" }).question).toBe(atLimit);

    expect(rejected({ question: emoji.repeat(501), page_address: "/attribution" }).category).toBe(
      "malformed",
    );

    // 混合串：499 个 BMP 字符 + 1 个非 BMP 字符 = 500 码点、501 个 UTF-16 单元。
    const mixed = `${"问".repeat(499)}${emoji}`;
    expect(mixed.length).toBe(501);
    expect([...mixed].length).toBe(500);
    expect(accepted({ question: mixed, page_address: "/attribution" }).question).toBe(mixed);
  });

  it("长度在 trim 之前计量，因此首尾空白也计入上限", () => {
    const padded = `  ${"问".repeat(AI_QUESTION_MAX_CODE_POINTS)}  `;
    expect(padded.length).toBe(AI_QUESTION_MAX_CODE_POINTS + 4);
    expect(rejected({ question: padded, page_address: "/attribution" }).message_zh).toContain(
      "长度超过",
    );
  });

  it("问题超限时先报长度，页面范围地址即使同时非法也不先报地址", () => {
    const parsed = rejected({
      question: "问".repeat(AI_QUESTION_MAX_CODE_POINTS + 1),
      page_address: "/dashboard",
    });
    expect(parsed.message_zh).toContain("长度超过");
  });

  it("页面范围地址不合法时透传地址校验的中文理由", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["/dashboard", "当前只受理英国归因页（/attribution）范围内的管理分析请求。"],
      ["//evil.example/attribution", "页面范围地址必须是站内相对地址。"],
      ["/attribution?provider=x", "页面范围地址不得携带参数 provider。"],
      ["/attribution?model=x", "页面范围地址不得携带参数 model。"],
      ["/attribution?evidence_id=E01-country", "页面范围地址不得携带参数 evidence_id。"],
      ["/attribution?evidence_snapshot_id=ES-x", "页面范围地址不得携带参数 evidence_snapshot_id。"],
      ["/attribution?destination=US", "当前只受理目的国为英国的归因范围。"],
      ["/attribution?period=a&period=b", "页面范围地址不得重复携带参数 period。"],
      ["", "页面范围地址为空或过长。"],
    ];
    for (const [pageAddress, message] of cases) {
      const parsed = rejected({ question: "问题", page_address: pageAddress });
      expect(parsed.category, pageAddress).toBe("malformed");
      expect(parsed.message_zh, pageAddress).toBe(message);
    }
  });

  it("判定顺序固定：越界分类先于未知键，未知键先于字段类型，空白问题先于地址", () => {
    expect(rejected({ provider: "x", locale: "zh" }).category).toBe("provider_name");
    expect(rejected({ evidence_id: "x", tab: "a" }).category).toBe("evidence_id");
    expect(
      rejected({ question: "问题", page_address: "/attribution", locale: "zh" }).category,
    ).toBe("unknown_field");
    expect(rejected({ question: 42, page_address: 202608, locale: "zh" }).category).toBe(
      "unknown_field",
    );
    expect(rejected({ question: "   ", page_address: "/dashboard" }).message_zh).toBe(
      "问题不得为空字符串或全为空白。",
    );
  });

  it("拒绝结果永远带受控中文理由，绝不泄露内部码值或原始键名", () => {
    const bodies: readonly unknown[] = [
      { provider: "x" },
      { question: "问题", page_address: "/attribution", locale: "zh" },
      { question: "问题", page_address: "/attribution?api_key=k" },
      null,
      [],
      { question: "问".repeat(501), page_address: "/attribution" },
    ];
    for (const body of bodies) {
      const parsed = rejected(body);
      expect(parsed.ok).toBe(false);
      expect(parsed.message_zh.trim().length).toBeGreaterThan(0);
      expect(parsed.message_zh).not.toMatch(/[A-Z]{3,}_/u);
      expect(parsed.message_zh).not.toContain("undefined");
      expect(parsed.message_zh).not.toContain("null");
    }
  });
});

/* ---------------------------------------------------------------------------
 * 受控中文状态与穷尽映射（AC1.8）
 * ------------------------------------------------------------------------- */

describe("受控中文状态与穷尽映射", () => {
  it("答案类型映射恰好覆盖契约枚举的全部取值", () => {
    expect(aiAnswerTypeSchema.options).toHaveLength(2);
    expect(Object.keys(ANSWER_TYPE_ZH).sort()).toEqual([...aiAnswerTypeSchema.options].sort());
    for (const answerType of aiAnswerTypeSchema.options) {
      const label = ANSWER_TYPE_ZH[answerType];
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toBe(answerType);
      expect(label).not.toMatch(/[A-Z]{3,}_/u);
    }
  });

  it("答案类型映射把「未调用任何模型」写成用户可读的中文", () => {
    expect(ANSWER_TYPE_ZH).toEqual({
      FIXED_EXAMPLE: "固定示例 · 未调用任何模型",
      LIVE_GENERATED: "真实模型生成",
    });
  });

  it("状态码枚举恰好是五个取值，顺序也被冻结", () => {
    expect([...AI_RESPOND_STATUS_CODES]).toEqual([
      "FIXED_EXAMPLE",
      "LIVE_GENERATED",
      "INPUT_REJECTED",
      "EVIDENCE_WHITELIST_VIOLATION",
      "DETERMINISTIC_SOURCE_UNAVAILABLE",
    ]);
  });

  it("状态码映射恰好覆盖状态码枚举，逐条非空且不泄露内部码值", () => {
    expect(Object.keys(AI_RESPOND_STATUS_ZH).sort()).toEqual([...AI_RESPOND_STATUS_CODES].sort());
    for (const code of AI_RESPOND_STATUS_CODES) {
      const label = AI_RESPOND_STATUS_ZH[code];
      expect(label.trim().length, code).toBeGreaterThan(0);
      expect(label, code).not.toBe(code);
      expect(label, code).not.toContain(code);
      expect(label, code).not.toMatch(/[A-Z]{3,}_/u);
    }
  });

  it("固定与实时状态复用答案类型文案，网关错误复用既有单一真相源", () => {
    const gatewayStatus: Readonly<Record<string, string>> = GATEWAY_ERROR_STATUS_ZH;
    expect(AI_RESPOND_STATUS_ZH.FIXED_EXAMPLE).toBe(ANSWER_TYPE_ZH.FIXED_EXAMPLE);
    expect(AI_RESPOND_STATUS_ZH.LIVE_GENERATED).toBe(ANSWER_TYPE_ZH.LIVE_GENERATED);
    expect(AI_RESPOND_STATUS_ZH.INPUT_REJECTED).toBe(GATEWAY_ERROR_STATUS_ZH.INPUT_REJECTED);
    expect(AI_RESPOND_STATUS_ZH.EVIDENCE_WHITELIST_VIOLATION).toBe(
      GATEWAY_ERROR_STATUS_ZH.EVIDENCE_WHITELIST_VIOLATION,
    );
    expect(AI_RESPOND_STATUS_ZH.DETERMINISTIC_SOURCE_UNAVAILABLE).toContain("确定性查询");
    expect(gatewayStatus.DETERMINISTIC_SOURCE_UNAVAILABLE).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * 证据白名单组装（AC1.1 的范围锚定）
 * ------------------------------------------------------------------------- */

describe("证据白名单组装", () => {
  it("四个结果族的证据按 country → bridge → diagnostics → drilldown 顺序汇总", () => {
    const whitelist = buildEvidenceWhitelist(ATTRIBUTION_DATA);
    const idsOf = (family: AiEvidenceFamily) =>
      FIXED_EXAMPLE_EVIDENCE_IDS.filter((id) => familyOfEvidenceId(id) === family);
    expect(whitelist.entries.map((entry) => entry.evidence_id)).toEqual([
      ...idsOf("country"),
      ...idsOf("bridge"),
      ...idsOf("diagnostics"),
      ...idsOf("drilldown"),
    ]);
    expect(whitelist.duplicated).toEqual([]);
  });

  it("证据族恰好是归因页检索的四个族，逐族标签是非空且互不相同的中文", () => {
    expect([...AI_EVIDENCE_FAMILIES]).toEqual(["country", "bridge", "diagnostics", "drilldown"]);
    const whitelist = buildEvidenceWhitelist(ATTRIBUTION_DATA);
    expect([...new Set(whitelist.entries.map((entry) => entry.family))].sort()).toEqual(
      [...AI_EVIDENCE_FAMILIES].sort(),
    );
    for (const family of AI_EVIDENCE_FAMILIES) {
      const labels = whitelist.entries
        .filter((entry) => entry.family === family)
        .map((entry) => entry.family_label_zh);
      expect(labels.length, family).toBeGreaterThan(0);
      expect(new Set(labels), family).toEqual(new Set([FAMILY_LABELS_ZH[family]]));
      expect(FAMILY_LABELS_ZH[family], family).not.toBe(family);
    }
    expect(new Set(Object.values(FAMILY_LABELS_ZH)).size).toBe(AI_EVIDENCE_FAMILIES.length);
  });

  it("每个条目都带服务端真实快照 ID 与证据自身所属的查询范围", () => {
    const whitelist = buildEvidenceWhitelist(ATTRIBUTION_DATA);
    for (const entry of whitelist.entries) {
      expect(entry.evidence_snapshot_id, entry.evidence_id).toBe(FAMILY_SNAPSHOT_IDS[entry.family]);
      expect(entry.evidence_snapshot_id.startsWith("SNAPSHOT_GB_"), entry.evidence_id).toBe(false);
      // 等值断言而非「非空」：`label_zh` 必须逐字取 `metric`，`value` / `unit` 必须逐字取
      // 证据对象同名字段。任何串字段（改用 `unit`、改大写、改硬编码）都必须让本测试变红。
      expect(entry.label_zh, entry.evidence_id).toBe(EVIDENCE_METRIC_ZH);
      expect(entry.value, entry.evidence_id).toBe(EVIDENCE_VALUE);
      expect(entry.unit, entry.evidence_id).toBe(EVIDENCE_UNIT);
      expect(entry.scope.period, entry.evidence_id).toEqual({
        from: "2026-08",
        to: "2026-08",
        grain: "MONTH",
      });
    }
  });

  it("白名单条目逐字复制证据对象的展示字段，不做任何派生或改写", () => {
    const source = ATTRIBUTION_DATA.country.evidence[0];
    expect(source).toBeDefined();
    if (source === undefined) return;
    const entry = buildEvidenceWhitelist(ATTRIBUTION_DATA).entries.find(
      (item) => item.evidence_id === source.evidence_id,
    );
    expect(entry).toBeDefined();
    expect(entry?.label_zh).toBe(source.metric);
    expect(entry?.value).toBe(source.value);
    expect(entry?.unit).toBe(source.unit);
    expect(entry?.label_zh).not.toBe(entry?.unit);
    expect(entry?.value).not.toBe("0.0000");
  });

  it("含大小写敏感 ASCII 的 metric 也逐字保留，挡住大小写改写", () => {
    const id = "E-ascii-metric";
    const whitelist = buildEvidenceWhitelist(
      attributionDataOf({
        extraCountry: [
          evidenceObject(id, { snapshotId: "ES-ascii", metric: EVIDENCE_METRIC_WITH_CASE }),
        ],
      }),
    );
    const entry = whitelist.entries.find((item) => item.evidence_id === id);
    expect(entry).toBeDefined();
    expect(entry?.label_zh).toBe(EVIDENCE_METRIC_WITH_CASE);
    expect(entry?.label_zh).not.toBe(EVIDENCE_METRIC_WITH_CASE.toUpperCase());
    expect(entry?.label_zh).not.toBe(EVIDENCE_METRIC_WITH_CASE.toLowerCase());
    // 顺带确认它没被换算成别的字段。
    expect(entry?.label_zh).not.toBe(EVIDENCE_UNIT);
    expect(entry?.label_zh).not.toBe(EVIDENCE_METRIC_ZH);
  });

  it("范围逐条锚定在各自结果的 query_intent 上，而不是一个全局常量", () => {
    const scopeOf = (
      whitelist: AiEvidenceWhitelist,
      family: AiEvidenceFamily,
    ): AnalysisScope | undefined =>
      whitelist.entries.find((entry) => entry.family === family)?.scope;

    const plain = buildEvidenceWhitelist(attributionDataOf());
    const withFactor = buildEvidenceWhitelist(attributionDataOf({ factor: "MIX" }));

    // country / bridge / diagnostics 共用同一范围（无因素下钻）。
    expect(scopeOf(plain, "bridge")).toEqual(scopeOf(plain, "country"));
    expect(scopeOf(plain, "diagnostics")).toEqual(scopeOf(plain, "country"));
    expect(scopeOf(plain, "country")?.destination_country_ids).toEqual(["GB"]);
    // drilldown 的范围自带 factor_id，并随页面因素变化。
    expect(scopeOf(plain, "drilldown")?.factor_id).toBeUndefined();
    expect(scopeOf(withFactor, "drilldown")?.factor_id).toBe("MIX");
    expect(scopeOf(withFactor, "drilldown")).not.toEqual(scopeOf(withFactor, "country"));
  });

  it("没有真实快照 ID 的证据对象不进白名单（宁缺勿凑）", () => {
    const naked = evidenceObject("E-naked-evidence");
    expect(naked.evidence_snapshot_id).toBeUndefined();
    const whitelist = buildEvidenceWhitelist(
      attributionDataOf({
        naked: [naked],
        extraCountry: [evidenceObject("E-bound", { snapshotId: "ES-bound" })],
      }),
    );
    const ids = whitelist.entries.map((entry) => entry.evidence_id);
    expect(ids).not.toContain("E-naked-evidence");
    expect(ids).toContain("E-bound");
    expect(whitelist.duplicated).toEqual([]);
  });

  it("快照 ID 存在的证据一条不丢，且 ID 本身不重复", () => {
    const whitelist = buildEvidenceWhitelist(ATTRIBUTION_DATA);
    const total = [
      ATTRIBUTION_DATA.country.evidence.length,
      ATTRIBUTION_DATA.bridge.evidence.length,
      ATTRIBUTION_DATA.diagnostics.evidence.length,
      ATTRIBUTION_DATA.drilldown.evidence.length,
    ].reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThan(0);
    expect(whitelist.entries).toHaveLength(total);
    expect(new Set(whitelist.entries.map((entry) => entry.evidence_id)).size).toBe(total);
  });

  it("同族重复与跨族重复的证据 ID 都进 duplicated，不静默去重", () => {
    const withinFamily = buildEvidenceWhitelist(
      attributionDataOf({
        extraCountry: [evidenceObject(PRIMARY_EVIDENCE_ID, { snapshotId: "ES-second" })],
      }),
    );
    expect(
      withinFamily.entries.filter((entry) => entry.evidence_id === PRIMARY_EVIDENCE_ID),
    ).toHaveLength(2);
    expect(withinFamily.duplicated).toEqual([PRIMARY_EVIDENCE_ID]);

    const acrossFamilies = buildEvidenceWhitelist(
      attributionDataOf({
        extraCountry: [evidenceObject("ATTRIBUTION_BRIDGE:FX", { snapshotId: "ES-cross-family" })],
      }),
    );
    expect(
      acrossFamilies.entries.filter((entry) => entry.evidence_id === "ATTRIBUTION_BRIDGE:FX"),
    ).toHaveLength(2);
    expect(acrossFamilies.duplicated).toEqual(["ATTRIBUTION_BRIDGE:FX"]);
  });

  it("多个重复 ID 逐个报出，不截断", () => {
    const whitelist = buildEvidenceWhitelist(
      attributionDataOf({
        extraCountry: [
          evidenceObject(PRIMARY_EVIDENCE_ID, { snapshotId: "ES-a" }),
          evidenceObject("E05-bridge", { snapshotId: "ES-b" }),
          evidenceObject("E05-bridge", { snapshotId: "ES-c" }),
        ],
      }),
    );
    expect(whitelist.duplicated).toEqual([PRIMARY_EVIDENCE_ID, "E05-bridge"]);
  });

  it("四个结果族都没有证据时得到空白名单而不是异常", () => {
    const empty: AttributionData = {
      country: { ...ATTRIBUTION_DATA.country, evidence: [] },
      bridge: { ...ATTRIBUTION_DATA.bridge, evidence: [] },
      diagnostics: { ...ATTRIBUTION_DATA.diagnostics, evidence: [] },
      drilldown: { ...ATTRIBUTION_DATA.drilldown, evidence: [] },
    };
    expect(buildEvidenceWhitelist(empty)).toEqual({ entries: [], duplicated: [] });
  });
});

/* ---------------------------------------------------------------------------
 * 回答引用证据的收集
 * ------------------------------------------------------------------------- */

describe("回答引用证据的收集", () => {
  it("分析夹具本身必须通过公共契约，否则后续断言失去意义", () => {
    expect(
      managementAnalysisSchema.safeParse(
        analysisWithEvidence({ conclusion: ["E01-country"], recommendations: [["E01-country"]] }),
      ).success,
    ).toBe(true);
  });

  it("按首次出现顺序跨四个区块与建议去重", () => {
    const analysis = analysisWithEvidence({
      conclusion: ["E01-country", "E05-bridge"],
      evidence: ["E05-bridge", "DIAGNOSTIC_METRICS:AIR_SHARE:CURRENT"],
      impact: ["E01-country"],
      limitations: ["ATTRIBUTION_DRILLDOWN:FC:DE_FC"],
      recommendations: [["E05-bridge"], ["DIAGNOSTIC_METRICS:AIR_SHARE:CURRENT", "E05-bridge"]],
    });
    expect(collectAnswerEvidenceIds(analysis)).toEqual([
      "E01-country",
      "E05-bridge",
      "DIAGNOSTIC_METRICS:AIR_SHARE:CURRENT",
      "ATTRIBUTION_DRILLDOWN:FC:DE_FC",
    ]);
  });

  it("五个区块都没有引用时返回空数组", () => {
    expect(collectAnswerEvidenceIds(analysisWithEvidence({ recommendations: [[]] }))).toEqual([]);
  });

  it("建议区块的证据排在四个正文区块之后", () => {
    const analysis = analysisWithEvidence({
      limitations: ["E-late"],
      recommendations: [["E-recommendation"]],
    });
    expect(collectAnswerEvidenceIds(analysis)).toEqual(["E-late", "E-recommendation"]);
  });

  it("固定示例引用的每条证据 ID 恰好被收集一次，且主证据排在首位", () => {
    expect(PRIMARY_EVIDENCE_ID).toBe("E01-country");
    const ids = collectAnswerEvidenceIds(buildFixedExampleAnalysis());
    expect(ids).toHaveLength(FIXED_EXAMPLE_EVIDENCE_IDS.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(PRIMARY_EVIDENCE_ID);
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });
});

/* ---------------------------------------------------------------------------
 * 回答与真实快照的绑定（R2 / 交接要点 3）
 * ------------------------------------------------------------------------- */

describe("回答与真实快照的绑定", () => {
  const WHITELIST = buildEvidenceWhitelist(ATTRIBUTION_DATA);

  it("绑定成功：占位快照 ID 集合被替换为全部引用的真实快照 ID，去重并稳定排序", () => {
    expect(PLACEHOLDER_SNAPSHOT_IDS).toEqual(["SNAPSHOT_GB_2026_08_V1"]);
    const binding = boundOrThrow(buildFixedExampleAnalysis(), WHITELIST);
    const expectedSnapshotIds = Object.values(FAMILY_SNAPSHOT_IDS).sort();
    expect(binding.evidence_snapshot_ids).toEqual(expectedSnapshotIds);
    expect(binding.analysis.evidence_snapshot_ids).toEqual(expectedSnapshotIds);
    expect(binding.analysis.evidence_snapshot_ids).not.toEqual(PLACEHOLDER_SNAPSHOT_IDS);
    expect(managementAnalysisSchema.safeParse(binding.analysis).success).toBe(true);
  });

  it("绑定成功：cited 是白名单索引视图，按引用顺序去重且每条都带真实快照 ID", () => {
    const binding = boundOrThrow(buildFixedExampleAnalysis(), WHITELIST);
    expect(binding.cited.map((entry) => entry.evidence_id)).toEqual(FIXED_EXAMPLE_EVIDENCE_IDS);
    expect(new Set(binding.cited.map((entry) => entry.evidence_id)).size).toBe(
      binding.cited.length,
    );
    for (const entry of binding.cited) {
      expect(entry.evidence_snapshot_id, entry.evidence_id).toBe(FAMILY_SNAPSHOT_IDS[entry.family]);
      expect(entry.scope.period.grain, entry.evidence_id).toBe("MONTH");
    }
  });

  it("绑定成功：白名单索引是按证据 ID 可查的映射", () => {
    const binding = boundOrThrow(buildFixedExampleAnalysis(), WHITELIST);
    expect(binding.whitelist).toBeInstanceOf(Map);
    expect(binding.whitelist.size).toBe(WHITELIST.entries.length);
    expect(binding.whitelist.get(PRIMARY_EVIDENCE_ID)?.evidence_snapshot_id).toBe(
      FAMILY_SNAPSHOT_IDS.country,
    );
    expect(binding.whitelist.has("NOT-IN-WHITELIST")).toBe(false);
  });

  it("绑定成功：分析里的每一条引用都能在白名单索引中查到", () => {
    const binding = boundOrThrow(buildFixedExampleAnalysis(), WHITELIST);
    for (const id of collectAnswerEvidenceIds(binding.analysis)) {
      expect(binding.whitelist.has(id), id).toBe(true);
    }
  });

  it("引用的证据不在白名单内即整体失败关闭，并逐条报出缺失 ID", () => {
    const binding = bindAnswerToRealSnapshot(
      analysisWithEvidence({
        conclusion: [PRIMARY_EVIDENCE_ID, "NOT-IN-WHITELIST"],
        evidence: ["ALSO-MISSING"],
      }),
      WHITELIST,
    );
    expect(binding.ok).toBe(false);
    if (binding.ok) return;
    expect(binding.missing).toEqual(["NOT-IN-WHITELIST", "ALSO-MISSING"]);
  });

  it("白名单存在重复证据 ID 时同样失败关闭，且此时 missing 为空数组", () => {
    const duplicated = buildEvidenceWhitelist(
      attributionDataOf({
        extraCountry: [evidenceObject(PRIMARY_EVIDENCE_ID, { snapshotId: "ES-second" })],
      }),
    );
    expect(duplicated.duplicated).toEqual([PRIMARY_EVIDENCE_ID]);
    const binding = bindAnswerToRealSnapshot(
      analysisWithEvidence({ conclusion: [PRIMARY_EVIDENCE_ID] }),
      duplicated,
    );
    expect(binding.ok).toBe(false);
    if (binding.ok) return;
    // 重复不是「缺失」，因此失败关闭的依据是 duplicated，missing 保持为空。
    expect(binding.missing).toEqual([]);
  });

  it("只引用单个族时只绑定该族快照，不要求旧主证据存在", () => {
    const binding = boundOrThrow(
      analysisWithEvidence({ conclusion: ["ATTRIBUTION_BRIDGE:FX"] }),
      whitelistOf([entryOf("ATTRIBUTION_BRIDGE:FX", { family: "bridge" })]),
    );
    expect(binding.evidence_snapshot_ids).toEqual([FAMILY_SNAPSHOT_IDS.bridge]);
    expect(binding.analysis.evidence_snapshot_ids).toEqual([FAMILY_SNAPSHOT_IDS.bridge]);
  });

  it("回答违反公共契约时以契约哨兵失败关闭，而不是原样下发", () => {
    const base = analysisWithEvidence({ conclusion: [PRIMARY_EVIDENCE_ID] });
    // 经由变量而非内联字面量传入，以避开 TypeScript 的多余属性检查：本例要验证的是
    // `managementAnalysisSchema` 的 `.strict()` 会拒绝契约外字段。
    const conclusionWithExtraKey = { ...base.conclusion, adapter: "ADAPTER_A" };
    const invalidAnalyses: readonly (readonly [string, ManagementAnalysis])[] = [
      ["建议为空", { ...base, recommendations: [] }],
      ["评估题 ID 越界", { ...base, evaluation_question_ids: ["E21"] }],
      ["区块文本为空白", { ...base, conclusion: { ...base.conclusion, text: "   " } }],
      ["区块携带契约外字段", { ...base, conclusion: conclusionWithExtraKey }],
      ["答案类型越界", { ...base, answer_type: "STREAMED" as ManagementAnalysis["answer_type"] }],
    ];
    for (const [label, analysis] of invalidAnalyses) {
      expect(managementAnalysisSchema.safeParse(analysis).success, label).toBe(false);
      const binding = bindAnswerToRealSnapshot(analysis, WHITELIST);
      expect(binding.ok, label).toBe(false);
      if (binding.ok) continue;
      expect(binding.missing, label).toEqual(["__contract__"]);
    }
  });

  it("缺失引用的判定先于契约校验，两类问题同时存在时报缺失", () => {
    const binding = bindAnswerToRealSnapshot(
      { ...analysisWithEvidence({ conclusion: ["NOT-IN-WHITELIST"] }), recommendations: [] },
      WHITELIST,
    );
    expect(binding.ok).toBe(false);
    if (binding.ok) return;
    expect(binding.missing).toEqual(["NOT-IN-WHITELIST"]);
  });

  it("成功绑定不修改传入的原始回答对象", () => {
    const original = buildFixedExampleAnalysis();
    const before = [...original.evidence_snapshot_ids];
    boundOrThrow(original, WHITELIST);
    expect(original.evidence_snapshot_ids).toEqual(before);
  });

  it("空白名单一定失败关闭，不会返回空的 cited", () => {
    const binding = bindAnswerToRealSnapshot(buildFixedExampleAnalysis(), {
      entries: [],
      duplicated: [],
    });
    expect(binding.ok).toBe(false);
    if (binding.ok) return;
    expect(binding.missing.length).toBeGreaterThan(0);
  });
});

describe("回答快照种子的失败关闭", () => {
  it("引用条目缺少快照 ID 时不生成部分种子", () => {
    const malformed = {
      ...entryOf(PRIMARY_EVIDENCE_ID),
      evidence_snapshot_id: undefined,
    } as unknown as AiEvidenceEntry;
    expect(buildAnswerSnapshotSeeds([malformed], ATTRIBUTION_DATA)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 页面范围地址与证据地址的生成（D-174：证据 ID 不得由浏览器提交）
 * ------------------------------------------------------------------------- */

describe("页面范围地址的生成", () => {
  it("证据地址参数恰好是三个，剥除后保留归因页自身的范围参数", () => {
    expect([...EVIDENCE_ADDRESS_PARAMETERS]).toEqual([
      "evidence_id",
      "evidence_snapshot_id",
      "evidence_scope",
    ]);
    const scope = attributionIntents().country.scope;
    const href =
      "http://127.0.0.1/attribution?period=2026-08&destination=GB" +
      `&evidence_id=${encodeURIComponent(PRIMARY_EVIDENCE_ID)}` +
      `&evidence_snapshot_id=${FAMILY_SNAPSHOT_IDS.country}` +
      `&evidence_scope=${encodeURIComponent(JSON.stringify(scope))}`;
    expect(aiPageAddressFromLocation(href)).toBe("/attribution?period=2026-08&destination=GB");
  });

  it("无查询串时只保留路径，锚点不进入页面范围地址", () => {
    expect(aiPageAddressFromLocation("http://127.0.0.1/attribution")).toBe("/attribution");
    expect(aiPageAddressFromLocation("http://127.0.0.1/attribution#section")).toBe("/attribution");
  });

  it("逐个剥掉三个证据地址参数", () => {
    for (const parameter of EVIDENCE_ADDRESS_PARAMETERS) {
      const href = `http://127.0.0.1/attribution?period=2026-08&${parameter}=x`;
      expect(aiPageAddressFromLocation(href), parameter).toBe("/attribution?period=2026-08");
    }
  });

  it("保留归因页自身的全部范围参数，顺序不变", () => {
    const query = PAGE_ADDRESS_ALLOWED_PARAMS.map(
      (param) => `${param}=${encodeURIComponent(PAGE_ADDRESS_PARAM_VALUES[param])}`,
    ).join("&");
    expect(aiPageAddressFromLocation(`http://127.0.0.1/attribution?${query}`)).toBe(
      `/attribution?${query}`,
    );
  });

  it("剥除证据参数是幂等的，生成结果可以直接通过地址校验", () => {
    const href =
      "http://127.0.0.1/attribution?destination=GB&evidence_id=E01-country" +
      "&evidence_snapshot_id=ES-x&evidence_scope=%7B%7D";
    const once = aiPageAddressFromLocation(href);
    const twice = aiPageAddressFromLocation(`http://127.0.0.1${once}`);
    expect(twice).toBe(once);
    expect(validatePageAddress(once)).toBeNull();
  });
});

describe("证据地址的生成", () => {
  it("写入证据 ID、真实快照 ID 与证据自身所属的查询范围", () => {
    const entry = entryOf(PRIMARY_EVIDENCE_ID);
    const url = new URL("http://127.0.0.1/attribution?period=2026-08");
    bindAiEvidenceAddress(url, entry);
    expect(url.searchParams.get("evidence_id")).toBe(PRIMARY_EVIDENCE_ID);
    expect(url.searchParams.get("evidence_snapshot_id")).toBe(entry.evidence_snapshot_id);
    expect(url.searchParams.get("evidence_scope")).toBe(JSON.stringify(entry.scope));
    expect(JSON.parse(url.searchParams.get("evidence_scope") ?? "null")).toEqual(entry.scope);
  });

  it("不改动证据地址之外的范围参数", () => {
    const url = new URL("http://127.0.0.1/attribution?period=2026-08&destination=GB&factor=MIX");
    bindAiEvidenceAddress(url, entryOf("ATTRIBUTION_BRIDGE:MIX", { family: "bridge" }));
    for (const parameter of ["period", "destination", "factor"]) {
      expect(url.searchParams.get(parameter), parameter).not.toBeNull();
    }
    expect(url.pathname).toBe("/attribution");
  });

  it("覆盖旧证据地址而不是追加，条目可被反复改写", () => {
    const url = new URL("http://127.0.0.1/attribution");
    bindAiEvidenceAddress(url, entryOf("E-first"));
    bindAiEvidenceAddress(url, entryOf("E-second", { family: "bridge" }));
    expect(url.searchParams.getAll("evidence_id")).toEqual(["E-second"]);
    expect(url.searchParams.getAll("evidence_scope")).toHaveLength(1);
    expect(url.searchParams.get("evidence_snapshot_id")).toBe(FAMILY_SNAPSHOT_IDS.bridge);
  });

  it("写出的证据地址可以原样剥回页面范围地址", () => {
    const url = new URL("http://127.0.0.1/attribution?period=2026-08");
    bindAiEvidenceAddress(url, entryOf(PRIMARY_EVIDENCE_ID));
    expect(aiPageAddressFromLocation(url.toString())).toBe("/attribution?period=2026-08");
  });
});

/* ---------------------------------------------------------------------------
 * 固定示例快照的六项版本（gate2-design.md §4.2）
 * ------------------------------------------------------------------------- */

describe("固定示例快照的六项版本", () => {
  it("六项字段与快照版本契约完全一致", () => {
    expect(SNAPSHOT_VERSION_FIELDS).toHaveLength(6);
    expect(Object.keys(FIXED_EXAMPLE_SNAPSHOT_VERSIONS)).toEqual([...SNAPSHOT_VERSION_FIELDS]);
    expect(FIXED_EXAMPLE_SNAPSHOT_VERSIONS.contract_version).toBe("V1.1");
  });

  it("未调用模型的三项取显式哨兵，区别于「某个供应商的某个模型」", () => {
    expect(NOT_APPLIED_FIXED_EXAMPLE).toBe("NOT_APPLIED_FIXED_EXAMPLE");
    const notApplied = ["provider", "model", "prompt_version"] as const;
    for (const field of notApplied) {
      expect(FIXED_EXAMPLE_SNAPSHOT_VERSIONS[field], field).toBe(NOT_APPLIED_FIXED_EXAMPLE);
      expect(FIXED_EXAMPLE_SNAPSHOT_VERSIONS[field].trim().length, field).toBeGreaterThan(0);
    }
  });

  it("六项取值全部非空，数据发布与输出模式复用固定示例的既有常量", () => {
    for (const [field, value] of Object.entries(FIXED_EXAMPLE_SNAPSHOT_VERSIONS)) {
      expect(value.trim().length, field).toBeGreaterThan(0);
    }
    expect(FIXED_EXAMPLE_SNAPSHOT_VERSIONS.data_release_id).toBe(FIXED_EXAMPLE_DATA_RELEASE_ID);
    expect(FIXED_EXAMPLE_SNAPSHOT_VERSIONS.output_schema_version).toBe(
      FIXED_EXAMPLE_OUTPUT_SCHEMA_VERSION,
    );
  });
});
