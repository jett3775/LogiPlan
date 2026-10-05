import {
  AI_OUTPUT_SCHEMA_VERSION,
  managementAnalysisSchema,
  type ManagementAnalysis,
} from "@logiplan/contracts";

import {
  ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH,
  ORDER_GRAIN_LABEL_ZH,
  REQUIRED_LIMITATION_LABEL_ZH,
  SCENARIO_NOT_RUN_LABEL_ZH,
} from "../labels/zh-labels";
import {
  FIXED_EXAMPLE_EVALUATION_IDS,
  FIXED_EXAMPLE_SUPPORTED_NUMBERS,
} from "./evaluation-baseline";

/**
 * 固定示例出口（docs/query-contract.md §10、docs/gate2-design.md §4.4）。
 *
 * 内容取自评估集 E01、E05—E10、E20 的已校验结果；每条建议一律
 * `scenario_validation_status = "NOT_RUN"`，且**不含任何未经情景计算支持的
 * 节省金额**（由 `output-guards.ts` 机械断言）。
 *
 * 本切片 `answer_type` 恒为 `FIXED_EXAMPLE`：不调用任何模型即完整可用。
 */

/**
 * ## 证据 ID 体系与范围纪律
 *
 * 本文件的 `evidence_ids` 只能取 `packages/db` 确定性查询实际产出的
 * `EvidenceObject.evidence_id`。真实体系（出处为 `文件:行号`）是：
 *
 * | ID 形态 | 出处 |
 * | --- | --- |
 * | `E01-country` | `packages/db/src/query-service.ts:1349` |
 * | `E05-bridge` | `packages/db/src/query-service.ts:1404` |
 * | `ATTRIBUTION_BRIDGE:<VOLUME\|MIX\|EFFICIENCY\|PRICE\|FX>` | `packages/db/src/query-service.ts:1412` |
 * | `ATTRIBUTION_DRILLDOWN:<rowId>`（含 `:BASELINE`/`:CURRENT`/`:FACTOR:<factor>`） | `packages/db/src/query-service.ts:1581`、`:1802` |
 * | `DIAGNOSTIC_METRICS:<指标>:<基线\|当前\|差值…>` | `packages/db/src/diagnostic-metrics.ts:274-297` |
 * | `E04-total`、`MONTHLY_COST_TREND:*`、`TOP_ADVERSE_ANOMALIES:*`、`FIXED_COST_BREAKDOWN:*` | `packages/db/src/query-service.ts:1316`/`:790`/`:947`/`:1110` |
 * | `E08-<center>`、`E08-company-total` | `packages/db/src/query-service.ts:1874`/`:1907` |
 *
 * `EVIDENCE_LOOKUP` 对请求范围做硬隔离（`query-service.ts:2080`：范围不一致即
 * `INVALID_FILTER`），且归因页只在 `country`/`bridge`/`diagnostics`/`drilldown`
 * 四组结果里查找证据（`apps/web/app/attribution-workspace.tsx:538`）。本页的
 * `FIXED_EXAMPLE_SCOPE_LABEL` 是「2026 年 8 月｜英国｜Actual vs Budget」，与
 * `query-service.ts:244` 的 `evidenceAttributionScope` 完全一致，因此**只引用
 * 该范围下的 ID**：驾驶舱范围（`E04-total`、`MONTHLY_COST_TREND:*`、
 * `TOP_ADVERSE_ANOMALIES:*`、`FIXED_COST_BREAKDOWN:*`）与公司口径发货仓范围
 * （`E08-*`，无 `destination_country_ids`）在本页不可解析，一律不引用。
 *
 * 评估集 `data/generated/ai-evaluation-baseline.json` 的 `evidence` 字段
 * （如 `country_summary|ACTUAL|2026-08|GB`）是**溯源标签**，与
 * `EvidenceObject.evidence_id` 是两套体系，零交集；不得当作证据 ID 输出。
 */

/** E01：英国履约变动成本 Actual/Budget/不利差异。 */
const EVIDENCE_E01 = ["E01-country"];

/** E05—E06：五因素归因合计与逐因素贡献（量、结构、效率、价、汇率）。 */
const EVIDENCE_E05_E06 = [
  "E05-bridge",
  "ATTRIBUTION_BRIDGE:VOLUME",
  "ATTRIBUTION_BRIDGE:MIX",
  "ATTRIBUTION_BRIDGE:EFFICIENCY",
  "ATTRIBUTION_BRIDGE:PRICE",
  "ATTRIBUTION_BRIDGE:FX",
];

