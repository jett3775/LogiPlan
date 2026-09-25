# LogiPlan AI 数据字典

版本：V1.0  
日期：2026-08-13  
状态：V1.0 已冻结；小样本验证通过  
权威决策：`docs/decisions.md`  
规范术语：`CONTEXT.md`

## 1. 目的与边界

本字典定义 LogiPlan AI MVP 的逻辑数据模型、事实粒度、字段口径、来源关系和发布校验。模型采用“来源层分开、分析层统一”：Budget、Actual 和 Forecast 保留不同生成机制，经校验与确定性计算后生成统一分析事实。

本版本只覆盖月度聚合数据，不伪造订单 ID，不生成 2026 年全年数据，不包含采购入库运输、税务模型、订单级账单重演、固定成本驱动分析或承运商容量模型。

正式实现按能力闸门分批迁移。本字典描述完整 MVP 逻辑模型，不要求首次迁移一次性创建全部表：第一闸门只落地发布版本、核心维度与线路、Budget、Actual、Forecast、价格、汇率、统一分析事实、固定成本事实及归因查询所需结构；情景会话、真实 AI、证据快照、限流和费用结构在对应能力实施时追加。

## 2. 全局数据约定

### 2.1 报告与原币

- 唯一管理报告币种：CNY。
- 所有货币事实同时保留原币金额、ISO 4217 币种、汇率引用和 CNY 报告金额。
- 汇率方向统一为“1 单位原币 = 若干 CNY”。
- Budget 使用年度固定预算汇率；Actual 使用对应月份月平均会计汇率；Forecast 使用版本发布时冻结的月度规划汇率。

### 2.2 精度

| 业务类型                         | PostgreSQL 逻辑类型 | 说明                                |
| -------------------------------- | ------------------: | ----------------------------------- |
| 业务输入、权威金额、标准报告金额 |     `numeric(20,4)` | 业务口径精度                        |
| 公式中间值、原子成本、归因金额   |    `numeric(50,24)` | 不在原子行提前舍入                  |
| 汇率                             |     `numeric(20,6)` | 原币到 CNY                          |
| 单价                             |     `numeric(20,4)` | CNY 或原币单位价格                  |
| 订单、包裹、事件、重量           |     `numeric(20,4)` | 分析层允许等效小数                  |
| 比例、费率                       |     `numeric(12,6)` | 以 0—1 表示；计费异常事件率可大于 1 |

计算过程不逐行舍入，也不使用二进制浮点数。高精度汇总和归因完成后生成 4 位标准报告金额；界面金额显示 2 位小数，差异率显示 2 位小数。

### 2.3 稳定标识与时间

- 业务主键使用稳定文本代码或 UUID；展示名称不可充当关联键。
- 管理月份使用 `month_id`，格式为 `YYYY-MM`。
- 德国仓事件时区为 `Europe/Berlin`，法国仓为 `Europe/Paris`。
- 月份归属以发货仓当地时间的“承运商接收包裹”事件为准。
- MVP 不生成跨月拆包订单，也不允许单个订单跨发货仓拆分。

### 2.4 场景枚举

| 代码       | 含义                                         |
| ---------- | -------------------------------------------- |
| `BUDGET`   | 批准并冻结的年度预算基线                     |
| `ACTUAL`   | 已结账或修订的实际数据版本                   |
| `FORECAST` | 未结账月份的正式滚动预测版本                 |
| `SCENARIO` | 相对正式 Forecast 的会话级试算；默认不持久化 |

### 2.5 成本类别枚举

| 代码                         | 中文名称         | 成本层           |
| ---------------------------- | ---------------- | ---------------- |
| `BASE_FREIGHT`               | 基础运费         | 销售履约变动成本 |
| `FUEL_SURCHARGE`             | 燃油附加费       | 销售履约变动成本 |
| `BILLABLE_EXCEPTION`         | 异常配送费       | 销售履约变动成本 |
| `FRONTLINE_VARIABLE_LABOR`   | 一线作业弹性人工 | 销售履约变动成本 |
| `PACKAGING`                  | 包装材料费       | 销售履约变动成本 |
| `RETURN_LOGISTICS`           | 退货物流费       | 销售履约变动成本 |
| `WAREHOUSE_RENT`             | 仓租             | 物流运营固定成本 |
| `FRONTLINE_BASE_LABOR`       | 一线作业基础人工 | 物流运营固定成本 |
| `WAREHOUSE_MANAGEMENT_LABOR` | 仓库管理人工     | 物流运营固定成本 |
| `SYSTEM_COST`                | 系统费用         | 物流运营固定成本 |

