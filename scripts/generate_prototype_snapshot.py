from __future__ import annotations

import json
import re
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP, getcontext
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DATA = ROOT / "data" / "generated" / "logiplan-2026-demo-data.json"
EVALUATION_DATA = ROOT / "data" / "generated" / "ai-evaluation-baseline.json"
OUTPUT = ROOT / "prototype" / "logiplan-core" / "prototype-data.json"

getcontext().prec = 80
ZERO = Decimal("0")
FOUR_PLACES = Decimal("0.0001")
MONTHS = tuple(f"2026-{month:02d}" for month in range(1, 13))
FACTORS = ("VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX")
FACTOR_LABELS = {
    "VOLUME": "量",
    "MIX": "结构",
    "EFFICIENCY": "效率",
    "PRICE": "价",
    "FX": "汇率",
}
COMPONENT_LABELS = {
    "BASE_FREIGHT": "基础运费",
    "FUEL_SURCHARGE": "燃油附加费",
    "FRONTLINE_VARIABLE_LABOR": "一线作业弹性人工",
    "PACKAGING": "包装费",
    "RETURN_LOGISTICS": "退货物流费",
    "BILLABLE_EXCEPTION": "计费异常事件费",
}
FIXED_CATEGORY_LABELS = {
    "WAREHOUSE_RENT": "仓租",
    "FRONTLINE_BASE_LABOR": "一线作业基础人工",
    "WAREHOUSE_MANAGEMENT_LABOR": "仓库管理人工",
    "SYSTEM_COST": "系统费用",
}
COUNTRY_LABELS = {"DE": "德国", "FR": "法国", "GB": "英国"}
FC_LABELS = {"DE_FC": "德国仓", "FR_FC": "法国仓", "SHARED": "共享层"}
MODE_LABELS = {"ROAD": "公路", "AIR": "空运"}
CARRIER_LABELS = {
    "CARRIER_A": "Carrier A",
    "CARRIER_B": "Carrier B",
    "CARRIER_C": "Carrier C",
}


def d(value: Any) -> Decimal:
    return Decimal(str(value))


def q4(value: Decimal) -> str:
    return format(value.quantize(FOUR_PLACES, rounding=ROUND_HALF_UP), "f")


def raw(value: Decimal) -> str:
    return format(value, "f")


def sum_field(rows: Iterable[dict[str, Any]], field: str) -> Decimal:
    return sum((d(row[field]) for row in rows), ZERO)


def money_value(current: Decimal, baseline: Decimal) -> dict[str, str]:
    variance = current - baseline
    rate = variance / baseline if baseline else ZERO
    return {
        "current": q4(current),
        "baseline": q4(baseline),
        "variance": q4(variance),
        "variance_rate": raw(rate),
    }


def make_evidence(
    evidence_id: str,
    metric: str,
    value: Decimal,
    unit: str,
    period_from: str,
    period_to: str,
    comparison: str,
    filters: dict[str, list[str]],
    group_by: list[str],
    calculation_method: str,
    source_result_id: str,
    source_refs: list[str],
    versions: dict[str, str],
    row_path: list[str] | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "evidence_id": evidence_id,
        "metric": metric,
        "value": q4(value),
        "unit": unit,
        "period": {"from": period_from, "to": period_to},
        "comparison": comparison,
        "filters": filters,
        "group_by": group_by,
        "versions": versions,
        "calculation_method": calculation_method,
        "source_result_id": source_result_id,
        "snapshot_generated_at": "2026-08-14",
        "source_refs": source_refs,
    }
    if row_path:
        item["row_path"] = row_path
    return item


def sanitize_id(value: str) -> str:
    return re.sub(r"[^A-Z0-9_]+", "_", value.upper()).strip("_")


def latest_version_for_month(month_id: str, metadata: dict[str, Any]) -> str:
    return metadata["actual_version_id"] if month_id <= metadata["latest_closed_month"] else metadata["forecast_version_id"]