/** E07：空运与 Carrier C 包裹占比的结构证据（结构因素 + 诊断指标带）。 */
const EVIDENCE_E07 = [
  "ATTRIBUTION_BRIDGE:MIX",
  "DIAGNOSTIC_METRICS:AIR_SHARE:BASELINE",
  "DIAGNOSTIC_METRICS:AIR_SHARE:CURRENT",
  "DIAGNOSTIC_METRICS:CARRIER_C_SHARE:BASELINE",
  "DIAGNOSTIC_METRICS:CARRIER_C_SHARE:CURRENT",
];

/**
 * E08（公司口径发货仓差异）：**没有本页范围内可解析的真实证据 ID**。
 *
 * 德国仓 589,251.0927 CNY、法国仓 12,299.5128 CNY 的证据是 `E08-DE_FC`/
 * `E08-FR_FC`/`E08-company-total`，但它们属于公司口径范围
 * （`evidenceWarehouseScope`，无 `destination_country_ids`），在英国归因页范围下
 * `EVIDENCE_LOOKUP` 会返回 `INVALID_FILTER`。因此这里不硬凑 ID，叙述中显式标注
 * 「公司口径」，并由 `docs/query-contract.md` §13 的两组分别勾稽口径兜底。
 */
const EVIDENCE_E08: readonly string[] = [];

/**
 * E09（英国增量最大的履约变动成本类别）：**没有对应的单一证据 ID**。
 *
 * 432,453.0802 CNY 是全英国线路按 `cost_category` 汇总的结果，而系统只为
 * `FC × MODE × CARRIER × COST_COMPONENT` 的下钻行产出 `EvidenceObject`
 * （`query-service.ts:1581`、`:1802`），没有任何证据对象承载国家级成本类别合计。
 * 因此该题不引用证据 ID，叙述中说明它由多条线路行汇总而成。
 */
const EVIDENCE_E09: readonly string[] = [];

/** E10：英国准时履约率与服务成熟度。 */
const EVIDENCE_E10 = [
  "DIAGNOSTIC_METRICS:ON_TIME_RATE:CURRENT",
  "DIAGNOSTIC_METRICS:SERVICE_MATURITY:CURRENT",
];

/**
 * 英国线路层级下钻的两个顶层发货仓行（`docs/query-contract.md` §13 的
 * 574,474.2232 CNY＝566,770.9315＋7,703.2917）。
 *
 * 用于界定「当前能回指到的最细粒度是线路层」，即订单粒度保护的边界。
 */
const EVIDENCE_GB_ROUTE_DRILLDOWN = [
  "ATTRIBUTION_DRILLDOWN:FC:DE_FC",
  "ATTRIBUTION_DRILLDOWN:FC:FR_FC",
];

export const FIXED_EXAMPLE_SCOPE_LABEL = "2026 年 8 月｜英国｜Actual vs Budget｜固定示例";

/**
 * 构造固定示例分析。
 *
 * 每次调用返回新对象，避免调用方就地修改污染模块状态；
 * 返回值已通过公共 Zod 模式校验，`ManagementAnalysis` 的形状由契约保证。
 */