## 3. 核心维度与主数据

### 3.1 `dim_destination_country`

粒度：每个目的国一行。

| 字段                          | 类型 | 约束与含义             |
| ----------------------------- | ---- | ---------------------- |
| `destination_country_id`      | text | 主键；`DE`、`FR`、`GB` |
| `destination_country_name_zh` | text | 德国、法国、英国       |
| `active_from` / `active_to`   | date | 有效期                 |

### 3.2 `dim_fulfillment_center`

粒度：每个发货仓一行。

| 字段                         | 类型 | 约束与含义                        |
| ---------------------------- | ---- | --------------------------------- |
| `fulfillment_center_id`      | text | 主键；如 `DE_FC`、`FR_FC`         |
| `fulfillment_center_name_zh` | text | 德国仓、法国仓                    |
| `location_country_id`        | text | 仓库所在地国家                    |
| `iana_timezone`              | text | `Europe/Berlin` 或 `Europe/Paris` |
| `active_from` / `active_to`  | date | 有效期                            |

### 3.3 `dim_carrier`

粒度：每个虚构承运商一行。

| 字段             | 类型    | 约束与含义                                  |
| ---------------- | ------- | ------------------------------------------- |
| `carrier_id`     | text    | 主键；`CARRIER_A`、`CARRIER_B`、`CARRIER_C` |
| `carrier_name`   | text    | 页面显示名称                                |
| `demo_role_note` | text    | 虚构成本—服务角色说明                       |
| `is_demo_entity` | boolean | MVP 固定为 `true`                           |

### 3.4 `dim_transport_mode`

粒度：每种跨境运输方案一行。

| 字段                     | 类型 | 约束与含义      |
| ------------------------ | ---- | --------------- |
| `transport_mode_id`      | text | `AIR` 或 `ROAD` |
| `transport_mode_name_zh` | text | 空运、公路运输  |

运输方案指端到端履约线路的主导跨境主干方案，不单独表示末端派送。

### 3.5 `fulfillment_route`

粒度：每个有效的“目的国 × 发货仓 × 承运商 × 跨境运输方案”组合一行。

| 字段                      | 类型      | 约束与含义           |
| ------------------------- | --------- | -------------------- |
| `route_id`                | text/uuid | 主键                 |
| `destination_country_id`  | text      | 外键                 |
| `fulfillment_center_id`   | text      | 外键                 |
| `carrier_id`              | text      | 外键                 |
| `transport_mode_id`       | text      | 外键                 |
| `valid_from` / `valid_to` | date      | 线路有效期           |
| `status`                  | enum      | `ACTIVE`、`INACTIVE` |

唯一约束：上述四个维度加有效期不得重叠。任一场景只能对当月有效线路产生业务量。

### 3.6 `business_event_note`

粒度：每条显式业务背景或管理决策记录一行。

| 字段                     | 类型          | 含义                                    |
| ------------------------ | ------------- | --------------------------------------- |
| `event_note_id`          | uuid          | 主键                                    |
| `note_type`              | enum          | `BUSINESS_CONTEXT`、`MANAGEMENT_ACTION` |
| `month_id`               | text          | 适用月份                                |
| `destination_country_id` | text nullable | 可选范围                                |
| `note_text`              | text          | 如英国促销、维持时效的结构调整          |
| `source_type`            | enum          | MVP 为 `DEMO_PLANNING_ASSUMPTION`       |
| `version_id`             | text          | 注释版本                                |

注释是已知业务输入，不是模型自动推导的因果证据。

## 4. 版本、汇率与价格主数据

### 4.1 `scenario_version`

粒度：每个正式 Budget、Actual 或 Forecast 版本一行。

| 字段                     | 类型                 | 含义                               |
| ------------------------ | -------------------- | ---------------------------------- |
| `scenario_version_id`    | text/uuid            | 主键                               |
| `scenario_type`          | enum                 | `BUDGET`、`ACTUAL`、`FORECAST`     |
| `version_name`           | text                 | 可读名称                           |
| `status`                 | enum                 | `DRAFT`、`PUBLISHED`、`SUPERSEDED` |
| `base_budget_version_id` | text nullable        | Forecast 和更正 Budget 的基准      |
| `price_version_id`       | text                 | 引用价格版本                       |
| `fx_version_id`          | text                 | 引用汇率版本                       |
| `latest_closed_month`    | text nullable        | 全年最新预测切换月份               |
| `published_at`           | timestamptz nullable | 发布时间                           |
| `change_reason`          | text nullable        | 更正或修订原因                     |
| `calculation_version`    | text                 | 确定性模型版本                     |