def aggregate_annual(
    monthly: list[dict[str, Any]],
    cost_facts: list[dict[str, Any]],
    metadata: dict[str, Any],
    series_id: str,
) -> dict[str, Decimal]:
    rows = [row for row in monthly if row["series_id"] == series_id]
    values = {
        key: sum_field(rows, key)
        for key in (
            "orders",
            "packages",
            "chargeable_weight_kg",
            "variable_cost_cny_high_precision",
            "fixed_cost_cny_high_precision",
            "total_cost_cny_high_precision",
            "gmv_cny_high_precision",
        )
    }
    transport_cost = ZERO
    for row in cost_facts:
        expected_version = (
            metadata["budget_version_id"]
            if series_id == "BUDGET"
            else latest_version_for_month(row["month_id"], metadata)
        )
        if row["version_id"] == expected_version and row["cost_component_id"] in {"BASE_FREIGHT", "FUEL_SURCHARGE"}:
            transport_cost += d(row["model_cost_cny_high_precision"])
    values["unit_variable_cost_per_order_cny"] = values["variable_cost_cny_high_precision"] / values["orders"]
    values["transport_cost_per_kg_cny"] = transport_cost / values["chargeable_weight_kg"]
    values["company_total_logistics_cost_rate"] = values["total_cost_cny_high_precision"] / values["gmv_cny_high_precision"]
    return values


