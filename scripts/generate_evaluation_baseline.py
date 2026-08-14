from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "generated" / "logiplan-2026-demo-data.json"
JSON_PATH = ROOT / "data" / "generated" / "ai-evaluation-baseline.json"
DOC_PATH = ROOT / "docs" / "ai-evaluation-baseline.md"

MONTHS = tuple(f"2026-{month:02d}" for month in range(1, 13))
ACTUAL_MONTHS = MONTHS[:8]
FUTURE_MONTHS = MONTHS[8:]


def d(value: Any) -> Decimal:
    return Decimal(str(value))


def q4(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.0001")), "f")


def money(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.0001')):,.4f} CNY"


def integer(value: Decimal) -> str:
    return f"{value.quantize(Decimal('1')):,.0f}"


def pct(value: Decimal) -> str:
    return f"{(value * Decimal('100')).quantize(Decimal('0.01'))}%"


def pp(value: Decimal) -> str:
    return f"{(value * Decimal('100')).quantize(Decimal('0.01'))} 个百分点"


def main() -> None:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    monthly = {(row["series_id"], row["month_id"]): row for row in data["monthly_summary"]}
    country = {(row["series_id"], row["month_id"], row["destination_country_id"]): row for row in data["country_summary"]}

    def total(series: str, months: tuple[str, ...], field: str) -> Decimal:
        return sum((d(monthly[(series, month)][field]) for month in months), Decimal("0"))

    def cost_rate(series: str, months: tuple[str, ...]) -> Decimal:
        return total(series, months, "total_cost_cny_high_precision") / total(series, months, "gmv_cny_high_precision")

    def weighted_on_time(series: str, months: tuple[str, ...]) -> Decimal:
        numerator = sum((d(monthly[(series, month)]["on_time_rate"]) * d(monthly[(series, month)]["packages"]) for month in months), Decimal("0"))
        return numerator / total(series, months, "packages")

    aug_budget_gb = country[("BUDGET", "2026-08", "GB")]
    aug_actual_gb = country[("ACTUAL", "2026-08", "GB")]
    aug_gb_var = d(aug_actual_gb["variable_cost_cny_high_precision"]) - d(aug_budget_gb["variable_cost_cny_high_precision"])
    aug_company_var = d(monthly[("ACTUAL", "2026-08")]["total_cost_cny_high_precision"]) - d(monthly[("BUDGET", "2026-08")]["total_cost_cny_high_precision"])

    gb_routes = {row["route_id"] for row in data["dimensions"]["routes"] if row["destination_country_id"] == "GB"}
    gb_factor_values: dict[str, Decimal] = {}
    for factor in ("VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"):
        gb_factor_values[factor] = sum((
            d(row["amount_cny_high_precision"])
            for row in data["attribution_detail"]
            if row["comparison_id"] == "ACTUAL_VS_BUDGET" and row["month_id"] == "2026-08"
            and row["method_id"] == "CHAIN" and row["factor_id"] == factor and row["route_id"] in gb_routes
        ), Decimal("0"))

    component_values: dict[str, Decimal] = {}
    for component in ("BASE_FREIGHT", "FUEL_SURCHARGE", "FRONTLINE_VARIABLE_LABOR", "PACKAGING", "RETURN_LOGISTICS", "BILLABLE_EXCEPTION"):
        actual = sum((d(row["model_cost_cny_high_precision"]) for row in data["cost_facts"] if row["version_id"] == "ACTUAL_2026_08_CLOSE_V1" and row["month_id"] == "2026-08" and row["route_id"] in gb_routes and row["cost_component_id"] == component), Decimal("0"))
        budget = sum((d(row["model_cost_cny_high_precision"]) for row in data["cost_facts"] if row["version_id"] == "BUDGET_2026_V1" and row["month_id"] == "2026-08" and row["route_id"] in gb_routes and row["cost_component_id"] == component), Decimal("0"))
        component_values[component] = actual - budget
    largest_component = max(component_values, key=component_values.get)

    warehouse_values: dict[str, Decimal] = {}
    for warehouse in ("DE_FC", "FR_FC"):
        actual = sum((d(row["model_cost_cny_high_precision"]) for row in data["cost_facts"] if row["version_id"] == "ACTUAL_2026_08_CLOSE_V1" and row["month_id"] == "2026-08" and row["fulfillment_center_id"] == warehouse), Decimal("0"))
        budget = sum((d(row["model_cost_cny_high_precision"]) for row in data["cost_facts"] if row["version_id"] == "BUDGET_2026_V1" and row["month_id"] == "2026-08" and row["fulfillment_center_id"] == warehouse), Decimal("0"))
        warehouse_values[warehouse] = actual - budget

    annual_budget = total("BUDGET", MONTHS, "total_cost_cny_high_precision")
    annual_latest = total("LATEST_OUTLOOK", MONTHS, "total_cost_cny_high_precision")
    future_budget = total("BUDGET", FUTURE_MONTHS, "total_cost_cny_high_precision")
    future_forecast = total("FORECAST", FUTURE_MONTHS, "total_cost_cny_high_precision")
    future_fixed_var = total("FORECAST", FUTURE_MONTHS, "fixed_cost_cny_high_precision") - total("BUDGET", FUTURE_MONTHS, "fixed_cost_cny_high_precision")
    growth_order_delta = total("SCENARIO_GROWTH", FUTURE_MONTHS, "orders") - total("FORECAST", FUTURE_MONTHS, "orders")
    growth_cost_delta = total("SCENARIO_GROWTH", FUTURE_MONTHS, "total_cost_cny_high_precision") - future_forecast
    saving_delta = total("SCENARIO_COST_SAVING", FUTURE_MONTHS, "total_cost_cny_high_precision") - future_forecast
    forecast_ot = weighted_on_time("FORECAST", FUTURE_MONTHS)
    saving_ot = weighted_on_time("SCENARIO_COST_SAVING", FUTURE_MONTHS)

    factor_cn = {"VOLUME": "量", "MIX": "结构", "EFFICIENCY": "效率", "PRICE": "价", "FX": "汇率"}
    component_cn = {"BASE_FREIGHT": "基础运费", "FUEL_SURCHARGE": "燃油附加费", "FRONTLINE_VARIABLE_LABOR": "一线作业弹性人工", "PACKAGING": "包装费", "RETURN_LOGISTICS": "退货物流费", "BILLABLE_EXCEPTION": "异常配送费"}
    factor_text = "；".join(f"{factor_cn[key]} {money(value)}" for key, value in gb_factor_values.items())
    monthly_saving_text = "；".join(
        f"{int(month[-2:])} 月 {money(d(monthly[('SCENARIO_COST_SAVING', month)]['total_cost_cny_high_precision']) - d(monthly[('FORECAST', month)]['total_cost_cny_high_precision']))}"
        for month in FUTURE_MONTHS
    )

    questions = [
        {
            "id": "E01", "category": "发生了什么", "question": "2026 年 8 月英国履约变动成本相对 Budget 偏差多少？",
            "standard_answer": f"范围：2026 年 8 月｜英国｜Actual vs Budget。Actual 履约变动成本为 {money(d(aug_actual_gb['variable_cost_cny_high_precision']))}，Budget 为 {money(d(aug_budget_gb['variable_cost_cny_high_precision']))}，不利差异为 {money(aug_gb_var)}。",
            "required_numbers": {"actual_variable_cost_cny": q4(d(aug_actual_gb["variable_cost_cny_high_precision"])), "budget_variable_cost_cny": q4(d(aug_budget_gb["variable_cost_cny_high_precision"])), "variance_cny": q4(aug_gb_var)},
            "evidence": ["country_summary|ACTUAL|2026-08|GB", "country_summary|BUDGET|2026-08|GB"],
        },
        {
            "id": "E02", "category": "发生了什么", "question": "2026 年 8 月公司物流总成本相对 Budget 偏差多少？",
            "standard_answer": f"范围：2026 年 8 月｜公司｜Actual vs Budget。物流总成本 Actual 为 {money(d(monthly[('ACTUAL','2026-08')]['total_cost_cny_high_precision']))}，Budget 为 {money(d(monthly[('BUDGET','2026-08')]['total_cost_cny_high_precision']))}，不利差异为 {money(aug_company_var)}。该口径包含履约变动成本和固定成本。",
            "required_numbers": {"actual_total_cost_cny": q4(d(monthly[("ACTUAL", "2026-08")]["total_cost_cny_high_precision"])), "budget_total_cost_cny": q4(d(monthly[("BUDGET", "2026-08")]["total_cost_cny_high_precision"])), "variance_cny": q4(aug_company_var)},
            "evidence": ["monthly_summary|ACTUAL|2026-08", "monthly_summary|BUDGET|2026-08"],
        },
        {
            "id": "E03", "category": "发生了什么", "question": "截至 2026 年 8 月，公司物流总成本率 Actual 与 Budget 分别是多少？",
            "standard_answer": f"范围：2026 年 1—8 月｜公司｜Actual vs Budget。Actual 公司物流总成本率为 {pct(cost_rate('ACTUAL', ACTUAL_MONTHS))}，Budget 为 {pct(cost_rate('BUDGET', ACTUAL_MONTHS))}，变化 {pp(cost_rate('ACTUAL', ACTUAL_MONTHS) - cost_rate('BUDGET', ACTUAL_MONTHS))}。",
            "required_numbers": {"actual_cost_rate": q4(cost_rate("ACTUAL", ACTUAL_MONTHS)), "budget_cost_rate": q4(cost_rate("BUDGET", ACTUAL_MONTHS))},
            "evidence": ["monthly_summary|ACTUAL|2026-01..2026-08", "monthly_summary|BUDGET|2026-01..2026-08"],
        },
        {
            "id": "E04", "category": "发生了什么", "question": "当前全年 Latest Outlook 相对年度 Budget 的物流总成本差异是多少？",
            "standard_answer": f"范围：2026 全年｜公司｜Latest Outlook vs Budget。Latest Outlook 为 {money(annual_latest)}，年度 Budget 为 {money(annual_budget)}，不利差异为 {money(annual_latest - annual_budget)}。Latest Outlook 由 1—8 月 Actual 与 9—12 月正式 Forecast 组成。",
            "required_numbers": {"latest_outlook_cny": q4(annual_latest), "budget_cny": q4(annual_budget), "variance_cny": q4(annual_latest - annual_budget)},
            "evidence": ["monthly_summary|LATEST_OUTLOOK|2026-01..2026-12", "monthly_summary|BUDGET|2026-01..2026-12"],
        },
        {
            "id": "E05", "category": "为什么发生", "question": "2026 年 8 月英国履约变动成本差异按五因素如何拆解？",
            "standard_answer": f"范围：2026 年 8 月｜英国｜Actual vs Budget｜连环替代。{factor_text}；五项合计 {money(sum(gb_factor_values.values(), Decimal('0')))}，与英国履约变动成本差异一致。固定替代顺序为量→结构→效率→价→汇率。",
            "required_numbers": {key.lower(): q4(value) for key, value in gb_factor_values.items()},
            "evidence": ["attribution_detail|ACTUAL_VS_BUDGET|2026-08|CHAIN|GB"],
        },
        {
            "id": "E06", "category": "为什么发生", "question": "2026 年 8 月英国最大的成本差异驱动是什么？",
            "standard_answer": f"最大驱动是结构因素，影响 {money(gb_factor_values['MIX'])}；其次是量因素 {money(gb_factor_values['VOLUME'])}。结构因素包含目的国、发货仓、承运商、运输方式和平均计费重量的组合变化。",
            "required_numbers": {"mix_cny": q4(gb_factor_values["MIX"]), "volume_cny": q4(gb_factor_values["VOLUME"])},
            "evidence": ["attribution_detail|ACTUAL_VS_BUDGET|2026-08|CHAIN|GB"],
        },
        {
            "id": "E07", "category": "为什么发生", "question": "2026 年 8 月英国空运和 Carrier C 占比发生了什么变化？",
            "standard_answer": f"英国空运包裹占比由 Budget 的 {pct(d(aug_budget_gb['air_package_share']))} 升至 Actual 的 {pct(d(aug_actual_gb['air_package_share']))}；Carrier C 包裹占比由 {pct(d(aug_budget_gb['carrier_c_package_share']))} 升至 {pct(d(aug_actual_gb['carrier_c_package_share']))}。这是已记录管理动作与结构差异的证据，但不能仅据相关性反推出未记录的因果。",
            "required_numbers": {"budget_air_share": q4(d(aug_budget_gb["air_package_share"])), "actual_air_share": q4(d(aug_actual_gb["air_package_share"])), "budget_carrier_c_share": q4(d(aug_budget_gb["carrier_c_package_share"])), "actual_carrier_c_share": q4(d(aug_actual_gb["carrier_c_package_share"]))},
            "evidence": ["country_summary|ACTUAL|2026-08|GB", "country_summary|BUDGET|2026-08|GB", "driver_facts|ACTUAL|2026-08|GB|management_action_note"],
        },
        {
            "id": "E08", "category": "为什么发生", "question": "2026 年 8 月哪个发货仓贡献了最大的履约变动成本不利差异？",
            "standard_answer": f"德国仓贡献最大，履约变动成本差异为 {money(warehouse_values['DE_FC'])}；法国仓为 {money(warehouse_values['FR_FC'])}。该比较只含可归属线路的履约变动成本，不把固定成本分摊到发货仓以外的维度。",
            "required_numbers": {"de_fc_variance_cny": q4(warehouse_values["DE_FC"]), "fr_fc_variance_cny": q4(warehouse_values["FR_FC"])},
            "evidence": ["cost_facts|ACTUAL/BUDGET|2026-08|fulfillment_center"],
        },
        {
            "id": "E09", "category": "为什么发生", "question": "2026 年 8 月英国哪一类履约变动成本的增量最大？",
            "standard_answer": f"增量最大的成本类别是{component_cn[largest_component]}，相对 Budget 增加 {money(component_values[largest_component])}。成本类别比较来自同一组英国线路成本事实。",
            "required_numbers": {"largest_component": largest_component, "variance_cny": q4(component_values[largest_component])},
            "evidence": ["cost_facts|ACTUAL/BUDGET|2026-08|GB|cost_component"],
        },
        {
            "id": "E10", "category": "为什么发生", "question": "2026 年 8 月英国准时履约率是否已经最终成熟？",
            "standard_answer": f"尚未最终成熟。当前英国准时履约率为 {pct(d(aug_actual_gb['on_time_rate']))}，服务成熟度为 {pct(d(aug_actual_gb['service_maturity_rate']))}。未到承诺截止日期的在途包裹不进入准时率分母，因此不得把当前结果表述为最终服务表现。",
            "required_numbers": {"on_time_rate": q4(d(aug_actual_gb["on_time_rate"])), "maturity_rate": q4(d(aug_actual_gb["service_maturity_rate"]))},
            "evidence": ["country_summary|ACTUAL|2026-08|GB", "service_facts|ACTUAL|2026-08|GB"],
        },
        {
            "id": "E11", "category": "未来会怎样", "question": "9—12 月正式 Forecast 的物流总成本相对 Budget 增加多少？",
            "standard_answer": f"范围：2026 年 9—12 月｜公司｜Forecast vs Budget。正式 Forecast 物流总成本为 {money(future_forecast)}，同期 Budget 为 {money(future_budget)}，不利差异为 {money(future_forecast - future_budget)}。",
            "required_numbers": {"forecast_cny": q4(future_forecast), "budget_cny": q4(future_budget), "variance_cny": q4(future_forecast - future_budget)},
            "evidence": ["monthly_summary|FORECAST|2026-09..2026-12", "monthly_summary|BUDGET|2026-09..2026-12"],
        },
        {
            "id": "E12", "category": "未来会怎样", "question": "全年 Latest Outlook 的物流总成本是多少，包含哪些期间？",
            "standard_answer": f"全年 Latest Outlook 为 {money(annual_latest)}，由 2026 年 1—8 月已结账 Actual 和 9—12 月正式 Forecast 组成；已结账 Actual 不被未来情景改写。",
            "required_numbers": {"latest_outlook_cny": q4(annual_latest)},
            "evidence": ["monthly_summary|LATEST_OUTLOOK|2026-01..2026-12", "metadata|latest_closed_month"],
        },
        {
            "id": "E13", "category": "未来会怎样", "question": "到 2026 年 12 月，英国正式 Forecast 的空运和 Carrier C 占比是否回到 Budget？",
            "standard_answer": f"没有完全回到 Budget。12 月英国 Forecast 空运占比为 {pct(d(country[('FORECAST','2026-12','GB')]['air_package_share']))}，Budget 为 {pct(d(country[('BUDGET','2026-12','GB')]['air_package_share']))}；Carrier C 占比为 {pct(d(country[('FORECAST','2026-12','GB')]['carrier_c_package_share']))}，Budget 为 {pct(d(country[('BUDGET','2026-12','GB')]['carrier_c_package_share']))}。",
            "required_numbers": {"forecast_air_share": q4(d(country[("FORECAST", "2026-12", "GB")]["air_package_share"])), "budget_air_share": q4(d(country[("BUDGET", "2026-12", "GB")]["air_package_share"])), "forecast_carrier_c_share": q4(d(country[("FORECAST", "2026-12", "GB")]["carrier_c_package_share"])), "budget_carrier_c_share": q4(d(country[("BUDGET", "2026-12", "GB")]["carrier_c_package_share"]))},
            "evidence": ["country_summary|FORECAST/BUDGET|2026-12|GB"],
        },
        {
            "id": "E14", "category": "未来会怎样", "question": "9—12 月固定成本 Forecast 相对 Budget 增加多少？",
            "standard_answer": f"9—12 月固定成本 Forecast 相对 Budget 增加 {money(future_fixed_var)}。固定成本单独展示，不进入量、结构、效率、价、汇率五因素归因。",
            "required_numbers": {"fixed_cost_variance_cny": q4(future_fixed_var)},
            "evidence": ["monthly_summary|FORECAST/BUDGET|2026-09..2026-12|fixed_cost"],
        },
        {
            "id": "E15", "category": "情景调整后会怎样", "question": "Growth Case 将英国 9—12 月订单量提高 10% 后，订单和物流总成本增加多少？",
            "standard_answer": f"相对正式 Forecast，英国 9—12 月各月订单量独立增加 10%，合计增加 {integer(growth_order_delta)} 单，不复利；公司物流总成本合计增加 {money(growth_cost_delta)}。",
            "required_numbers": {"incremental_orders": q4(growth_order_delta), "incremental_total_cost_cny": q4(growth_cost_delta)},
            "evidence": ["monthly_summary|SCENARIO_GROWTH/FORECAST|2026-09..2026-12"],
        },
        {
            "id": "E16", "category": "情景调整后会怎样", "question": "Cost Saving Case 相对正式 Forecast 可减少多少物流运行成本？",
            "standard_answer": f"2026 年 9—12 月 Cost Saving Case 相对正式 Forecast 减少物流运行成本 {money(abs(saving_delta))}。该结果不包含新增供应商、合同改造或一次性实施成本；本情景限定为现有线路内的结构调整。",
            "required_numbers": {"operating_cost_saving_cny": q4(abs(saving_delta))},
            "evidence": ["monthly_summary|SCENARIO_COST_SAVING/FORECAST|2026-09..2026-12", "driver_facts|capacity_assumption"],
        },
        {
            "id": "E17", "category": "情景调整后会怎样", "question": "Cost Saving Case 是否违反准时履约率要求，系统应如何处理？",
            "standard_answer": f"9—12 月预计准时履约率由正式 Forecast 的 {pct(forecast_ot)} 降至 {pct(saving_ot)}，变化 {pp(saving_ot - forecast_ot)}。这会触发服务软提示，但不阻止计算；用户仍可保留或进一步设计极端情景。承运商承接能力另标记为未验证。",
            "required_numbers": {"forecast_on_time_rate": q4(forecast_ot), "scenario_on_time_rate": q4(saving_ot), "change_pp": q4((saving_ot - forecast_ot) * Decimal("100"))},
            "evidence": ["monthly_summary|SCENARIO_COST_SAVING/FORECAST|2026-09..2026-12|on_time_rate", "decision|D-034", "decision|D-085"],
        },
        {
            "id": "E18", "category": "情景调整后会怎样", "question": "Cost Saving Case 的月度实施节奏和每月成本影响是什么？",
            "standard_answer": f"相对正式 Forecast 的月度影响为：{monthly_saving_text}。9 月是准备期，10 月部分调整，11—12 月达到目标结构。负数表示成本下降。",
            "required_numbers": {month: q4(d(monthly[("SCENARIO_COST_SAVING", month)]["total_cost_cny_high_precision"]) - d(monthly[("FORECAST", month)]["total_cost_cny_high_precision"])) for month in FUTURE_MONTHS},
            "evidence": ["monthly_summary|SCENARIO_COST_SAVING/FORECAST|2026-09..2026-12", "scenario_note|COST_SAVING"],
        },
        {
            "id": "E19", "category": "数据不足与越界保护", "question": "能否根据当前数据确认 Carrier A 和 Carrier B 一定有足够容量承接 Cost Saving Case 的份额？",
            "standard_answer": "不能确认。MVP 暂时假设有效线路承载能力无限，只用于完成数学情景计算；当前没有规划容量、最低承诺量、合同配额或供应商确认数据。结果必须标记“承运商承接能力未验证”，不得断言方案可以直接执行。",
            "required_numbers": {},
            "evidence": ["driver_facts|capacity_assumption=UNVERIFIED_UNLIMITED_FOR_MVP", "decision|D-085"],
            "hard_guardrail": "不得编造容量或供应商承诺",
        },
        {
            "id": "E20", "category": "数据不足与越界保护", "question": "请列出 2026 年 8 月英国每个订单的物流成本，并找出最贵的 10 单。",
            "standard_answer": "无法提供。MVP 事实粒度是“月 × 目的国 × 发货仓 × 承运商 × 运输方式”，没有订单级收入、成本或订单—包裹关联。可以提供英国线路层的成本下钻，但不得虚构订单级明细或 Top 10 订单。",
            "required_numbers": {},
            "evidence": ["metadata|grain", "decision|D-003", "decision|D-090"],
            "hard_guardrail": "不得虚构订单级事实",
        },
    ]

    output = {
        "evaluation_set_id": "LOGIPLAN_AI_EVAL_ZH_V1", "dataset_id": data["metadata"]["dataset_id"],
        "data_version": "2026-08 close", "question_count": 20,
        "cost_model_revision": data["metadata"]["cost_model_revision"],
        "source_workbook": data["metadata"]["source_workbook"],
        "source_workbook_sha256": data["metadata"]["source_workbook_sha256"],
        "category_quota": {"发生了什么": 4, "为什么发生": 6, "未来会怎样": 4, "情景调整后会怎样": 4, "数据不足与越界保护": 2},
        "pass_rule": {"minimum_passed": 18, "numeric_exact_match": True, "boundary_questions_must_all_pass": True, "hard_failures": ["编造数字", "虚假证据", "把相关性写成确定因果"]},
        "questions": questions,
    }
    JSON_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# LogiPlan AI 固定评估集与标准答案", "", "版本：V1.1  ", "日期：2026-08-14  ",
        "数据版本：LOGIPLAN_2026_DEMO_V1 / 2026 年 8 月结账 / D-092  ",
        f"审计来源：`{data['metadata']['source_workbook']}`  ",
        f"来源 SHA-256：`{data['metadata']['source_workbook_sha256']}`  ",
        "状态：已生成并与当前人工拆分口径的审计工作簿对齐", "",
        "通过门槛：至少 18/20；两道越界题必须全部通过；程序计算数字必须精确一致；出现编造数字、虚假证据或把相关性写成确定因果时整体失败。", "",
    ]
    current_category = None
    for item in questions:
        if item["category"] != current_category:
            current_category = item["category"]
            lines.extend([f"## {current_category}", ""])
        lines.extend([f"### {item['id']}：{item['question']}", "", item["standard_answer"], "", f"证据：`{'`、`'.join(item['evidence'])}`", ""])
    DOC_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"generated {JSON_PATH}")
    print(f"generated {DOC_PATH}")


if __name__ == "__main__":
    main()
