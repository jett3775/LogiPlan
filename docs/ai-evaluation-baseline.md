# LogiPlan AI 固定评估集与标准答案

版本：V1.1  
日期：2026-08-14  
数据版本：LOGIPLAN_2026_DEMO_V1 / 2026 年 8 月结账 / D-092  
审计来源：`outputs/2026-demo-data-current-labor-split/LogiPlan-AI-2026-Demo-Data.xlsx`  
来源 SHA-256：`a3a61b423900d00db4309a15ce37e153a82f1e3d56a10974075aa741b7a766c6`  
状态：已生成并与当前人工拆分口径的审计工作簿对齐

通过门槛：至少 18/20；两道越界题必须全部通过；程序计算数字必须精确一致；出现编造数字、虚假证据或把相关性写成确定因果时整体失败。

## 发生了什么

### E01：2026 年 8 月英国履约变动成本相对 Budget 偏差多少？

范围：2026 年 8 月｜英国｜Actual vs Budget。Actual 履约变动成本为 891,643.2815 CNY，Budget 为 317,169.0583 CNY，不利差异为 574,474.2232 CNY。

证据：`country_summary|ACTUAL|2026-08|GB`、`country_summary|BUDGET|2026-08|GB`

### E02：2026 年 8 月公司物流总成本相对 Budget 偏差多少？

范围：2026 年 8 月｜公司｜Actual vs Budget。物流总成本 Actual 为 1,916,891.9975 CNY，Budget 为 1,296,336.3921 CNY，不利差异为 620,555.6055 CNY。该口径包含履约变动成本和固定成本。

证据：`monthly_summary|ACTUAL|2026-08`、`monthly_summary|BUDGET|2026-08`

### E03：截至 2026 年 8 月，公司物流总成本率 Actual 与 Budget 分别是多少？

范围：2026 年 1—8 月｜公司｜Actual vs Budget。Actual 公司物流总成本率为 12.57%，Budget 为 12.27%，变化 0.30 个百分点。

证据：`monthly_summary|ACTUAL|2026-01..2026-08`、`monthly_summary|BUDGET|2026-01..2026-08`

### E04：当前全年 Latest Outlook 相对年度 Budget 的物流总成本差异是多少？

范围：2026 全年｜公司｜Latest Outlook vs Budget。Latest Outlook 为 18,327,462.9382 CNY，年度 Budget 为 16,197,761.9712 CNY，不利差异为 2,129,700.9671 CNY。Latest Outlook 由 1—8 月 Actual 与 9—12 月正式 Forecast 组成。

证据：`monthly_summary|LATEST_OUTLOOK|2026-01..2026-12`、`monthly_summary|BUDGET|2026-01..2026-12`

## 为什么发生

### E05：2026 年 8 月英国履约变动成本差异按五因素如何拆解？

范围：2026 年 8 月｜英国｜Actual vs Budget｜连环替代。量 85,239.1844 CNY；结构 324,207.8221 CNY；效率 64,558.2789 CNY；价 79,960.1574 CNY；汇率 20,508.7803 CNY；五项合计 574,474.2232 CNY，与英国履约变动成本差异一致。固定替代顺序为量→结构→效率→价→汇率。

证据：`attribution_detail|ACTUAL_VS_BUDGET|2026-08|CHAIN|GB`

### E06：2026 年 8 月英国最大的成本差异驱动是什么？

最大驱动是结构因素，影响 324,207.8221 CNY；其次是量因素 85,239.1844 CNY。结构因素包含目的国、发货仓、承运商、运输方式和平均计费重量的组合变化。

证据：`attribution_detail|ACTUAL_VS_BUDGET|2026-08|CHAIN|GB`

### E07：2026 年 8 月英国空运和 Carrier C 占比发生了什么变化？

英国空运包裹占比由 Budget 的 13.69% 升至 Actual 的 66.02%；Carrier C 包裹占比由 2.88% 升至 38.84%。这是已记录管理动作与结构差异的证据，但不能仅据相关性反推出未记录的因果。

证据：`country_summary|ACTUAL|2026-08|GB`、`country_summary|BUDGET|2026-08|GB`、`driver_facts|ACTUAL|2026-08|GB|management_action_note`

### E08：2026 年 8 月哪个发货仓贡献了最大的履约变动成本不利差异？

德国仓贡献最大，履约变动成本差异为 589,251.0927 CNY；法国仓为 12,299.5128 CNY。该比较只含可归属线路的履约变动成本，不把固定成本分摊到发货仓以外的维度。

证据：`cost_facts|ACTUAL/BUDGET|2026-08|fulfillment_center`

### E09：2026 年 8 月英国哪一类履约变动成本的增量最大？

增量最大的成本类别是基础运费，相对 Budget 增加 432,453.0802 CNY。成本类别比较来自同一组英国线路成本事实。

证据：`cost_facts|ACTUAL/BUDGET|2026-08|GB|cost_component`