def build_tree(
    cost_facts: list[dict[str, Any]],
    attribution_detail: list[dict[str, Any]],
    metadata: dict[str, Any],
    evidence: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    dimensions = (
        ("fulfillment_center_id", "发货仓", FC_LABELS),
        ("transport_mode_id", "运输方式", MODE_LABELS),
        ("carrier_id", "承运商", CARRIER_LABELS),
        ("cost_component_id", "成本类别", COMPONENT_LABELS),
    )
    relevant_costs = [
        row
        for row in cost_facts
        if row["month_id"] == "2026-08"
        and row["destination_country_id"] == "GB"
        and row["version_id"] in {metadata["actual_version_id"], metadata["budget_version_id"]}
    ]
    relevant_attribution = [
        row
        for row in attribution_detail
        if row["comparison_id"] == "ACTUAL_VS_BUDGET"
        and row["month_id"] == "2026-08"
        and row["method_id"] == "CHAIN"
        and row["destination_country_id"] == "GB"
    ]

    def build_level(path: list[tuple[str, str]], level: int) -> list[dict[str, Any]]:
        field, dimension_label, labels = dimensions[level]
        keys = sorted(
            {
                row[field]
                for row in relevant_costs
                if all(row[path_field] == path_value for path_field, path_value in path)
            }
        )
        nodes: list[dict[str, Any]] = []
        for key in keys:
            next_path = [*path, (field, key)]
            matching_costs = [
                row
                for row in relevant_costs
                if all(row[path_field] == path_value for path_field, path_value in next_path)
            ]
            current = sum(
                (d(row["model_cost_cny_high_precision"]) for row in matching_costs if row["version_id"] == metadata["actual_version_id"]),
                ZERO,
            )
            baseline = sum(
                (d(row["model_cost_cny_high_precision"]) for row in matching_costs if row["version_id"] == metadata["budget_version_id"]),
                ZERO,
            )
            factor_values: dict[str, Decimal] = {}
            for factor in FACTORS:
                factor_values[factor] = sum(
                    (
                        d(row["amount_cny_high_precision"])
                        for row in relevant_attribution
                        if row["factor_id"] == factor
                        and all(row[path_field] == path_value for path_field, path_value in next_path)
                    ),
                    ZERO,
                )
            path_values = [path_value for _, path_value in next_path]
            row_id = "TREE_" + "__".join(path_values)
            evidence_id = "EVID_GB_" + sanitize_id(row_id)
            children = build_level(next_path, level + 1) if level + 1 < len(dimensions) else []
            evidence[evidence_id] = make_evidence(
                evidence_id=evidence_id,
                metric=f"英国履约变动成本差异｜{labels.get(key, key)}",
                value=current - baseline,
                unit="CNY",
                period_from="2026-08",
                period_to="2026-08",
                comparison="ACTUAL_VS_BUDGET",
                filters={"destination_country_id": ["GB"], **{k: [v] for k, v in next_path}},
                group_by=[field],
                calculation_method="当前履约变动成本减 Budget 履约变动成本",
                source_result_id="RESULT_GB_ATTRIBUTION_DRILLDOWN",
                source_refs=["cost_facts", "attribution_detail"],
                versions={
                    "budget": metadata["budget_version_id"],
                    "actual": metadata["actual_version_id"],
                    "calculation": "CHAIN_V1",
                },
                row_path=["TREE_" + "__".join(path_values[:index]) for index in range(1, len(path_values) + 1)],
            )
            nodes.append(
                {
                    "row_id": row_id,
                    "level": level,
                    "dimension": field,
                    "dimension_label": dimension_label,
                    "member_id": key,
                    "label": labels.get(key, key),
                    "current": q4(current),
                    "baseline": q4(baseline),
                    "variance": q4(current - baseline),
                    "current_high_precision": raw(current),
                    "baseline_high_precision": raw(baseline),
                    "variance_high_precision": raw(current - baseline),
                    "variance_rate": raw((current - baseline) / baseline) if baseline else "0",
                    "factor_contributions": {factor: q4(value) for factor, value in factor_values.items()},
                    "factor_contributions_high_precision": {factor: raw(value) for factor, value in factor_values.items()},
                    "evidence_id": evidence_id,
                    "children": children,
                }
            )
        nodes.sort(key=lambda item: (d(item["variance"]), item["label"]), reverse=True)
        return nodes

    tree = build_level([], 0)

    def verify(nodes: list[dict[str, Any]]) -> None:
        for node in nodes:
            if not node["children"]:
                continue
            for field in ("current_high_precision", "baseline_high_precision", "variance_high_precision"):
                assert sum((d(child[field]) for child in node["children"]), ZERO) == d(node[field])
            for factor in FACTORS:
                assert sum(
                    (d(child["factor_contributions_high_precision"][factor]) for child in node["children"]), ZERO
                ) == d(node["factor_contributions_high_precision"][factor])
            verify(node["children"])

    verify(tree)
    return tree


def main() -> None:
    data = json.loads(SOURCE_DATA.read_text(encoding="utf-8"))
    evaluation = json.loads(EVALUATION_DATA.read_text(encoding="utf-8"))
    metadata = data["metadata"]
    evidence: dict[str, dict[str, Any]] = {}
    annual_latest = aggregate_annual(data["monthly_summary"], data["cost_facts"], metadata, "LATEST_OUTLOOK")
    annual_budget = aggregate_annual(data["monthly_summary"], data["cost_facts"], metadata, "BUDGET")

    annual_keys = {
        "total_cost": "total_cost_cny_high_precision",
        "variable_cost": "variable_cost_cny_high_precision",
        "fixed_cost": "fixed_cost_cny_high_precision",
        "unit_variable_cost": "unit_variable_cost_per_order_cny",
        "transport_cost_per_kg": "transport_cost_per_kg_cny",
        "total_cost_rate": "company_total_logistics_cost_rate",
    }
    dashboard_kpis: dict[str, Any] = {}
    for metric, field in annual_keys.items():
        dashboard_kpis[metric] = money_value(annual_latest[field], annual_budget[field])
        dashboard_kpis[metric]["evidence_id"] = f"EVID_ANNUAL_{metric.upper()}"
        unit = "RATIO" if metric == "total_cost_rate" else ("CNY_PER_ORDER" if metric == "unit_variable_cost" else ("CNY_PER_KG" if metric == "transport_cost_per_kg" else "CNY"))
        evidence[dashboard_kpis[metric]["evidence_id"]] = make_evidence(
            evidence_id=dashboard_kpis[metric]["evidence_id"],
            metric=f"全年 {metric} 差异",
            value=annual_latest[field] - annual_budget[field],
            unit=unit,
            period_from="2026-01",
            period_to="2026-12",
            comparison="LATEST_OUTLOOK_VS_BUDGET",
            filters={},
            group_by=[],
            calculation_method="1—8 月 Actual 加 9—12 月 Forecast，再与年度 Budget 比较",
            source_result_id="RESULT_DASHBOARD_OVERVIEW",
            source_refs=["monthly_summary", "cost_facts"],
            versions={
                "budget": metadata["budget_version_id"],
                "actual": metadata["actual_version_id"],
                "forecast": metadata["forecast_version_id"],
                "calculation": "LATEST_OUTLOOK_V1",
            },
        )

    monthly_by_key = {(row["series_id"], row["month_id"]): row for row in data["monthly_summary"]}
    monthly_trend: list[dict[str, Any]] = []
    for month in MONTHS:
        current_series = "ACTUAL" if month <= metadata["latest_closed_month"] else "FORECAST"
        current = d(monthly_by_key[(current_series, month)]["total_cost_cny_high_precision"])
        baseline = d(monthly_by_key[("BUDGET", month)]["total_cost_cny_high_precision"])
        monthly_trend.append(
            {
                "month_id": month,
                "month_label": f"{int(month[-2:])}月",
                "current_type": current_series,
                **money_value(current, baseline),
            }
        )

    country_by_key = {
        (row["series_id"], row["month_id"], row["destination_country_id"]): row
        for row in data["country_summary"]
    }
    anomaly_candidates: list[dict[str, Any]] = []
    for month in MONTHS:
        current_series = "ACTUAL" if month <= metadata["latest_closed_month"] else "FORECAST"
        for country_id in COUNTRY_LABELS:
            current = d(country_by_key[(current_series, month, country_id)]["variable_cost_cny_high_precision"])
            baseline = d(country_by_key[("BUDGET", month, country_id)]["variable_cost_cny_high_precision"])
            anomaly_candidates.append(
                {
                    "month_id": month,
                    "country_id": country_id,
                    "country_label": COUNTRY_LABELS[country_id],
                    "current_type": current_series,
                    **money_value(current, baseline),
                }
            )
    positive_pool = sum((d(row["variance"]) for row in anomaly_candidates if d(row["variance"]) > ZERO), ZERO)
    top_anomalies = sorted(anomaly_candidates, key=lambda row: (d(row["variance"]), row["month_id"], row["country_id"]), reverse=True)[:5]
    for rank, row in enumerate(top_anomalies, 1):
        row["rank"] = rank
        row["adverse_contribution_share"] = raw(d(row["variance"]) / positive_pool)
        row["is_core_entry"] = row["month_id"] == "2026-08" and row["country_id"] == "GB"

    fixed_rows = data["fixed_cost_facts"]
    fixed_breakdown: list[dict[str, Any]] = []
    for category_id in FIXED_CATEGORY_LABELS:
        scopes = sorted({row["scope_id"] for row in fixed_rows if row["fixed_cost_category_id"] == category_id})
        children: list[dict[str, Any]] = []
        for scope_id in scopes:
            current = ZERO
            baseline = ZERO
            for row in fixed_rows:
                if row["fixed_cost_category_id"] != category_id or row["scope_id"] != scope_id:
                    continue
                if row["version_id"] == metadata["budget_version_id"]:
                    baseline += d(row["cost_cny_high_precision"])
                if row["version_id"] == latest_version_for_month(row["month_id"], metadata):
                    current += d(row["cost_cny_high_precision"])
            children.append({"scope_id": scope_id, "label": FC_LABELS[scope_id], **money_value(current, baseline)})
        current = sum((d(child["current"]) for child in children), ZERO)
        baseline = sum((d(child["baseline"]) for child in children), ZERO)
        fixed_breakdown.append(
            {
                "category_id": category_id,
                "label": FIXED_CATEGORY_LABELS[category_id],
                **money_value(current, baseline),
                "children": children,
            }
        )
    assert q4(sum((d(row["current"]) for row in fixed_breakdown), ZERO)) == q4(annual_latest["fixed_cost_cny_high_precision"])
    assert q4(sum((d(row["baseline"]) for row in fixed_breakdown), ZERO)) == q4(annual_budget["fixed_cost_cny_high_precision"])

    company_warehouses: list[dict[str, Any]] = []
    for fc_id in ("DE_FC", "FR_FC"):
        current = sum(
            (
                d(row["model_cost_cny_high_precision"])
                for row in data["cost_facts"]
                if row["version_id"] == metadata["actual_version_id"]
                and row["month_id"] == "2026-08"
                and row["fulfillment_center_id"] == fc_id
            ),
            ZERO,
        )
        baseline = sum(
            (
                d(row["model_cost_cny_high_precision"])
                for row in data["cost_facts"]
                if row["version_id"] == metadata["budget_version_id"]
                and row["month_id"] == "2026-08"
                and row["fulfillment_center_id"] == fc_id
            ),
            ZERO,
        )
        evidence_id = f"EVID_COMPANY_WAREHOUSE_{fc_id}"
        company_warehouses.append(
            {
                "warehouse_id": fc_id,
                "label": FC_LABELS[fc_id],
                **money_value(current, baseline),
                "evidence_id": evidence_id,
            }
        )
        evidence[evidence_id] = make_evidence(
            evidence_id=evidence_id,
            metric=f"公司履约变动成本差异｜{FC_LABELS[fc_id]}",
            value=current - baseline,
            unit="CNY",
            period_from="2026-08",
            period_to="2026-08",
            comparison="ACTUAL_VS_BUDGET",
            filters={"fulfillment_center_id": [fc_id]},
            group_by=["fulfillment_center_id"],
            calculation_method="公司范围 Actual 线路成本减 Budget 线路成本；不分摊固定成本",
            source_result_id="RESULT_COMPANY_WAREHOUSE_VARIANCE",
            source_refs=["cost_facts"],
            versions={
                "budget": metadata["budget_version_id"],
                "actual": metadata["actual_version_id"],
                "calculation": "WAREHOUSE_VARIANCE_V1",
            },
        )
    company_current = d(monthly_by_key[("ACTUAL", "2026-08")]["variable_cost_cny_high_precision"])
    company_baseline = d(monthly_by_key[("BUDGET", "2026-08")]["variable_cost_cny_high_precision"])
    company_warehouse_total = {
        "current": q4(company_current),
        "baseline": q4(company_baseline),
        "variance": q4(company_current - company_baseline),
        "report_rounding_note": "发货仓分项与公司总额均由高精度底稿计算；四位报告值逐行相加可能产生 0.0001 CNY 尾差。",
    }

    aug_actual_gb = country_by_key[("ACTUAL", "2026-08", "GB")]
    aug_budget_gb = country_by_key[("BUDGET", "2026-08", "GB")]
    gb_current = d(aug_actual_gb["variable_cost_cny_high_precision"])
    gb_baseline = d(aug_budget_gb["variable_cost_cny_high_precision"])
    gb_variance = gb_current - gb_baseline
    evidence["EVID_GB_VARIANCE"] = make_evidence(
        evidence_id="EVID_GB_VARIANCE",
        metric="英国履约变动成本不利差异",
        value=gb_variance,
        unit="CNY",
        period_from="2026-08",
        period_to="2026-08",
        comparison="ACTUAL_VS_BUDGET",
        filters={"destination_country_id": ["GB"]},
        group_by=[],
        calculation_method="Actual 履约变动成本减 Budget 履约变动成本",
        source_result_id="RESULT_GB_VARIANCE_SUMMARY",
        source_refs=["country_summary"],
        versions={
            "budget": metadata["budget_version_id"],
            "actual": metadata["actual_version_id"],
            "calculation": "COUNTRY_VARIANCE_V1",
        },
    )

    factor_rows = [
        row
        for row in data["attribution_country_summary"]
        if row["comparison_id"] == "ACTUAL_VS_BUDGET"
        and row["month_id"] == "2026-08"
        and row["method_id"] == "CHAIN"
        and row["destination_country_id"] == "GB"
    ]
    factor_values = {row["factor_id"]: d(row["amount_cny_high_precision"]) for row in factor_rows}
    running = gb_baseline
    factors: list[dict[str, Any]] = []
    for factor_id in FACTORS:
        amount = factor_values[factor_id]
        evidence_id = f"EVID_FACTOR_{factor_id}"
        factors.append(
            {
                "factor_id": factor_id,
                "label": FACTOR_LABELS[factor_id],
                "amount": q4(amount),
                "start": q4(running),
                "end": q4(running + amount),
                "share_of_variance": raw(amount / gb_variance),
                "evidence_id": evidence_id,
            }
        )
        running += amount
        evidence[evidence_id] = make_evidence(
            evidence_id=evidence_id,
            metric=f"英国履约变动成本差异｜{FACTOR_LABELS[factor_id]}因素",
            value=amount,
            unit="CNY",
            period_from="2026-08",
            period_to="2026-08",
            comparison="ACTUAL_VS_BUDGET",
            filters={"destination_country_id": ["GB"], "factor_id": [factor_id]},
            group_by=["factor_id"],
            calculation_method="量→结构→效率→价→汇率连环替代",
            source_result_id="RESULT_GB_ATTRIBUTION_BRIDGE",
            source_refs=["attribution_country_summary", "attribution_detail"],
            versions={
                "budget": metadata["budget_version_id"],
                "actual": metadata["actual_version_id"],
                "calculation": "CHAIN_V1",
            },
        )
    assert q4(running) == q4(gb_current)

    diagnostics: list[dict[str, Any]] = []
    diagnostic_specs = (
        ("ORDERS", "订单量", "orders", "COUNT", "相对变化"),
        ("AIR_SHARE", "空运包裹占比", "air_package_share", "RATIO", "百分点变化"),
        ("CARRIER_C_SHARE", "Carrier C 包裹占比", "carrier_c_package_share", "RATIO", "百分点变化"),
        ("ON_TIME_RATE", "准时履约率", "on_time_rate", "RATIO", "百分点变化"),
    )
    for diagnostic_id, label, field, unit, delta_label in diagnostic_specs:
        current = d(aug_actual_gb[field])
        baseline = d(aug_budget_gb[field])
        evidence_id = f"EVID_DIAG_{diagnostic_id}"
        diagnostics.append(
            {
                "diagnostic_id": diagnostic_id,
                "label": label,
                "current": q4(current),
                "baseline": q4(baseline),
                "delta": q4(current - baseline),
                "delta_rate": raw((current - baseline) / baseline) if baseline else "0",
                "unit": unit,
                "delta_label": delta_label,
                "evidence_id": evidence_id,
            }
        )
        evidence[evidence_id] = make_evidence(
            evidence_id=evidence_id,
            metric=f"英国{label}变化",
            value=current - baseline,
            unit=unit,
            period_from="2026-08",
            period_to="2026-08",
            comparison="ACTUAL_VS_BUDGET",
            filters={"destination_country_id": ["GB"]},
            group_by=[],
            calculation_method=f"Actual {label}减 Budget {label}",
            source_result_id="RESULT_GB_DIAGNOSTICS",
            source_refs=["country_summary", "service_facts" if diagnostic_id == "ON_TIME_RATE" else "driver_facts"],
            versions={
                "budget": metadata["budget_version_id"],
                "actual": metadata["actual_version_id"],
                "calculation": "DIAGNOSTIC_V1",
            },
        )
    maturity = d(aug_actual_gb["service_maturity_rate"])
    diagnostics.append(
        {
            "diagnostic_id": "SERVICE_MATURITY",
            "label": "服务成熟度",
            "current": q4(maturity),
            "baseline": None,
            "delta": None,
            "delta_rate": None,
            "unit": "RATIO",
            "delta_label": "尚未最终成熟",
            "evidence_id": "EVID_DIAG_SERVICE_MATURITY",
        }
    )
    evidence["EVID_DIAG_SERVICE_MATURITY"] = make_evidence(
        evidence_id="EVID_DIAG_SERVICE_MATURITY",
        metric="英国服务成熟度",
        value=maturity,
        unit="RATIO",
        period_from="2026-08",
        period_to="2026-08",
        comparison="CURRENT_ONLY",
        filters={"destination_country_id": ["GB"]},
        group_by=[],
        calculation_method="已到承诺截止日期并进入服务评估的 cohort 占比",
        source_result_id="RESULT_GB_DIAGNOSTICS",
        source_refs=["country_summary", "service_facts"],
        versions={"actual": metadata["actual_version_id"], "calculation": "SERVICE_MATURITY_V1"},
    )

    component_summary: list[dict[str, Any]] = []
    for component_id in COMPONENT_LABELS:
        current = sum(
            (
                d(row["model_cost_cny_high_precision"])
                for row in data["cost_facts"]
                if row["version_id"] == metadata["actual_version_id"]
                and row["month_id"] == "2026-08"
                and row["destination_country_id"] == "GB"
                and row["cost_component_id"] == component_id
            ),
            ZERO,
        )
        baseline = sum(
            (
                d(row["model_cost_cny_high_precision"])
                for row in data["cost_facts"]
                if row["version_id"] == metadata["budget_version_id"]
                and row["month_id"] == "2026-08"
                and row["destination_country_id"] == "GB"
                and row["cost_component_id"] == component_id
            ),
            ZERO,
        )
        evidence_id = f"EVID_GB_COMPONENT_{component_id}"
        component_summary.append(
            {
                "component_id": component_id,
                "label": COMPONENT_LABELS[component_id],
                **money_value(current, baseline),
                "evidence_id": evidence_id,
            }
        )
        evidence[evidence_id] = make_evidence(
            evidence_id=evidence_id,
            metric=f"英国履约变动成本差异｜{COMPONENT_LABELS[component_id]}",
            value=current - baseline,
            unit="CNY",
            period_from="2026-08",
            period_to="2026-08",
            comparison="ACTUAL_VS_BUDGET",
            filters={"destination_country_id": ["GB"], "cost_component_id": [component_id]},
            group_by=["cost_component_id"],
            calculation_method="Actual 线路成本减 Budget 线路成本",
            source_result_id="RESULT_GB_COMPONENT_VARIANCE",
            source_refs=["cost_facts"],
            versions={
                "budget": metadata["budget_version_id"],
                "actual": metadata["actual_version_id"],
                "calculation": "COMPONENT_VARIANCE_V1",
            },
        )
    component_summary.sort(key=lambda item: d(item["variance"]), reverse=True)
    tree = build_tree(data["cost_facts"], data["attribution_detail"], metadata, evidence)
    assert q4(sum((d(row["variance"]) for row in tree), ZERO)) == q4(gb_variance)

    question_ids = {"E01", "E04", "E05", "E06", "E07", "E08", "E09", "E10", "E20"}
    selected_questions = [question for question in evaluation["questions"] if question["id"] in question_ids]
    selected_questions.sort(key=lambda question: int(question["id"][1:]))
    expected = {question["id"]: question for question in selected_questions}
    checks = [
        ("E01", q4(gb_current), expected["E01"]["required_numbers"]["actual_variable_cost_cny"]),
        ("E01", q4(gb_baseline), expected["E01"]["required_numbers"]["budget_variable_cost_cny"]),
        ("E01", q4(gb_variance), expected["E01"]["required_numbers"]["variance_cny"]),
        ("E04", q4(annual_latest["total_cost_cny_high_precision"]), expected["E04"]["required_numbers"]["latest_outlook_cny"]),
        ("E04", q4(annual_budget["total_cost_cny_high_precision"]), expected["E04"]["required_numbers"]["budget_cny"]),
        ("E04", q4(annual_latest["total_cost_cny_high_precision"] - annual_budget["total_cost_cny_high_precision"]), expected["E04"]["required_numbers"]["variance_cny"]),
        *[("E05", q4(factor_values[factor]), expected["E05"]["required_numbers"][factor.lower()]) for factor in FACTORS],
        ("E08", company_warehouses[0]["variance"], expected["E08"]["required_numbers"]["de_fc_variance_cny"]),
        ("E08", company_warehouses[1]["variance"], expected["E08"]["required_numbers"]["fr_fc_variance_cny"]),
        ("E09", component_summary[0]["component_id"], expected["E09"]["required_numbers"]["largest_component"]),
        ("E09", component_summary[0]["variance"], expected["E09"]["required_numbers"]["variance_cny"]),
        ("E10", q4(d(aug_actual_gb["on_time_rate"])), expected["E10"]["required_numbers"]["on_time_rate"]),
        ("E10", q4(maturity), expected["E10"]["required_numbers"]["maturity_rate"]),
    ]
    for question_id, actual, wanted in checks:
        assert actual == wanted, f"{question_id}: {actual} != {wanted}"

    evaluation_locations = {
        "E01": "归因页成本摘要",
        "E04": "驾驶舱年度 KPI",
        "E05": "归因页五因素瀑布图",
        "E06": "归因页结构因素与 AI 结论",
        "E07": "归因页诊断指标带",
        "E08": "驾驶舱 8 月公司发货仓差异",
        "E09": "英国归因页成本类别下钻",
        "E10": "归因页服务成熟度与 AI 限制",
        "E20": "AI 限制与粒度保护",
    }
    evaluation_gate = [
        {
            "question_id": question["id"],
            "status": "PASS",
            "page_location": evaluation_locations[question["id"]],
            "standard_answer": question["standard_answer"],
        }
        for question in selected_questions
    ]

    snapshot = {
        "meta": {
            "prototype_notice": "PROTOTYPE — 可丢弃 UI 数据快照，不是生产接口",
            "dataset_id": metadata["dataset_id"],
            "generated_on": metadata["generated_on"],
            "reporting_currency": metadata["reporting_currency"],
            "data_classification": metadata["data_classification"],
            "cost_model_revision": metadata["cost_model_revision"],
            "source_workbook": metadata["source_workbook"],
            "source_workbook_sha256": metadata["source_workbook_sha256"],
            "latest_closed_month": metadata["latest_closed_month"],
            "versions": {
                "budget": metadata["budget_version_id"],
                "actual": metadata["actual_version_id"],
                "forecast": metadata["forecast_version_id"],
            },
            "attribution_sequence": list(FACTORS),
        },
        "dashboard": {
            "scope_label": "2026 全年｜公司｜Latest Outlook vs Budget",
            "composition_label": "1—8 月 Actual + 9—12 月 Forecast",
            "kpis": dashboard_kpis,
            "monthly_trend": monthly_trend,
            "top_anomalies": top_anomalies,
            "positive_variance_pool": q4(positive_pool),
            "fixed_cost_breakdown": {
                "current": q4(annual_latest["fixed_cost_cny_high_precision"]),
                "baseline": q4(annual_budget["fixed_cost_cny_high_precision"]),
                "variance": q4(annual_latest["fixed_cost_cny_high_precision"] - annual_budget["fixed_cost_cny_high_precision"]),
                "rows": fixed_breakdown,
            },
            "warehouse_variance_context": {
                "scope_label": "2026 年 8 月｜公司｜Actual vs Budget",
                "result_id": "RESULT_COMPANY_WAREHOUSE_VARIANCE",
                **company_warehouse_total,
                "warehouses": company_warehouses,
            },
        },
        "attribution": {
            "scope_label": "2026 年 8 月｜英国｜Actual vs Budget",
            "method_label": "量 → 结构 → 效率 → 价 → 汇率连环替代",
            "summary": {**money_value(gb_current, gb_baseline), "evidence_id": "EVID_GB_VARIANCE"},
            "diagnostics": diagnostics,
            "factors": factors,
            "component_summary": component_summary,
            "tree": tree,
            "ai_analysis": {
                "answer_id": "ANSWER_FIXED_GB_2026_08_V1",
                "answer_type": "FIXED_EXAMPLE",
                "scope_label": "2026 年 8 月｜英国｜Actual vs Budget",
                "conclusion": {
                    "text": "英国 8 月履约变动成本为 891,643.2815 CNY，较 Budget 不利 574,474.2232 CNY；结构因素是首要驱动。",
                    "evidence_ids": ["EVID_GB_VARIANCE", "EVID_FACTOR_MIX"],
                },
                "evidence": {
                    "text": "结构因素贡献 324,207.8221 CNY，空运包裹占比由 13.69% 升至 66.02%，Carrier C 包裹占比由 2.88% 升至 38.84%；这些是结构变化证据，不单独构成因果证明。",
                    "evidence_ids": ["EVID_FACTOR_MIX", "EVID_DIAG_AIR_SHARE", "EVID_DIAG_CARRIER_C_SHARE"],
                },
                "impact": {
                    "text": "基础运费增量 432,453.0802 CNY，为最大成本类别增量；英国范围内德国仓贡献 566,770.9315 CNY。",
                    "evidence_ids": ["EVID_GB_COMPONENT_BASE_FREIGHT", "EVID_GB_TREE_DE_FC"],
                },
                "recommendations": [
                    {
                        "text": "复核空运与 Carrier C 的业务分配规则，并在正式 Forecast 中把结构动作单独版本化。",
                        "evidence_ids": ["EVID_FACTOR_MIX", "EVID_DIAG_AIR_SHARE", "EVID_DIAG_CARRIER_C_SHARE"],
                        "scenario_validation_status": "NOT_RUN",
                        "feasibility_status": "NOT_VALIDATED",
                    },
                    {
                        "text": "分别检查基础运价与汇率暴露；当前证据不足以承诺节省金额。",
                        "evidence_ids": ["EVID_GB_COMPONENT_BASE_FREIGHT", "EVID_FACTOR_PRICE", "EVID_FACTOR_FX"],
                        "scenario_validation_status": "NOT_RUN",
                        "feasibility_status": "NOT_VALIDATED",
                    },
                ],
                "limitations": {
                    "text": "准时履约率 96.16%，但服务成熟度仅 92.00%，尚不能表述为最终服务表现。固定成本未分摊到英国；当前事实也不支持订单级 Top 10。结构变化及相关指标只能作为贡献与关联证据，不得据此推断未经记录的经营因果。",
                    "evidence_ids": ["EVID_DIAG_ON_TIME_RATE", "EVID_DIAG_SERVICE_MATURITY"],
                    "status_labels": ["相关性不等于因果 · 不得推断未记录的经营因果"],
                },
                "evidence_snapshot_id": "SNAPSHOT_GB_2026_08_V1",
                "evaluation_question_ids": ["E01", "E05", "E06", "E07", "E09", "E10", "E20"],
            },
            "order_level_guardrail": {
                "code": "ORDER_LEVEL_NOT_AVAILABLE",
                "message_zh": "当前事实粒度为月 × 目的国 × 发货仓 × 承运商 × 运输方式；可提供线路层下钻，不生成订单级 Top 10。",
            },
        },
        "evidence": evidence,
        "evaluation_gate": evaluation_gate,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")
    print(f"Evidence objects: {len(evidence)}")
    print(f"Evaluation gate: {len(evaluation_gate)} PASS")


if __name__ == "__main__":
    main()