批准 Budget 不可覆盖；Actual 发票追补生成新版本；Forecast 发布后冻结。

### 4.2 `fx_rate_version` 与 `fx_rate`

`fx_rate_version` 粒度：每个汇率版本一行。  
`fx_rate` 粒度：每个“汇率版本 × 月份 × 原币”一行。

| 字段                    | 类型          | 含义                                                           |
| ----------------------- | ------------- | -------------------------------------------------------------- |
| `fx_rate_id`            | uuid          | 主键                                                           |
| `fx_version_id`         | text          | 外键                                                           |
| `month_id`              | text          | Budget 可为全年重复固定值                                      |
| `currency_code`         | char(3)       | ISO 4217                                                       |
| `cny_per_currency_unit` | numeric(20,6) | 1 原币折合 CNY                                                 |
| `rate_type`             | enum          | `BUDGET_ANNUAL`、`ACTUAL_MONTHLY_AVERAGE`、`FORECAST_PLANNING` |
| `source_note`           | text          | 演示假设或会计口径说明                                         |

CNY 汇率固定为 1。所有场景涉及的原币必须在相应汇率版本中完整覆盖。

### 4.3 `price_version`

粒度：每个价格主数据版本一行。记录版本类型、状态、有效范围、来源说明和发布时间。

### 4.4 `transport_price`

粒度：每个“价格版本 × 月份 × 履约线路”一行。

| 字段                         | 类型          | 含义                                                             |
| ---------------------------- | ------------- | ---------------------------------------------------------------- |
| `transport_price_id`         | uuid          | 主键                                                             |
| `price_version_id`           | text          | 外键                                                             |
| `month_id`                   | text          | 适用月份                                                         |
| `route_id`                   | text          | 履约线路                                                         |
| `currency_code`              | char(3)       | 原币                                                             |
| `effective_base_rate_per_kg` | numeric(20,4) | 有效每公斤基础运价                                               |
| `fuel_charge_basis`          | enum          | `PERCENTAGE_OF_BASE_FREIGHT`、`PER_CHARGEABLE_KG`、`PER_PACKAGE` |
| `fuel_rate_or_unit_price`    | numeric(20,6) | 与计费方式匹配                                                   |
| `source_note`                | text          | 合同或演示规划依据                                               |

MVP 实际使用前两种燃油方式，预留按包裹计费。计费方式变化属于价格条件变化。

### 4.5 `frontline_variable_labor_price`

粒度：每个“价格版本 × 月份 × 发货仓”一行。核心字段为原币、`variable_labor_price_per_order`、有效期和来源说明。该单价只包含计件工资、加班费、临时用工及其他量相关人工，不包含一线人员底薪、固定津贴和仓库管理人工。

### 4.6 `packaging_price`

粒度：每个“价格版本 × 月份 × 发货仓”一行。核心字段为原币、`packaging_price_per_package`、有效期和来源说明。

### 4.7 `return_logistics_price`

粒度：每个“价格版本 × 月份 × 目的国 × 发货仓”一行。核心字段为原币和 `effective_return_price_per_package`。该价格合并逆向运输与退货处理。

### 4.8 `billable_exception_price`

粒度：每个“价格版本 × 月份 × 履约线路”一行。核心字段为原币和 `average_price_per_billable_event`。MVP 不拆异常类型。

## 5. Budget 来源层

所有 Budget 假设记录 `source_type = DEMO_PLANNING_ASSUMPTION`、假设版本、制定依据和备注。

### 5.1 `budget_country_month`

粒度：每个“Budget 版本 × 月份 × 目的国”一行。

| 字段                     | 类型          | 含义               |
| ------------------------ | ------------- | ------------------ |
| `scenario_version_id`    | text          | Budget 版本        |
| `month_id`               | text          | 月份               |
| `destination_country_id` | text          | 目的国             |
| `order_qty`              | numeric(20,4) | 目的国真实订单总量 |
| `gmv_original_amount`    | numeric(20,4) | 履约 GMV 原币金额  |
| `gmv_currency_code`      | char(3)       | GMV 原币           |
| `gmv_fx_rate_id`         | uuid          | 预算汇率引用       |
| `assumption_note`        | text          | 规划说明           |

