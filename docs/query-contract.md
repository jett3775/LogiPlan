# LogiPlan AI 确定性查询与证据契约草案

版本：V0.1  
日期：2026-08-14  
状态：核心桌面原型草案；原型验收后冻结  
依据：D-037—D-042、D-093—D-119

## 1. 目标与范围

本契约定义自然语言解析、确定性查询、结构化证据和 AI 管理分析之间的边界。所有金额、排名、差异、Forecast 和情景结果均由程序返回；模型不读取原始事实表、不生成 SQL，也不自行计算数字。

首个原型只执行两个固定范围：

- 驾驶舱：`2026 全年｜公司｜Latest Outlook vs Budget`；
- 归因页：`2026-08｜GB｜Actual vs Budget｜CHAIN`。

契约结构按完整 MVP 设计，但原型只实现标记为 `prototype_required` 的查询。

## 2. 不可违反的业务约束

1. `Latest Outlook = 1—8 月 Actual + 9—12 月正式 Forecast`；
2. 公司物流总成本包含履约变动成本和物流运营固定成本；
3. 目的国及更细下钻只展示履约变动成本，不分摊固定成本；
4. 五因素固定顺序为 `VOLUME → MIX → EFFICIENCY → PRICE → FX`；
5. 页面、查询结果、归因、证据对象和 AI 文本必须使用同一高精度事实；
6. 准时履约率是服务指标，不直接进入成本归因；服务成熟度不是履约质量；
7. 当前事实粒度不支持订单级成本、Top 订单或订单—包裹追踪；
8. 任何缺失或不合法范围必须返回结构化错误，不得回退到近似数据。

## 3. 公共类型

```ts
type DataSeries =
  | "BUDGET"
  | "ACTUAL"
  | "FORECAST"
  | "LATEST_OUTLOOK"
  | "SCENARIO_BASE"
  | "SCENARIO_GROWTH"
  | "SCENARIO_COST_SAVING";

type Comparison =
  | "ACTUAL_VS_BUDGET"
  | "LATEST_OUTLOOK_VS_BUDGET"
  | "FORECAST_VS_BUDGET"
  | "SCENARIO_GROWTH_VS_FORECAST"
  | "SCENARIO_COST_SAVING_VS_FORECAST";

type Dimension =
  | "MONTH"
  | "DESTINATION_COUNTRY"
  | "FULFILLMENT_CENTER"
  | "TRANSPORT_MODE"
  | "CARRIER"
  | "COST_COMPONENT"
  | "FIXED_COST_CATEGORY";

type AttributionFactor = "VOLUME" | "MIX" | "EFFICIENCY" | "PRICE" | "FX";

interface AnalysisScope {
  period: { from: string; to: string; grain: "MONTH" | "RANGE" };
  comparison: Comparison;
  destination_country_ids?: string[];
  fulfillment_center_ids?: string[];
  transport_mode_ids?: string[];
  carrier_ids?: string[];
  cost_component_ids?: string[];
  factor_id?: AttributionFactor;
  budget_version_id: string;
  actual_version_id?: string;
  forecast_version_id?: string;
  scenario_version_id?: string;
  calculation_version: string;
}
```

范围中的版本字段必须显式传递；服务端不得仅根据“最新”文字动态选择版本。

## 4. 受限查询意图

```ts
type QuestionType =
  | "DASHBOARD_OVERVIEW"
  | "MONTHLY_COST_TREND"
  | "TOP_ADVERSE_ANOMALIES"
  | "FIXED_COST_BREAKDOWN"
  | "WAREHOUSE_VARIANCE_CONTEXT"
  | "COUNTRY_VARIANCE_SUMMARY"
  | "ATTRIBUTION_BRIDGE"
  | "ATTRIBUTION_DRILLDOWN"
  | "DIAGNOSTIC_METRICS"
  | "EVIDENCE_LOOKUP"
  | "MANAGEMENT_ANALYSIS";

interface QueryIntent {
  question_type: QuestionType;
  scope: AnalysisScope;
  metrics: string[];
  group_by: Dimension[];
  top_n?: number;
  output_locale: "zh-CN";
  context_sources: Array<"USER" | "PAGE_VISIBLE_STATE" | "FIXED_TEMPLATE">;
}
```

原型不执行自然语言解析，直接使用经过校验的固定 `QueryIntent`。正式应用中模型只生成候选意图，必须通过枚举、范围、版本、维度和 `top_n` 校验后才能执行。

## 5. 首批查询操作

