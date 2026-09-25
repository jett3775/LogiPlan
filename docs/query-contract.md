# LogiPlan AI 确定性查询与证据契约

版本：V1.1
日期：2026-09-02
状态：已冻结；V1.0 兼容扩展
依据：D-037—D-042、D-093—D-125

## 1. 目标与范围

本契约定义自然语言解析、确定性查询、结构化证据和 AI 管理分析之间的边界。所有金额、排名、差异、Forecast 和情景结果均由程序返回；模型不读取原始事实表、不生成 SQL，也不自行计算数字。

首个原型只执行两个固定范围：

- 驾驶舱：`2026 全年｜公司｜Latest Outlook vs Budget`；
- 归因页：`2026-08｜GB｜Actual vs Budget｜CHAIN`。

契约结构按完整 MVP 设计，但原型只实现标记为 `prototype_required` 的查询。

正式实现采用固定调用分层：界面和路由只调用查询服务，查询服务调用领域层与数据访问层；只有数据访问层可以通过参数化 SQL 访问 PostgreSQL。任何界面组件、页面加载器、Server Action 或 Route Handler 均不得直接依赖物理表结构或执行 SQL。

所有页面数据请求最终必须归一化为本契约的 `QuestionType + AnalysisScope`，并经同一查询服务完成校验、执行和证据生成。页面具名封装不得建立独立业务口径或跳过显式版本字段。

### 1.1 正式 API 传输