### 5.2 `budget_warehouse_allocation`

粒度：每个“Budget 版本 × 月份 × 目的国 × 发货仓”一行。

字段：`warehouse_order_share`。同一目的国和月份的占比合计必须为 1。预算仓级订单量 = 目的国订单量 × 仓库订单占比。

### 5.3 `budget_route_allocation`

粒度：每个“Budget 版本 × 月份 × 履约线路”一行。

| 字段                                       | 类型          | 含义                                         |
| ------------------------------------------ | ------------- | -------------------------------------------- |
| `route_package_share_within_warehouse`     | numeric(12,6) | 同一目的国、发货仓内各承运商与方式的包裹占比 |
| `average_chargeable_weight_per_package_kg` | numeric(20,4) | 单包裹平均计费重量                           |
| `assumption_note`                          | text          | 重量季节性等说明                             |

同一“月份 × 目的国 × 发货仓”的线路占比合计必须为 1。

### 5.4 Budget 效率与服务标准

| 逻辑表                           | 粒度                          | 核心字段                             |
| -------------------------------- | ----------------------------- | ------------------------------------ |
| `budget_packages_per_order`      | 版本 × 月份 × 目的国 × 发货仓 | `average_packages_per_order`         |
| `budget_return_rate`             | 版本 × 月份 × 目的国          | `return_rate`                        |
| `budget_billable_exception_rate` | 版本 × 月份 × 履约线路        | `billable_events_per_package`        |
| `budget_route_service_standard`  | 版本 × 月份 × 履约线路        | `planned_on_time_rate`、承诺服务天数 |

即使某有效线路 Budget 业务量为零，仍必须能取得相应效率、服务、价格和汇率基准。

### 5.5 `budget_fixed_cost`

粒度：每个“Budget 版本 × 月份 × 固定成本归属层 × 固定成本类别”一行。

`cost_scope_type` 为 `FULFILLMENT_CENTER` 或 `SHARED`；仓租、一线作业基础人工和仓库管理人工归属发货仓，总部系统费用可归属共享层。

## 6. Actual 来源层

### 6.1 `actual_country_warehouse_fulfillment`

粒度：每个“Actual 版本 × 月份 × 目的国 × 发货仓”一行。

| 字段                     | 类型          | 含义                               |
| ------------------------ | ------------- | ---------------------------------- |
| `order_qty`              | numeric(20,4) | 真实履约订单量；MVP 来源值应为整数 |
| `carrier_received_month` | text          | 按当地承运商接收事件归属的月份     |

同一目的国各仓订单量之和等于目的国订单总量。一个订单只属于一个发货仓。

### 6.2 `actual_route_operation`

粒度：每个“Actual 版本 × 月份 × 履约线路”一行。

| 字段                           | 类型          | 含义                       |
| ------------------------------ | ------------- | -------------------------- |
| `package_qty`                  | numeric(20,4) | 实际包裹数；来源值应为整数 |
| `chargeable_weight_kg`         | numeric(20,4) | 承运商账单总计费重量       |
| `actual_weight_kg`             | numeric(20,4) | 总实际物理重量             |
| `billable_exception_event_qty` | numeric(20,4) | 产生额外费用的异常事件总数 |

线路等效订单量按同仓包裹占比分配：

```text
线路等效订单量
= 仓级真实订单量 × 线路包裹量 ÷ 同仓全部线路包裹量
```

### 6.3 `actual_return_operation`

粒度：每个“Actual 版本 × 月份 × 目的国”一行。保存 `returned_order_qty`。MVP 假设一笔退货订单对应一个退货包裹，并归入原履约月份。

### 6.4 `actual_gmv`

粒度：每个“Actual 版本 × 月份 × 目的国”一行。保存履约 GMV 原币金额、币种、实际汇率引用和 CNY 金额。

### 6.5 `actual_route_service`

粒度：每个“Actual 版本 × 发运月份 × 履约线路”一行。

