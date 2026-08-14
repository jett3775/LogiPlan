from __future__ import annotations

import json
from collections import Counter, defaultdict
from decimal import Decimal, getcontext
from pathlib import Path


getcontext().prec = 80

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "generated" / "logiplan-2026-demo-data.json"
EVAL_PATH = ROOT / "data" / "generated" / "ai-evaluation-baseline.json"
AUDIT_PATH = ROOT / "data" / "generated" / "workbook-audit-baseline.json"

ZERO = Decimal("0")
ONE = Decimal("1")
MONTHS = tuple(f"2026-{month:02d}" for month in range(1, 13))
ACTUAL_MONTHS = MONTHS[:8]
FUTURE_MONTHS = MONTHS[8:]


def d(value: object) -> Decimal:
    return Decimal(str(value))


def assert_close(actual: Decimal, expected: Decimal, tolerance: Decimal, message: str) -> None:
    if abs(actual - expected) > tolerance:
        raise AssertionError(f"{message}: actual={actual}, expected={expected}")


def main() -> None:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    evaluation = json.loads(EVAL_PATH.read_text(encoding="utf-8"))
    audit = json.loads(AUDIT_PATH.read_text(encoding="utf-8"))

    assert data["metadata"]["dataset_id"] == "LOGIPLAN_2026_DEMO_V1"
    assert data["metadata"]["latest_closed_month"] == "2026-08"
    assert data["metadata"]["reporting_currency"] == "CNY"
    assert data["metadata"]["shapley_coalition_count"] == 32
    assert data["metadata"]["cost_model_revision"] == "D-092"
    assert data["metadata"]["source_workbook"] == "outputs/2026-demo-data-current-labor-split/LogiPlan-AI-2026-Demo-Data.xlsx"
    assert data["metadata"]["source_workbook_sha256"] == "a3a61b423900d00db4309a15ce37e153a82f1e3d56a10974075aa741b7a766c6"
    assert data["metadata"]["source_workbook_role"] == "AUDIT_SOURCE_OF_TRUTH"
    assert data["metadata"]["fact_grain"] == "month x destination_country x fulfillment_center x carrier x transport_mode"

    assert len(data["dimensions"]["routes"]) == 10
    assert len(data["driver_facts"]) == 360
    assert len(data["cost_facts"]) == 2160
    assert len(data["fixed_cost_facts"]) == 252
    assert len(data["attribution_detail"]) == 12000
    assert {row["destination_country_id"] for row in data["dimensions"]["routes"]} == {"DE", "FR", "GB"}
    assert {row["carrier_id"] for row in data["dimensions"]["routes"]} == {"CARRIER_A", "CARRIER_B", "CARRIER_C"}
    assert {row["cost_component_id"] for row in data["cost_facts"]} == {
        "BASE_FREIGHT", "FUEL_SURCHARGE", "FRONTLINE_VARIABLE_LABOR",
        "PACKAGING", "RETURN_LOGISTICS", "BILLABLE_EXCEPTION",
    }
    assert {row["fixed_cost_category_id"] for row in data["fixed_cost_facts"]} == {
        "WAREHOUSE_RENT", "FRONTLINE_BASE_LABOR", "WAREHOUSE_MANAGEMENT_LABOR", "SYSTEM_COST",
    }
    assert all("frontline_variable_labor_unit_price" in row for row in data["driver_facts"])
    assert all("warehouse_operation_unit_price" not in row for row in data["driver_facts"])

    actual_costs = [row for row in data["cost_facts"] if row["data_type"] == "ACTUAL"]
    assert actual_costs
    assert all(d(row["authority_model_delta_cny"]) == ZERO for row in actual_costs)
    assert {row["posting_basis"] for row in actual_costs} == {"INVOICE_OR_PLAN", "ACCRUAL"}
    assert {row["fuel_charge_basis"] for row in data["driver_facts"]} >= {"PERCENTAGE_OF_BASE_FREIGHT", "PER_CHARGEABLE_KG"}
    assert all(row["capacity_assumption"] == "UNVERIFIED_UNLIMITED_FOR_MVP" for row in data["driver_facts"])

    driver_groups: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    for row in data["driver_facts"]:
        driver_groups[(row["version_id"], row["month_id"])].append(row)
    for key, rows in driver_groups.items():
        destination_shares = {row["destination_country_id"]: d(row["destination_order_share"]) for row in rows}
        assert_close(sum(destination_shares.values(), ZERO), ONE, Decimal("1e-60"), f"destination shares {key}")
        warehouse_shares: dict[str, dict[str, Decimal]] = defaultdict(dict)
        route_shares: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
        for row in rows:
            country = str(row["destination_country_id"])
            warehouse = str(row["fulfillment_center_id"])
            warehouse_shares[country][warehouse] = d(row["warehouse_order_share"])
            route_shares[(country, warehouse)] += d(row["route_package_share"])
        for country, shares in warehouse_shares.items():
            assert_close(sum(shares.values(), ZERO), ONE, Decimal("1e-60"), f"warehouse shares {key} {country}")
        for route_group, total in route_shares.items():
            assert_close(total, ONE, Decimal("1e-60"), f"route shares {key} {route_group}")

    monthly = {(row["series_id"], row["month_id"]): row for row in data["monthly_summary"]}
    country = {(row["series_id"], row["month_id"], row["destination_country_id"]): row for row in data["country_summary"]}

    for month in MONTHS:
        latest = d(monthly[("LATEST_OUTLOOK", month)]["total_cost_cny_high_precision"])
        source_series = "ACTUAL" if month in ACTUAL_MONTHS else "FORECAST"
        assert_close(latest, d(monthly[(source_series, month)]["total_cost_cny_high_precision"]), ZERO, f"latest outlook {month}")

    aug_budget_gb = country[("BUDGET", "2026-08", "GB")]
    aug_actual_gb = country[("ACTUAL", "2026-08", "GB")]
    assert d(aug_actual_gb["variable_cost_cny_high_precision"]) > d(aug_budget_gb["variable_cost_cny_high_precision"])
    assert d(aug_actual_gb["orders"]) > d(aug_budget_gb["orders"])
    assert d(aug_actual_gb["air_package_share"]) > d(aug_budget_gb["air_package_share"])
    assert d(aug_actual_gb["carrier_c_package_share"]) > d(aug_budget_gb["carrier_c_package_share"])
    assert d(aug_actual_gb["service_maturity_rate"]) == Decimal("0.92")

    august_country_variances = {
        country_id: d(country[("ACTUAL", "2026-08", country_id)]["variable_cost_cny_high_precision"]) - d(country[("BUDGET", "2026-08", country_id)]["variable_cost_cny_high_precision"])
        for country_id in ("DE", "FR", "GB")
    }
    assert max(august_country_variances, key=august_country_variances.get) == "GB"

    gb_chain = defaultdict(Decimal)
    for row in data["attribution_country_summary"]:
        if row["comparison_id"] == "ACTUAL_VS_BUDGET" and row["month_id"] == "2026-08" and row["method_id"] == "CHAIN" and row["destination_country_id"] == "GB":
            gb_chain[row["factor_id"]] += d(row["amount_cny_high_precision"])
    assert set(gb_chain) == {"VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"}
    assert max(gb_chain, key=gb_chain.get) == "MIX"
    assert sorted(gb_chain, key=gb_chain.get, reverse=True)[1] == "VOLUME"
    assert_close(sum(gb_chain.values(), ZERO), august_country_variances["GB"], Decimal("1e-50"), "August UK factor bridge")

    for row in data["attribution_reconciliation"]:
        assert abs(d(row["chain_delta_cny"])) <= Decimal("1e-50")
        assert abs(d(row["shapley_delta_cny"])) <= Decimal("1e-50")

    forecast_future = sum((d(monthly[("FORECAST", month)]["total_cost_cny_high_precision"]) for month in FUTURE_MONTHS), ZERO)
    growth_future = sum((d(monthly[("SCENARIO_GROWTH", month)]["total_cost_cny_high_precision"]) for month in FUTURE_MONTHS), ZERO)
    saving_future = sum((d(monthly[("SCENARIO_COST_SAVING", month)]["total_cost_cny_high_precision"]) for month in FUTURE_MONTHS), ZERO)
    assert growth_future > forecast_future
    assert saving_future < forecast_future
    assert_close(d(monthly[("SCENARIO_COST_SAVING", "2026-09")]["total_cost_cny_high_precision"]), d(monthly[("FORECAST", "2026-09")]["total_cost_cny_high_precision"]), ZERO, "Cost Saving preparation month")
    assert d(monthly[("SCENARIO_COST_SAVING", "2026-10")]["total_cost_cny_high_precision"]) < d(monthly[("FORECAST", "2026-10")]["total_cost_cny_high_precision"])

    assert evaluation["question_count"] == 20
    assert evaluation["cost_model_revision"] == data["metadata"]["cost_model_revision"]
    assert evaluation["source_workbook"] == data["metadata"]["source_workbook"]
    assert evaluation["source_workbook_sha256"] == data["metadata"]["source_workbook_sha256"]
    assert audit["source_workbook"] == data["metadata"]["source_workbook"]
    assert audit["source_workbook_sha256"] == data["metadata"]["source_workbook_sha256"]
    assert audit["cost_model_revision"] == "D-092"
    assert audit["sheet_count"] == 15
    assert audit["formula_error_count"] == 0
    assert audit["model_status"] == "PASS"
    assert len(audit["checks"]) == 11
    assert all(row["status"] == "PASS" for row in audit["checks"])
    assert audit["row_counts"] == {
        "routes": len(data["dimensions"]["routes"]),
        "driver_facts": len(data["driver_facts"]),
        "cost_facts": len(data["cost_facts"]),
        "fixed_cost_facts": len(data["fixed_cost_facts"]),
        "gmv_facts": len(data["gmv_facts"]),
        "service_facts": len(data["service_facts"]),
        "monthly_summary": len(data["monthly_summary"]),
        "country_summary": len(data["country_summary"]),
        "attribution_summary_and_country_rows": len(data["attribution_summary"]) + len(data["attribution_country_summary"]),
        "scenario_rows": 12,
        "evaluation_questions": len(evaluation["questions"]),
        "boundary_questions": sum(row["category"] == "数据不足与越界保护" for row in evaluation["questions"]),
    }
    assert len(evaluation["questions"]) == 20
    category_counts = Counter(row["category"] for row in evaluation["questions"])
    assert dict(category_counts) == evaluation["category_quota"]
    assert evaluation["pass_rule"]["minimum_passed"] == 18
    assert evaluation["pass_rule"]["boundary_questions_must_all_pass"] is True
    assert all(row.get("hard_guardrail") for row in evaluation["questions"] if row["category"] == "数据不足与越界保护")

    print("LogiPlan 2026 demo data validation: PASS")
    print(f"routes={len(data['dimensions']['routes'])} driver_facts={len(data['driver_facts'])} cost_facts={len(data['cost_facts'])}")
    print(f"August UK variable cost variance={august_country_variances['GB'].quantize(Decimal('0.0001'))}")
    print(f"Cost Saving Sep-Dec savings={(forecast_future - saving_future).quantize(Decimal('0.0001'))}")


if __name__ == "__main__":
    main()