| 操作 | 主要输入 | 主要输出 | 原型 |
|---|---|---|---|
| `DASHBOARD_OVERVIEW` | 全年公司范围 | 6 个 KPI、Budget、Latest Outlook、差异 | 必做 |
| `MONTHLY_COST_TREND` | 全年月度范围 | 12 月 Budget、Actual/Forecast、结账分界 | 必做 |
| `TOP_ADVERSE_ANOMALIES` | 月份 × 目的国 | Top 5、当前/基准、差异率、不利贡献占比 | 必做 |
| `FIXED_COST_BREAKDOWN` | 全年公司范围 | 类别 → 发货仓/共享层 | 必做 |
| `WAREHOUSE_VARIANCE_CONTEXT` | 2026-08、公司范围 | 发货仓当前值、基准值、差异及公司总计 | 必做 |
| `COUNTRY_VARIANCE_SUMMARY` | 2026-08、GB | 成本摘要与诊断指标 | 必做 |
| `ATTRIBUTION_BRIDGE` | 2026-08、GB、CHAIN | Budget 起点、五因素、Actual 终点 | 必做 |
| `ATTRIBUTION_DRILLDOWN` | 固定路径和可选因素 | 父子行、原始成本、差异、贡献、证据 | 必做 |
| `DIAGNOSTIC_METRICS` | 2026-08、GB | 订单、结构、服务和成熟度比较 | 必做 |
| `EVIDENCE_LOOKUP` | `evidence_id` | 不可变证据对象 | 必做 |
| `MANAGEMENT_ANALYSIS` | 确定性结果集合 | 五段结构化回答 | 固定示例 |

## 6. 通用确定性结果

```ts
interface DeterministicResult<T> {
  result_id: string;
  query_intent: QueryIntent;
  scope_label: string;
  data_as_of: string;
  generated_at: string;
  reporting_currency: "CNY";
  precision: { calculation: "HIGH_PRECISION_DECIMAL"; report_places: 4; display_places: 2 };
  payload: T;
  evidence: EvidenceObject[];
  warnings: ResultWarning[];
}

interface ResultWarning {
  code: "SERVICE_NOT_MATURE" | "CAPACITY_NOT_VALIDATED" | "HISTORICAL_VERSION" | "REPORT_ROUNDING";
  message: string;
}
```

金额同时保留高精度文本和 4 位报告值；界面 2 位显示不得反向成为查询或证据权威值。

## 7. 归因桥与下钻结果

```ts
interface AttributionBridgePayload {
  baseline: MoneyValue;
  factors: Array<{
    factor_id: AttributionFactor;
    label_zh: string;
    amount: MoneyValue;
    sequence: number;
  }>;
  current: MoneyValue;
  reconciliation_delta: MoneyValue;
  method: "CHAIN";
}

interface DrilldownRow {
  row_id: string;
  parent_row_id: string | null;
  level: "FULFILLMENT_CENTER" | "TRANSPORT_MODE" | "CARRIER" | "COST_COMPONENT";
  dimension_id: string;
  label_zh: string;
  baseline_cost: MoneyValue;
  current_cost: MoneyValue;
  variance: MoneyValue;
  variance_rate: DecimalValue | null;
  adverse_contribution_share: DecimalValue | null;
  saving_contribution_share: DecimalValue | null;
  factor_contributions: Record<AttributionFactor, MoneyValue>;
  children_available: boolean;
  evidence_ids: string[];
}
```

未选择因素时，下钻表以 `variance` 为主要贡献列；选择因素后突出对应 `factor_contributions[factor_id]`。任一父行的直接子行必须分别勾稽父行的基准成本、当前成本、总差异和各因素贡献。

`WAREHOUSE_VARIANCE_CONTEXT` 与 `ATTRIBUTION_DRILLDOWN` 是两个独立结果：前者不带目的国筛选，按公司 2026 年 8 月变动成本勾稽；后者固定带 `destination_country_id = "GB"`，按英国 2026 年 8 月变动成本勾稽。二者不得共享结果总计或证据 ID。

## 8. 金额与比率值

```ts
interface MoneyValue {
  high_precision: string;
  report: string;
  display: string;
  currency: "CNY";
}

interface DecimalValue {
  high_precision: string;
  report: string;
  display: string;
  unit: "RATIO" | "PERCENT" | "PERCENTAGE_POINT";
}
```

成本差异采用“当前 − 基准”；正值为不利，负值为有利。占比变化和准时履约率变化使用百分点，不使用百分比增长率。

## 9. 结构化证据对象

```ts
interface EvidenceObject {
  evidence_id: string;
  metric: string;
  value: string;
  unit: string;
  period: { from: string; to: string };
  comparison: Comparison;
  filters: Record<string, string[]>;
  group_by: Dimension[];
  versions: {
    budget: string;
    actual?: string;
    forecast?: string;
    scenario?: string;
    calculation: string;
  };
  calculation_method: string;
  source_result_id: string;
  snapshot_generated_at: string;
  source_refs: string[];
}
```