| 字段                            | 类型          | 含义                   |
| ------------------------------- | ------------- | ---------------------- |
| `cohort_package_qty`            | numeric(20,4) | 该发运 cohort 全部包裹 |
| `due_package_qty`               | numeric(20,4) | 已到承诺截止日期的包裹 |
| `on_time_delivered_package_qty` | numeric(20,4) | 提前或按期妥投包裹     |
| `on_time_rate`                  | derived       | `on_time / due`        |
| `maturity_rate`                 | derived       | `due / cohort`         |

### 6.6 Actual 权威成本

权威成本按自然业务粒度保存，字段均包含原币权威金额、币种、汇率引用、CNY 权威金额、`amount_source`、来源记录和核对状态。

| 逻辑表                             | 粒度                                        | 成本类别                                       |
| ---------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `actual_transport_cost`            | 版本 × 月份 × 履约线路                      | 基础运费、燃油附加费、异常配送费               |
| `actual_fulfillment_variable_cost` | 版本 × 月份 × 发货仓                        | 一线作业弹性人工、包装材料费                   |
| `actual_return_cost`               | 版本 × 月份 × 目的国 × 发货仓               | 退货物流费                                     |
| `actual_fixed_cost`                | 版本 × 月份 × 发货仓或共享层 × 固定成本类别 | 仓租、一线作业基础人工、仓库管理人工、系统费用 |

`amount_source` 为 `INVOICE` 或 `ACCRUAL`。发票追补生成新的 Actual 版本，不覆盖旧版本。

自营仓工资必须先按薪资项目、劳动合同或经批准的薪酬结构分类：计件工资、加班费、临时用工及其他量相关人工进入 `FRONTLINE_VARIABLE_LABOR`；一线人员底薪、固定津贴和雇主固定负担进入 `FRONTLINE_BASE_LABOR`；仓库经理、主管、计划等管理岗位进入 `WAREHOUSE_MANAGEMENT_LABOR`。来源数据无法可靠拆分时，标记数据不完整并阻止正式成本归因，不得按订单量任意拆分底薪。

### 6.7 Actual 有效单价与核对

| 单价                             | 推导方式                                                  |
| -------------------------------- | --------------------------------------------------------- |
| 实际有效基础运价                 | 权威基础运费原币金额 ÷ 总计费重量                         |
| 实际有效单均一线作业弹性人工成本 | 权威计件、加班、临时用工及其他量相关人工 ÷ 仓级真实订单量 |
| 实际包装单价                     | 权威包装费 ÷ 仓级包裹量                                   |
| 实际有效退货单价                 | 权威退货成本 ÷ 退货包裹量                                 |
| 实际平均异常事件成本             | 权威异常配送费 ÷ 计费异常事件数                           |

模型重算金额与权威金额的差额为结算差异。MVP 小样本及正式演示数据要求差异为零；无法解释的差异阻止 Actual 和归因发布。

## 7. Forecast 来源层

Forecast 以未结账月份 Budget 为完整基线，只保存规范粒度的覆盖项。

### 7.1 `forecast_version`

扩展 `scenario_version`，保存基准 Budget、价格版本、规划汇率版本、最近结账月份、状态和发布时间。

### 7.2 Forecast 覆盖表

| 逻辑表                                 | 覆盖粒度                            | 覆盖字段                     |
| -------------------------------------- | ----------------------------------- | ---------------------------- |
| `forecast_country_order_override`      | 版本 × 月份 × 目的国                | 目标订单量或相对 Budget 调整 |
| `forecast_warehouse_share_override`    | 版本 × 月份 × 目的国 × 发货仓       | 仓库订单占比                 |
| `forecast_route_share_override`        | 版本 × 月份 × 履约线路              | 仓内线路包裹占比             |
| `forecast_weight_override`             | 版本 × 月份 × 履约线路              | 单包裹平均计费重量           |
| `forecast_packages_per_order_override` | 版本 × 月份 × 目的国 × 发货仓       | 平均每单包裹数               |
| `forecast_return_rate_override`        | 版本 × 月份 × 目的国                | 退货率                       |
| `forecast_exception_rate_override`     | 版本 × 月份 × 履约线路              | 计费异常事件率               |
| `forecast_service_override`            | 版本 × 月份 × 履约线路              | 规划准时履约率或服务标准     |
| `forecast_gmv_override`                | 版本 × 月份 × 目的国                | 履约 GMV                     |
| `forecast_fixed_cost_override`         | 版本 × 月份 × 发货仓或共享层 × 类别 | 明确固定成本金额             |