- 浏览器触发的查询统一使用 `POST /api/v1/query`。V1.1 JSON 请求体必须包含 `contract_version: "V1.1"`，响应回显实际执行的 `contract_version`。
- 未携带版本字段的严格 V1.0 请求继续按原有 `QuestionType + AnalysisScope` 语义执行；V1.0 不支持按 `evidence_id` 查询。
- Next.js 服务端渲染直接调用同一查询服务函数，不通过内部 HTTP 请求自身端点。
- Route Handler 只处理传输解析与 JSON 序列化；输入校验、查询、精度、错误和证据逻辑均由共享查询服务执行。
- 第一闸门不创建驾驶舱、归因或证据侧栏专用业务查询端点。

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
  contract_version?: "V1.1";
  scope: AnalysisScope;
  metrics: string[];
  group_by: Dimension[];
  top_n?: number;
  output_locale: "zh-CN";
  context_sources: Array<"USER" | "PAGE_VISIBLE_STATE" | "FIXED_TEMPLATE">;
  evidence_id?: string;
  evidence_snapshot_id?: string;
}
```

原型不执行自然语言解析，直接使用经过校验的固定 `QueryIntent`。正式应用中模型只生成候选意图，必须通过枚举、范围、版本、维度和 `top_n` 校验后才能执行。

### 4.1 V1.0/V1.1 兼容边界

- 未版本化请求只允许 V1.0 已冻结字段，未知字段仍由严格 schema 拒绝，既有查询语义不变。
- V1.1 请求必须显式携带 `contract_version = "V1.1"`，不得以 HTTP 路径隐式推断请求版本。
- `question_type = "EVIDENCE_LOOKUP"` 时 `evidence_id` 必填且必须为非空精确 ID；不存在时返回 `EVIDENCE_NOT_FOUND`，不得模糊匹配。
- 其他 `question_type` 出现 `evidence_id` 必须校验失败；不得把证据 ID 塞入 `metrics` 或 `scope`。
- 成功响应回显实际执行的 `contract_version`；V1.0 响应为 `"V1.0"`，V1.1 响应为 `"V1.1"`。

### 4.2 持久化历史查询证据（D-187）

V1.1 的 `EVIDENCE_LOOKUP` 可额外提供顶层 `evidence_snapshot_id`，与必填的 `evidence_id` 配合使用。快照 ID 为 1—240 字符、无首尾空格的非空文本；其他查询不得携带。两种 ID 均不得借用 `metrics` 或 `scope`。V1.0 请求及其证据输出保持原结构。

V1.1 成功查询的每个证据对象增加 `evidence_snapshot_id` 和 `data_release_id`。查询服务在同一个 REPEATABLE READ 事务内读取活动发布、执行查询并调用受控数据库函数保存完整确定性结果；提交后才返回快照标识。函数自行读取发布并生成 ID，只向快照表插入，不授予 `app_reader` 基础业务表或快照表的写权限。快照表禁止 UPDATE、DELETE、TRUNCATE。

普通 V1.1 及未绑定快照的 EVIDENCE_LOOKUP 使用同一个数据库连接完成上述非 READ ONLY 事务，调用专用 `persist_query_evidence_snapshot`。每次成功实时查询追加独立快照，即使查询意图与 `result_id` 相同，快照 ID 仍不同；预生成物化命中不能绕过查询和保存。发布端保留独立幂等物化函数，历史 lookup 不新增快照。完整结果及保存返回值校验、COMMIT 成功后才返回 200；失败按既有错误契约处理，不降级为缺少快照的 V1.1 成功。提交确认丢失不得表述为已回滚。此保存路径仅适用于 V1.1，V1.0 不写实时快照。

指定快照的 lookup 只读取持久化 JSON，保留证据值、来源结果、生成时间、原始范围和实际数据发布，不重新查询业务事实。未知快照或快照中不存在的精确证据 ID 返回 `EVIDENCE_NOT_FOUND`；找到证据后，完整请求范围与保存范围不同返回 `INVALID_FILTER`。活动发布不同或缺失时增加 `HISTORICAL_VERSION` 提示。仅带旧式 `evidence_id` 的请求仍按现有映射首次查询当前发布，并返回新快照；此类未绑定快照的旧链接不承诺历史复现。

证据打开后 URL 保存 `evidence_id`、`evidence_snapshot_id`、`evidence_scope`（完整 AnalysisScope 的 JSON），同时保留现有页面范围与路径参数。证据范围可以独立于页面随后选择的因素；服务端严格校验的是 `evidence_scope`。刷新或分享带快照链接直接进入历史数字证据视图，不依赖当前驾驶舱或归因查询成功，不恢复整页历史报表，也不在 Web 重算金额。关闭清除三个证据参数；前进后退按地址重新读取持久快照。

## 5. 首批查询操作

| 操作                         | 主要输入           | 主要输出                                | 原型     |
| ---------------------------- | ------------------ | --------------------------------------- | -------- |
| `DASHBOARD_OVERVIEW`         | 全年公司范围       | 6 个 KPI、Budget、Latest Outlook、差异  | 必做     |
| `MONTHLY_COST_TREND`         | 全年月度范围       | 12 月 Budget、Actual/Forecast、结账分界 | 必做     |
| `TOP_ADVERSE_ANOMALIES`      | 月份 × 目的国      | Top 5、当前/基准、差异率、不利贡献占比  | 必做     |
| `FIXED_COST_BREAKDOWN`       | 全年公司范围       | 类别 → 发货仓/共享层                    | 必做     |
| `WAREHOUSE_VARIANCE_CONTEXT` | 2026-08、公司范围  | 发货仓当前值、基准值、差异及公司总计    | 必做     |
| `COUNTRY_VARIANCE_SUMMARY`   | 2026-08、GB        | 成本摘要与诊断指标                      | 必做     |
| `ATTRIBUTION_BRIDGE`         | 2026-08、GB、CHAIN | Budget 起点、五因素、Actual 终点        | 必做     |
| `ATTRIBUTION_DRILLDOWN`      | 固定路径和可选因素 | 父子行、原始成本、差异、贡献、证据      | 必做     |
| `DIAGNOSTIC_METRICS`         | 2026-08、GB        | 订单、结构、服务和成熟度比较            | 必做     |
| `EVIDENCE_LOOKUP`            | `evidence_id`      | 不可变证据对象                          | 必做     |
| `MANAGEMENT_ANALYSIS`        | 确定性结果集合     | 五段结构化回答                          | 固定示例 |

## 6. 通用确定性结果

```ts
interface DeterministicResult<T> {
  result_id: string;
  contract_version: "V1.0" | "V1.1";
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
  evidence_snapshot_id?: string; // V1.1 成功持久化后提供
  data_release_id?: string; // 该证据实际读取的发布
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
  status_labels?: string[];
}
```

首期固定示例引用 `E01`、`E05`—`E10` 和 `E20` 的已校验结果。建议一律标记 `scenario_validation_status = "NOT_RUN"`，不得给出未经情景计算支持的节省金额。

`limitations.status_labels` 用于显示必须被直接识别的限制标签。核心固定示例至少包含“相关性不等于因果 · 不得推断未记录的经营因果”；订单粒度保护显示 `ORDER_LEVEL_NOT_AVAILABLE` 对应的中文 `message_zh`，不得向用户只显示内部错误代码。

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
  &evidence_snapshot_id=... # 打开持久证据后保存
  &evidence_scope=...      # URL 编码后的完整证据查询范围
```

原型使用 `view=dashboard|attribution` 模拟页面导航，固定采用方案 B“分析工作台侧轨”；业务范围保持固定。

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

### 12.1 基础设施错误与超时

V1.0 `QueryError` 只表示业务查询错误，其 `code` 联合类型保持冻结。网络、服务不可用和超时等基础设施故障不加入该联合类型。

确定性查询使用一次性完整 JSON 响应，不返回部分业务结果。服务端硬超时为 10 秒；超时返回 HTTP 504，响应结构为：

```ts
interface InfrastructureError {
  type: "QUERY_TIMEOUT";
  message_zh: string;
  request_id: string;
}
```

正常热运行条件下，第一闸门确定性查询的端到端 P95 验收目标不超过 1 秒。