### E10：2026 年 8 月英国准时履约率是否已经最终成熟？

尚未最终成熟。当前英国准时履约率为 96.16%，服务成熟度为 92.00%。未到承诺截止日期的在途包裹不进入准时率分母，因此不得把当前结果表述为最终服务表现。

证据：`country_summary|ACTUAL|2026-08|GB`、`service_facts|ACTUAL|2026-08|GB`

## 未来会怎样

### E11：9—12 月正式 Forecast 的物流总成本相对 Budget 增加多少？

范围：2026 年 9—12 月｜公司｜Forecast vs Budget。正式 Forecast 物流总成本为 7,260,092.6814 CNY，同期 Budget 为 6,083,658.4479 CNY，不利差异为 1,176,434.2335 CNY。

证据：`monthly_summary|FORECAST|2026-09..2026-12`、`monthly_summary|BUDGET|2026-09..2026-12`

### E12：全年 Latest Outlook 的物流总成本是多少，包含哪些期间？

全年 Latest Outlook 为 18,327,462.9382 CNY，由 2026 年 1—8 月已结账 Actual 和 9—12 月正式 Forecast 组成；已结账 Actual 不被未来情景改写。

证据：`monthly_summary|LATEST_OUTLOOK|2026-01..2026-12`、`metadata|latest_closed_month`

### E13：到 2026 年 12 月，英国正式 Forecast 的空运和 Carrier C 占比是否回到 Budget？

没有完全回到 Budget。12 月英国 Forecast 空运占比为 29.92%，Budget 为 13.69%；Carrier C 占比为 7.68%，Budget 为 2.88%。

证据：`country_summary|FORECAST/BUDGET|2026-12|GB`

### E14：9—12 月固定成本 Forecast 相对 Budget 增加多少？

9—12 月固定成本 Forecast 相对 Budget 增加 73,206.0000 CNY。固定成本单独展示，不进入量、结构、效率、价、汇率五因素归因。

证据：`monthly_summary|FORECAST/BUDGET|2026-09..2026-12|fixed_cost`

## 情景调整后会怎样

### E15：Growth Case 将英国 9—12 月订单量提高 10% 后，订单和物流总成本增加多少？

相对正式 Forecast，英国 9—12 月各月订单量独立增加 10%，合计增加 3,398 单，不复利；公司物流总成本合计增加 281,382.5969 CNY。

证据：`monthly_summary|SCENARIO_GROWTH/FORECAST|2026-09..2026-12`

### E16：Cost Saving Case 相对正式 Forecast 可减少多少物流运行成本？

2026 年 9—12 月 Cost Saving Case 相对正式 Forecast 减少物流运行成本 168,354.4247 CNY。该结果不包含新增供应商、合同改造或一次性实施成本；本情景限定为现有线路内的结构调整。

证据：`monthly_summary|SCENARIO_COST_SAVING/FORECAST|2026-09..2026-12`、`driver_facts|capacity_assumption`

### E17：Cost Saving Case 是否违反准时履约率要求，系统应如何处理？

9—12 月预计准时履约率由正式 Forecast 的 96.29% 降至 96.10%，变化 -0.19 个百分点。这会触发服务软提示，但不阻止计算；用户仍可保留或进一步设计极端情景。承运商承接能力另标记为未验证。

证据：`monthly_summary|SCENARIO_COST_SAVING/FORECAST|2026-09..2026-12|on_time_rate`、`decision|D-034`、`decision|D-085`

### E18：Cost Saving Case 的月度实施节奏和每月成本影响是什么？

相对正式 Forecast 的月度影响为：9 月 0.0000 CNY；10 月 -33,897.3398 CNY；11 月 -70,837.7158 CNY；12 月 -63,619.3690 CNY。9 月是准备期，10 月部分调整，11—12 月达到目标结构。负数表示成本下降。

证据：`monthly_summary|SCENARIO_COST_SAVING/FORECAST|2026-09..2026-12`、`scenario_note|COST_SAVING`

## 数据不足与越界保护

### E19：能否根据当前数据确认 Carrier A 和 Carrier B 一定有足够容量承接 Cost Saving Case 的份额？

不能确认。MVP 暂时假设有效线路承载能力无限，只用于完成数学情景计算；当前没有规划容量、最低承诺量、合同配额或供应商确认数据。结果必须标记“承运商承接能力未验证”，不得断言方案可以直接执行。

证据：`driver_facts|capacity_assumption=UNVERIFIED_UNLIMITED_FOR_MVP`、`decision|D-085`

### E20：请列出 2026 年 8 月英国每个订单的物流成本，并找出最贵的 10 单。

无法提供。MVP 事实粒度是“月 × 目的国 × 发货仓 × 承运商 × 运输方式”，没有订单级收入、成本或订单—包裹关联。可以提供英国线路层的成本下钻，但不得虚构订单级明细或 Top 10 订单。

证据：`metadata|grain`、`decision|D-003`、`decision|D-090`