未覆盖字段继承 Budget。上层批量控件只生成这些规范粒度覆盖，不建立第二套运行时优先级。

## 8. 统一分析层

### 8.1 `fulfillment_scenario_fact`

粒度：每个“场景版本 × 月份 × 履约线路”一行。

| 字段                                       | 类型                   | 含义                                         |
| ------------------------------------------ | ---------------------- | -------------------------------------------- |
| `fulfillment_fact_id`                      | uuid                   | 主键                                         |
| `scenario_type`                            | enum                   | Budget、Actual、Forecast；会话情景可临时生成 |
| `scenario_version_id`                      | text                   | 来源版本                                     |
| `calculation_version`                      | text                   | 计算版本                                     |
| `month_id`                                 | text                   | 月份                                         |
| `route_id`                                 | text                   | 原子履约线路                                 |
| `equivalent_order_qty`                     | numeric(20,4)          | 线路等效订单量                               |
| `package_qty`                              | numeric(20,4)          | 包裹量                                       |
| `average_packages_per_order`               | numeric(20,6)          | 目的国 × 发货仓参数                          |
| `chargeable_weight_kg`                     | numeric(20,4)          | 总计费重量                                   |
| `average_chargeable_weight_per_package_kg` | numeric(20,4)          | 平均计费重量                                 |
| `actual_weight_kg`                         | numeric(20,4) nullable | Actual 可用                                  |
| `return_rate`                              | numeric(12,6)          | 目的国参数                                   |
| `return_package_qty`                       | numeric(20,4)          | 等效订单量 × 退货率                          |
| `billable_events_per_package`              | numeric(12,6)          | 计费异常事件率                               |
| `billable_exception_event_qty`             | numeric(20,4)          | 包裹量 × 事件率                              |
| `on_time_rate`                             | numeric(12,6) nullable | 服务指标                                     |
| `service_maturity_rate`                    | numeric(12,6) nullable | Actual cohort 成熟度                         |
| `source_lineage`                           | jsonb                  | 来源记录与参数版本引用                       |

目的国、发货仓、承运商和运输方式可从 `route_id` 唯一取得。分析视图可以冗余这些键，但不得形成另一套业务主键。

### 8.2 `scenario_cost_component_fact`

粒度：每个“履约分析事实 × 销售履约变动成本类别”一行。

| 字段                            | 类型                   | 含义                                     |
| ------------------------------- | ---------------------- | ---------------------------------------- |
| `cost_component_fact_id`        | uuid                   | 主键                                     |
| `fulfillment_fact_id`           | uuid                   | 外键                                     |
| `cost_category`                 | enum                   | 六类变动成本                             |
| `price_record_id`               | uuid                   | 价格主数据引用                           |
| `currency_code`                 | char(3)                | 原币                                     |
| `model_original_amount`         | numeric(50,24)         | 公式重算原币金额                         |
| `authoritative_original_amount` | numeric(20,4) nullable | Actual 权威金额                          |
| `fx_rate_id`                    | uuid                   | 汇率引用                                 |
| `model_cny_amount`              | numeric(50,24)         | 模型折算金额                             |
| `report_cny_amount`             | numeric(20,4)          | 报告权威金额；Budget/Forecast 等于模型值 |
| `settlement_variance_cny`       | numeric(50,24)         | Actual 权威值减模型值                    |
| `amount_source`                 | enum nullable          | `INVOICE`、`ACCRUAL`；仅 Actual          |

### 8.3 `scenario_gmv_fact`

粒度：每个“场景版本 × 月份 × 目的国”一行。保存履约 GMV 原币金额、币种、汇率和 CNY 金额。GMV 不复制到线路。

### 8.4 `fixed_cost_scenario_fact`

粒度：每个“场景版本 × 月份 × 发货仓或共享层 × 固定成本类别”一行。保存原币金额、币种、汇率、CNY 金额、来源和版本。

### 8.5 `variance_comparison`

粒度：每个可复现比较一行。

核心字段：`comparison_id`、Budget 版本、对比场景版本、期间范围、最近结账月份、计算版本、创建时间和状态。

### 8.6 `variance_attribution_fact`

粒度：每个“比较 × 月份 × 履约线路 × 成本类别 × 归因方法 × 因素”一行。

该事实在正式数据发布阶段由确定性模型计算、校验并固化。查询服务按请求汇总原子事实并生成页面结果和证据对象，不在筛选后重新运行归因算法，也不持久化整页响应。