### 12.2 取消与过期响应

用户切换范围、离开页面或发起新查询时，客户端必须取消旧请求，并以本地请求序号和当前 `AnalysisScope` 双重判断响应是否仍然有效。只有最新且范围一致的响应可以更新结果、证据和错误状态。

服务端应接收取消信号并尽力取消数据库查询；即使底层查询继续完成，过期结果也不得写入页面状态或查询缓存。取消属于正常并发控制，不显示为业务查询错误。

### 12.3 请求标识

服务端为每次查询生成唯一 `request_id`，并在所有响应的 `X-Request-Id` 响应头中返回。业务错误和基础设施错误的正文使用同一个 `request_id`；成功响应正文保持不变。

客户端本地请求序号只用于并发与过期响应保护，不作为服务端 `request_id`。客户端传入的标识不得覆盖服务端生成值。

### 12.4 结构化日志与脱敏

查询日志只记录最小必要运行元数据：时间、环境、`request_id`、`QuestionType`、规范化范围代码、数据与计算版本、耗时、行数、HTTP 状态、错误类型和取消状态。

禁止记录完整结果、证据正文或值、固定 AI 示例正文、Cookie、授权信息、数据库连接信息、原始 IP、完整请求头和自然语言问题全文。生产环境不得默认记录请求体或响应体。

请求级结构化日志最多保留 14 天并自动删除，不进行长期归档。移除 `request_id`、范围代码和版本标识后的匿名聚合性能指标可以保留 90 天；聚合指标不得用于重建单次请求或访客行为。

### 12.5 运行告警

- 活动正式版本出现 `RECONCILIATION_FAILED`、数据库结构不兼容、活动发布缺失或发布校验失败时立即触发严重告警。
- 在至少 20 次查询的滚动 5 分钟窗口内，非用户取消的错误与超时比例超过 5%时触发可用性告警。
- 正常热查询 P95 连续 10 分钟超过 1 秒时触发性能告警。
- 告警仅包含聚合运行信息、活动版本和示例 `request_id`，不得附带完整业务内容或身份信息。

## 13. 核心固定结果

| 结果                           |          4 位报告值 |
| ------------------------------ | ------------------: |
| 全年 Latest Outlook 物流总成本 | 18,327,462.9382 CNY |
| 年度 Budget 物流总成本         | 16,197,761.9712 CNY |
| 全年不利差异                   |  2,129,700.9671 CNY |
| 8 月英国 Actual 履约变动成本   |    891,643.2815 CNY |
| 8 月英国 Budget 履约变动成本   |    317,169.0583 CNY |
| 8 月英国不利差异               |    574,474.2232 CNY |
| 结构因素                       |    324,207.8221 CNY |
| 量因素                         |     85,239.1844 CNY |
| 效率因素                       |     64,558.2789 CNY |
| 价因素                         |     79,960.1574 CNY |
| 汇率因素                       |     20,508.7803 CNY |

五个已显示到 4 位小数的因素直接相加存在 0.0001 CNY 报告尾差；高精度合计与 574,474.2232 CNY 严格勾稽。

公司口径的 2026 年 8 月发货仓差异为：德国仓 589,251.0927 CNY、法国仓 12,299.5128 CNY，合计 601,550.6055 CNY。英国归因页的发货仓差异为：德国仓 566,770.9315 CNY、法国仓 7,703.2917 CNY，合计 574,474.2232 CNY。两组数字分别勾稽各自范围。

## 14. 原型验收映射

| 评估题   | 查询操作                     | 页面位置                   |
| -------- | ---------------------------- | -------------------------- |
| E01      | `COUNTRY_VARIANCE_SUMMARY`   | 归因页三张成本摘要卡       |
| E04      | `DASHBOARD_OVERVIEW`         | 驾驶舱 KPI                 |
| E05、E06 | `ATTRIBUTION_BRIDGE`         | 瀑布图与 AI                |
| E07      | `DIAGNOSTIC_METRICS`         | 诊断指标带                 |
| E08      | `WAREHOUSE_VARIANCE_CONTEXT` | 驾驶舱“8 月公司发货仓差异” |
| E09      | `ATTRIBUTION_DRILLDOWN`      | 英国归因页成本类别下钻     |
| E10      | `DIAGNOSTIC_METRICS`         | 服务成熟度与 AI 限制       |
| E20      | 错误契约                     | AI 限制和数据粒度说明      |

数字、勾稽、页面状态、证据侧栏和核心 9 题已经通过 D-124 验收；本文件在 2026-09-01 以 D-186 扩展为 V1.1，2026-09-02 以 D-187 明确允许在 V1.1 增加可选快照输入和证据发布元数据。此例外仅适用于本次持久化查询证据切片，仍需兼容回归；V1.0 继续作为未版本化请求的兼容基线。其他字段或语义变更仍须版本决策，不得静默覆盖 V1.0。