export const buildFixedExampleAnalysis = (): ManagementAnalysis => {
  const analysis: ManagementAnalysis = {
    answer_id: "ANSWER_FIXED_GB_2026_08_V1",
    answer_type: "FIXED_EXAMPLE",
    scope_label: FIXED_EXAMPLE_SCOPE_LABEL,
    conclusion: {
      text:
        "英国 2026 年 8 月履约变动成本 Actual 为 891,643.2815 CNY，Budget 为 317,169.0583 CNY，" +
        "不利差异 574,474.2232 CNY。五因素中结构因素 324,207.8221 CNY 为最大驱动，" +
        "其次是量因素 85,239.1844 CNY。本页为固定示例，回答内容全部来自已验收的确定性结果，未调用任何模型。",
      evidence_ids: [
        ...EVIDENCE_E01,
        "E05-bridge",
        "ATTRIBUTION_BRIDGE:MIX",
        "ATTRIBUTION_BRIDGE:VOLUME",
      ],
    },
    evidence: {
      text:
        "五因素拆解：结构 324,207.8221 CNY、量 85,239.1844 CNY、效率 64,558.2789 CNY、" +
        "价 79,960.1574 CNY、汇率 20,508.7803 CNY，合计 574,474.2232 CNY，与英国履约变动成本不利差异勾稽。" +
        "空运包裹占比由 Budget 的 13.69% 升至 Actual 的 66.02%，Carrier C 包裹占比由 2.88% 升至 38.84%；" +
        "英国准时履约率 96.16%，服务成熟度 92.00%。",
      evidence_ids: [
        ...EVIDENCE_E05_E06,
        ...EVIDENCE_E07,
        "DIAGNOSTIC_METRICS:ON_TIME_RATE:CURRENT",
        "DIAGNOSTIC_METRICS:SERVICE_MATURITY:CURRENT",
      ],
    },
    impact: {
      text:
        "本月不利差异 574,474.2232 CNY 中，结构因素 324,207.8221 CNY 与价因素 79,960.1574 CNY 是最大的两项贡献，" +
        "指向可归属线路的履约变动成本本身，而不是固定成本分摊；线路层的发货仓差异可在归因页下钻逐层核对，" +
        "该下钻只含可归属线路的履约变动成本，不把固定成本分摊到发货仓以外的维度。",
      evidence_ids: [
        ...EVIDENCE_E01,
        "ATTRIBUTION_BRIDGE:MIX",
        "ATTRIBUTION_BRIDGE:PRICE",
        ...EVIDENCE_GB_ROUTE_DRILLDOWN,
      ],
    },
    recommendations: [
      {
        text:
          "复核空运与 Carrier C 的分配规则，并把已记录的结构动作在正式 Forecast 中单独版本化。" +
          "本条建议尚未做情景计算，不给出任何节省金额。",
        evidence_ids: [...EVIDENCE_E07],
        scenario_validation_status: "NOT_RUN",
        feasibility_status: "NOT_VALIDATED",
      },
      {
        text:
          "分别复核基础运价与汇率暴露后再评估可行路径。" +
          "本条建议尚未做情景计算，不给出任何节省金额。",
        evidence_ids: ["ATTRIBUTION_BRIDGE:PRICE", "ATTRIBUTION_BRIDGE:FX"],
        scenario_validation_status: "NOT_RUN",
        feasibility_status: "NOT_VALIDATED",
      },
      {
        text:
          "若需要订单级视角，先补齐订单—包裹关联与订单级收入成本事实；" +
          "在此之前不得给出订单级明细或最贵的 10 单。当前只能提供线路层下钻。" +
          `本条建议尚未做情景计算，不给出任何节省金额。${ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH}`,
        evidence_ids: [...EVIDENCE_GB_ROUTE_DRILLDOWN],
        scenario_validation_status: "NOT_RUN",
        feasibility_status: "NOT_VALIDATED",
      },
    ],
    limitations: {
      text:
        "基础运费是 2026 年 8 月英国增量最大的成本类别，相对 Budget 增加 432,453.0802 CNY；" +
        "该类别口径是全英国线路合计，由归因页下钻的多条线路行汇总而成，没有对应的单一证据对象。" +
        "公司口径发货仓差异中德国仓 589,251.0927 CNY、法国仓 12,299.5128 CNY 与英国范围分别勾稽，不与本页结论混用。" +
        "准时履约率 96.16% 但服务成熟度仅 92.00%，未到承诺截止日期的在途包裹不进入准时率分母，" +
        "因此不得把当前结果表述为最终服务表现。" +
        `事实粒度限制：${ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH}` +
        "结构变化与占比变化只能作为贡献与关联证据，不得据此推断未经记录的经营因果。",
      // E08、E09 的数字在本区块陈述，但按上面的范围与证据对象口径都拿不到真实
      // 证据 ID，因此它们在这里贡献零个 ID；只有 E10 的两个诊断指标可回指。
      evidence_ids: [...EVIDENCE_E08, ...EVIDENCE_E09, ...EVIDENCE_E10],
      status_labels: [
        REQUIRED_LIMITATION_LABEL_ZH,
        SCENARIO_NOT_RUN_LABEL_ZH,
        ORDER_GRAIN_LABEL_ZH,
      ],
    },
    evidence_snapshot_id: "SNAPSHOT_GB_2026_08_V1",
    evaluation_question_ids: [...FIXED_EXAMPLE_EVALUATION_IDS],
  };
  return managementAnalysisSchema.parse(analysis);
};

/** 固定示例的输出模式版本；快照恢复校验之一。 */
export const FIXED_EXAMPLE_OUTPUT_SCHEMA_VERSION = AI_OUTPUT_SCHEMA_VERSION;

/** 固定示例的确定性数据发布版本；快照恢复校验之一。 */
export const FIXED_EXAMPLE_DATA_RELEASE_ID = "LOGIPLAN_2026_DEMO_V2";

/** 固定示例可用的数字基线，供输出守卫与其他模块复用。 */
export const FIXED_EXAMPLE_NUMBERS = FIXED_EXAMPLE_SUPPORTED_NUMBERS;