| 字段                  | 类型           | 含义                                         |
| --------------------- | -------------- | -------------------------------------------- |
| `comparison_id`       | uuid           | 比较版本                                     |
| `month_id`            | text           | 月份计算边界                                 |
| `route_id`            | text           | 原子履约线路                                 |
| `cost_category`       | enum           | 变动成本类别                                 |
| `method`              | enum           | `CHAIN_SUBSTITUTION`、`SHAPLEY`              |
| `factor`              | enum           | `VOLUME`、`MIX`、`EFFICIENCY`、`PRICE`、`FX` |
| `attribution_cny`     | numeric(50,24) | 高精度贡献金额                               |
| `calculation_version` | text           | 算法版本                                     |

所有页面层级只汇总原子归因，不在筛选后重新计算。

### 8.7 `attribution_sensitivity_result`

粒度：每个“比较 × 月份或汇总范围 × 因素”一行。保存连环替代结果、Shapley 结果、绝对差、归一化差异、金额门槛和是否提示顺序敏感。

## 9. 确定性计算公式

对任一场景、月份和履约线路：

```text
仓级订单量 = 目的国订单量 × 仓库订单占比
线路等效订单量 = 仓级订单量 × 仓内线路包裹占比
包裹量 = 线路等效订单量 × 平均每单包裹数
总计费重量 = 包裹量 × 单包裹平均计费重量

基础运费 = 总计费重量 × 有效每公斤基础运价

燃油附加费 =
  基础运费 × 燃油费率                       （按基础运费比例）
  或 总计费重量 × 每公斤燃油附加费          （按计费重量）
  或 包裹量 × 单包裹燃油附加费              （预留）

一线作业弹性人工 = 线路等效订单量 × 有效单均一线作业弹性人工成本
包装费 = 包裹量 × 单包裹包装成本
退货包裹量 = 线路等效订单量 × 退货率
退货物流费 = 退货包裹量 × 有效单包裹退货物流成本
计费异常事件数 = 包裹量 × 计费异常事件率
异常配送费 = 计费异常事件数 × 平均每计费异常事件成本

销售履约变动成本
= 基础运费 + 燃油附加费 + 一线作业弹性人工
 + 包装费 + 退货物流费 + 异常配送费

物流运营固定成本 = 仓租 + 一线作业基础人工 + 仓库管理人工 + 系统费用
物流总成本 = 销售履约变动成本 + 物流运营固定成本
```

金额先在原币计算，再使用该场景适用汇率折算 CNY。

## 10. 指标口径

| 指标                   | 公式                                   | 可展示层级                                         |
| ---------------------- | -------------------------------------- | -------------------------------------------------- |
| 单均履约变动成本       | 销售履约变动成本 ÷ 订单量              | 公司、目的国、发货仓；更细层使用等效订单量时须标注 |
| 单均物流总成本         | 物流总成本 ÷ 公司订单量                | 公司；发货仓可展示其可归属固定成本口径             |
| 每公斤运输成本         | 运输成本 ÷ 总计费重量                  | 公司及所有线路聚合层                               |
| 公司物流总成本率       | 物流总成本 ÷ 公司履约 GMV              | 公司                                               |
| 目的国履约变动成本率   | 目的国履约变动成本 ÷ 目的国履约 GMV    | 目的国                                             |
| 准时履约率             | 按时妥投包裹 ÷ 已到承诺截止日期包裹    | 线路及向上聚合                                     |
| 服务成熟度             | 已到承诺截止日期包裹 ÷ cohort 全部包裹 | 线路及向上聚合                                     |
| 每百包裹计费异常事件数 | 计费异常事件数 ÷ 包裹量 × 100          | 线路及向上聚合                                     |

发货仓、承运商和运输方式不展示成本率，因为 GMV 没有真实归属到这些层级。

## 11. 发布前完整性校验

### 11.1 结构与主数据

1. 所有有业务量的组合必须是当月有效履约线路。
2. 同一目的国仓库订单占比合计为 1。
3. 同一目的国和发货仓的线路包裹占比合计为 1。
4. Actual 同一目的国各仓订单量之和等于目的国订单总量。
5. 每个有业务量或归因反事实需要的组合都能取得唯一价格、效率、服务和汇率记录。

### 11.2 数值