`evidence_id` 由查询结果生成并在快照内稳定。不存在的 ID 返回 `EVIDENCE_NOT_FOUND`；不得模糊匹配到其他数字。点击证据只打开侧栏；只有用户执行“在表格中定位”后才调整下钻展开状态。

## 10. AI 管理分析输出

```ts
interface ManagementAnalysis {
  answer_id: string;
  answer_type: "FIXED_EXAMPLE" | "LIVE_GENERATED";
  scope_label: string;
  conclusion: RichSection;
  evidence: RichSection;
  impact: RichSection;
  recommendations: Array<{
    text: string;
    evidence_ids: string[];
    scenario_validation_status: "NOT_RUN" | "RUN";
    feasibility_status: "NOT_VALIDATED" | "PARTIALLY_VALIDATED" | "VALIDATED";
  }>;
  limitations: RichSection;
  evidence_snapshot_id: string;
  evaluation_question_ids: string[];
}

interface RichSection {
  text: string;
  evidence_ids: string[];
}
```

首期固定示例引用 `E01`、`E05`—`E10` 和 `E20` 的已校验结果。建议一律标记 `scenario_validation_status = "NOT_RUN"`，不得给出未经情景计算支持的节省金额。

## 11. 页面地址状态

正式归因页地址至少保存：

```text
/analysis/attribution
  ?period=2026-08
  &comparison=ACTUAL_VS_BUDGET
  &destination=GB
  &budget=BUDGET_2026_V1
  &actual=ACTUAL_2026_08_CLOSE_V1
  &method=CHAIN
  &factor=MIX              # 可选
  &evidence_id=...         # 可选
```

原型使用 `view=dashboard|attribution` 模拟页面导航，并使用 `variant=A|B|C` 切换结构方案；业务范围保持固定。

## 12. 错误契约

```ts
interface QueryError {
  error_id: string;
  code:
    | "INVALID_METRIC"
    | "INVALID_DIMENSION"
    | "INVALID_FILTER"
    | "INVALID_PERIOD"
    | "VERSION_NOT_FOUND"
    | "UNSUPPORTED_GRAIN"
    | "ORDER_LEVEL_NOT_AVAILABLE"
    | "EVIDENCE_NOT_FOUND"
    | "RECONCILIATION_FAILED";
  message_zh: string;
  missing_capabilities?: string[];
  request_id: string;
}
```

`E20` 必须返回 `ORDER_LEVEL_NOT_AVAILABLE`，并说明当前可提供线路层下钻，禁止生成订单级 Top 10。

## 13. 核心固定结果

| 结果 | 4 位报告值 |
|---|---:|
| 全年 Latest Outlook 物流总成本 | 18,327,462.9382 CNY |
| 年度 Budget 物流总成本 | 16,197,761.9712 CNY |
| 全年不利差异 | 2,129,700.9671 CNY |
| 8 月英国 Actual 履约变动成本 | 891,643.2815 CNY |
| 8 月英国 Budget 履约变动成本 | 317,169.0583 CNY |
| 8 月英国不利差异 | 574,474.2232 CNY |
| 结构因素 | 324,207.8221 CNY |
| 量因素 | 85,239.1844 CNY |
| 效率因素 | 64,558.2789 CNY |
| 价因素 | 79,960.1574 CNY |
| 汇率因素 | 20,508.7803 CNY |

五个已显示到 4 位小数的因素直接相加存在 0.0001 CNY 报告尾差；高精度合计与 574,474.2232 CNY 严格勾稽。

公司口径的 2026 年 8 月发货仓差异为：德国仓 589,251.0927 CNY、法国仓 12,299.5128 CNY，合计 601,550.6055 CNY。英国归因页的发货仓差异为：德国仓 566,770.9315 CNY、法国仓 7,703.2917 CNY，合计 574,474.2232 CNY。两组数字分别勾稽各自范围。

## 14. 原型验收映射

| 评估题 | 查询操作 | 页面位置 |
|---|---|---|
| E01 | `COUNTRY_VARIANCE_SUMMARY` | 归因页三张成本摘要卡 |
| E04 | `DASHBOARD_OVERVIEW` | 驾驶舱 KPI |
| E05、E06 | `ATTRIBUTION_BRIDGE` | 瀑布图与 AI |
| E07 | `DIAGNOSTIC_METRICS` | 诊断指标带 |
| E08 | `WAREHOUSE_VARIANCE_CONTEXT` | 驾驶舱“8 月公司发货仓差异” |
| E09 | `ATTRIBUTION_DRILLDOWN` | 英国归因页成本类别下钻 |
| E10 | `DIAGNOSTIC_METRICS` | 服务成熟度与 AI 限制 |
| E20 | 错误契约 | AI 限制和数据粒度说明 |

原型通过不等于契约冻结。只有数字、勾稽、页面状态、证据侧栏和 9 题验收全部确认后，V0.1 才升级为正式实现契约。