1. 订单量、包裹量、重量、GMV 和成本不得为负。
2. 退货率、仓库占比、线路占比和准时率在 0—1；计费异常事件率允许大于 1。
3. `on_time_package_qty ≤ due_package_qty ≤ cohort_package_qty`。
4. 高精度分项成本之和等于销售履约变动成本。
5. 固定成本加变动成本等于物流总成本。

### 11.3 Actual 权威核对

1. 每项 Actual 权威成本均有 `INVOICE` 或 `ACCRUAL` 来源。
2. MVP 模型重算值与权威值在内部精度上相等。
3. 预提占比可计算并可追溯。
4. 未解释结算差异阻止发布。

### 11.4 Forecast 与全年最新预测

1. 已结账月份 Actual 完整；未结账月份指定 Forecast 完整。
2. Forecast 只覆盖未结账月份。
3. 覆盖项均落在规范业务粒度。
4. 全年最新预测严格由“最近结账月份以前 Actual + 以后 Forecast”组成。

### 11.5 归因

1. 月份是归因计算边界。
2. 原子线路五因素之和等于该线路销售履约变动成本差异。
3. 所有原子线路汇总等于公司差异。
4. 各下钻子项之和等于上级。
5. 连环替代与 Shapley 使用同一成本函数和同一输入版本。

### 11.6 正式数据发布执行

1. 数据库结构迁移与业务数据发布分开执行；Web 应用启动不得写入或覆盖正式业务数据。
2. 每个发布数据包具有唯一版本号，并记录文件校验和、数据库结构版本、计算版本、生成时间和来源。
3. 数据先导入候选发布区，再校验清单、行数、引用完整性、本章恒等式和核心 9 题。
4. 只有全部校验通过的候选版本才能通过单次原子操作成为当前活动版本。
5. 发布失败时保持当前活动版本不变；回滚通过切换至已验证历史版本完成，不修改历史发布数据。
6. 同一数据包的重复导入必须幂等，不得生成重复业务记录或改变既有发布结果。

数据库结构以纳入版本控制的显式 SQL 迁移为唯一权威来源。应用启动只检查结构版本兼容性，不自动建表或同步结构；数据库访问层生成的类型和模型不得覆盖 SQL 中的精度、约束、索引或外键定义。

公开发布先执行向后兼容的扩展迁移，再校验候选数据、部署兼容新旧结构的应用，最后以单个事务激活候选版本。同一发布不得删除或改义上一应用版本仍在使用的数据库对象。

第一闸门迁移只增不减；废弃对象仅标记并停止使用，不删除、重命名、缩窄类型、降低精度或原地改义。破坏性清理须在第一闸门之后另行审批。

本地、CI 和公开环境使用同一锁定的 PostgreSQL 主版本。第一闸门的数据模型与迁移不得依赖托管厂商专有扩展；主版本变化必须单独执行兼容性、精度和回滚验证。

当前正式基线为 PostgreSQL 18，首次实现使用 18.4；后续仅在 18.x 内经过完整回归后升级补丁版本。

Web 运行时通过 Neon 池化端点使用只读凭据，所有 SQL 显式限定 schema；结构迁移与数据发布通过管理直连和独立凭据执行，管理连接信息不得进入应用运行环境。

数据库角色至少拆分为 `schema_migrator`、`data_publisher` 和 `app_reader`：分别管理结构、候选数据发布与活动版本只读查询。权限默认拒绝，`app_reader` 不得读取候选或未发布数据。

## 12. 会话情景与 AI 证据对象

匿名情景、AI 回答和证据默认保存在浏览会话，不进入共享业务库。证据对象至少包含：

```text
evidence_id
metric
value
unit
period
comparison
filters
group_by
version
calculation_method
source_result_id
```

旧回答引用生成时的不可变证据快照；按当前版本重新运行会生成新快照。

## 13. 明确预留但不在 MVP 实现

- 订单级 `sales_order`；
- 包裹级 `package`；
- `order_package_bridge`，支持跨仓和跨月拆包；
- 异常事件类型明细；
- 承运商容量、最低承诺量、返利和合同配额；
- 固定成本面积、人数、工时和账号用量驱动；
- 阶梯价、最低收费、体积重及重量进位账单引擎；
- 完整多币种界面和原币切换；
- 历史反事实复盘页面。

这些扩展不得改变当前成本类别、报告币种、月份归属、Budget 冻结和销售履约变动成本五因素恒等式。
