from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKBOOK = ROOT / "outputs/2026-demo-data-current-labor-split/LogiPlan-AI-2026-Demo-Data.xlsx"
EXTRACT = json.loads((Path(__file__).parent / "workbook-extract.json").read_text(encoding="utf-8"))["sheets"]
DATA = json.loads((ROOT / "data/generated/logiplan-2026-demo-data.json").read_text(encoding="utf-8"))
EVALUATION = json.loads((ROOT / "data/generated/ai-evaluation-baseline.json").read_text(encoding="utf-8"))
AUDIT = json.loads((ROOT / "data/generated/workbook-audit-baseline.json").read_text(encoding="utf-8"))


def decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def month(value: object) -> str:
    return (datetime(1899, 12, 30) + timedelta(days=int(value))).strftime("%Y-%m")


def close(actual: object, expected: object, tolerance: Decimal = Decimal("0.0000001")) -> None:
    left, right = decimal(actual), decimal(expected)
    if left is None or right is None:
        assert left is None and right is None, (actual, expected)
        return
    assert abs(left - right) <= tolerance * max(Decimal(1), abs(left), abs(right)), (actual, expected)


def rows(sheet: str) -> list[list[object]]:
    return EXTRACT[sheet]["values"][4:]


source_hash = hashlib.sha256(WORKBOOK.read_bytes()).hexdigest()
assert source_hash == DATA["metadata"]["source_workbook_sha256"] == AUDIT["source_workbook_sha256"]

routes = {row["route_id"]: row for row in DATA["dimensions"]["routes"]}
assert len(rows("Route_Master")) == len(routes) == 10
for source in rows("Route_Master"):
    target = routes[source[0]]
    assert source[1:5] == [target["destination_country_id"], target["fulfillment_center_id"], target["carrier_id"], target["transport_mode_id"]]
    assert source[7] == target["capacity_status"]

drivers = {(row["version_id"], row["month_id"], row["route_id"]): row for row in DATA["driver_facts"]}
assert len(rows("Model_Calc")) == len(drivers) == 360
driver_text = {
    0: "version_id", 1: "data_type", 2: "scenario_id", 4: "route_id", 5: "destination_country_id",
    6: "fulfillment_center_id", 7: "carrier_id", 8: "transport_mode_id", 22: "transport_currency",
    24: "fuel_charge_basis", 33: "frontline_variable_labor_currency", 38: "packaging_currency",
    43: "return_currency", 48: "exception_currency", 55: "event_note", 56: "management_action_note",
    57: "scenario_note", 58: "capacity_assumption",
}
driver_numbers = {
    9: "total_company_orders", 10: "destination_order_share", 11: "warehouse_order_share",
    12: "route_package_share", 13: "equivalent_orders", 14: "average_packages_per_order", 15: "package_count",
    16: "average_chargeable_weight_per_package_kg", 17: "chargeable_weight_kg", 18: "return_rate",
    19: "return_package_count", 20: "billable_events_per_package", 21: "billable_event_count",
    23: "effective_base_rate_per_kg", 25: "fuel_rate_or_unit_price", 26: "eur_cny_rate", 27: "gbp_cny_rate",
    34: "frontline_variable_labor_unit_price", 39: "packaging_unit_price", 44: "return_unit_price",
    49: "exception_unit_price",
}
for source in rows("Model_Calc"):
    target = drivers[(source[0], month(source[3]), source[4])]
    for column, field in driver_text.items():
        assert source[column] == target[field], (field, source[column], target[field])
    for column, field in driver_numbers.items():
        close(source[column], target[field])

costs = {(row["version_id"], row["month_id"], row["route_id"], row["cost_component_id"]): row for row in DATA["cost_facts"]}
assert len(rows("Cost_Facts")) == len(costs) == 2160
for source in rows("Cost_Facts"):
    target = costs[(source[0], month(source[3]), source[4], source[9])]
    assert [source[1], source[2], *source[5:11], source[17]] == [
        target["data_type"], target["scenario_id"], target["destination_country_id"],
        target["fulfillment_center_id"], target["carrier_id"], target["transport_mode_id"],
        target["cost_component_id"], target["currency"], target["posting_basis"],
    ]
    for actual, expected in (
        (source[11], target["original_amount"]), (source[12], target["fx_rate"]),
        (source[13], target["model_cost_cny_high_precision"]), (source[14], target["model_cost_cny_report"]),
        (source[15], target["authority_cost_cny_report"]), (source[16], target["authority_model_delta_cny"]),
        (source[18], target["model_cost_cny_high_precision"]), (source[19], 0),
    ):
        close(actual, expected)

fixed = {(row["version_id"], row["month_id"], row["scope_id"], row["fixed_cost_category_id"]): row for row in DATA["fixed_cost_facts"]}
assert len(rows("Fixed_Costs")) == len(fixed) == 252
for source in rows("Fixed_Costs"):
    target = fixed[(source[0], month(source[3]), source[4], source[5])]
    assert [source[1], source[2], source[6]] == [target["data_type"], target["scenario_id"], target["currency"]]
    for actual, expected in ((source[7], target["original_amount"]), (source[8], target["fx_rate"]), (source[9], target["cost_cny_high_precision"]), (source[10], target["cost_cny_report"]), (source[11], target["cost_cny_high_precision"]), (source[12], 0)):
        close(actual, expected)

gmv = {(row["version_id"], row["month_id"], row["destination_country_id"]): row for row in DATA["gmv_facts"]}
assert len(rows("GMV_Facts")) == len(gmv) == 108
for source in rows("GMV_Facts"):
    target = gmv[(source[0], month(source[3]), source[4])]
    assert [source[1], source[2], source[5]] == [target["data_type"], target["scenario_id"], target["currency"]]
    for actual, expected in ((source[6], target["original_amount"]), (source[7], target["fx_rate"]), (source[8], target["gmv_cny_high_precision"]), (source[9], target["gmv_cny_report"]), (source[10], target["gmv_cny_high_precision"]), (source[11], 0)):
        close(actual, expected)

service = {(row["version_id"], row["month_id"], row["route_id"]): row for row in DATA["service_facts"]}
assert len(rows("Service_Facts")) == len(service) == 360
for source in rows("Service_Facts"):
    target = service[(source[0], month(source[3]), source[4])]
    assert [source[1], source[2], *source[5:9]] == [target["data_type"], target["scenario_id"], target["destination_country_id"], target["fulfillment_center_id"], target["carrier_id"], target["transport_mode_id"]]
    for actual, expected in ((source[9], target["cohort_package_count"]), (source[10], target["due_package_count"]), (source[11], target["on_time_package_count"]), (source[12], target["on_time_rate"]), (source[13], target["service_maturity_rate"]), (source[14], target["on_time_rate"]), (source[15], 0)):
        close(actual, expected)

monthly = {(row["series_id"], row["month_id"]): row for row in DATA["monthly_summary"]}
assert len(rows("Monthly_Summary")) == len(monthly) == 48
monthly_fields = ["orders", "packages", "chargeable_weight_kg", "variable_cost_cny_report", "fixed_cost_cny_report", "total_cost_cny_report", "total_cost_cny_high_precision", None, "gmv_cny_report", "company_total_logistics_cost_rate", "unit_variable_cost_per_order_cny", "transport_cost_per_kg_cny", "on_time_rate", "service_maturity_rate"]
for source in rows("Monthly_Summary"):
    target = monthly[(source[0], month(source[1]))]
    for column, field in enumerate(monthly_fields, start=2):
        close(source[column], 0 if field is None else target[field])

country = {(row["series_id"], row["month_id"], row["destination_country_id"]): row for row in DATA["country_summary"]}
assert len(rows("Country_Summary")) == len(country) == 144
for source in rows("Country_Summary"):
    target = country[(source[0], month(source[1]), source[2])]
    expected = [target["orders"], target["packages"], target["variable_cost_cny_report"], target["gmv_cny_report"], target["destination_variable_cost_rate"], target["air_package_share"], target["carrier_c_package_share"], target["on_time_rate"], target["service_maturity_rate"], decimal(target["variable_cost_cny_high_precision"]) / decimal(target["orders"])]
    for actual, value in zip(source[3:13], expected):
        close(actual, value)

all_attribution = {(row["comparison_id"], row["month_id"], row["method_id"], row["factor_id"]): row for row in DATA["attribution_summary"]}
country_attribution = {(row["comparison_id"], row["month_id"], row["method_id"], row["factor_id"], row["destination_country_id"]): row for row in DATA["attribution_country_summary"]}
assert len(rows("Attribution")) == 800 and len(all_attribution) == 200 and len(country_attribution) == 600
for source in rows("Attribution"):
    base_key = (source[0], month(source[1]), source[2], source[3])
    target = all_attribution[base_key] if source[4] == "ALL" else country_attribution[base_key + (source[4],)]
    close(source[5], target["amount_cny_high_precision"])
    close(source[6], target["amount_cny_report"])
    if source[4] == "ALL" and source[2] == "CHAIN":
        close(source[7], target["shapley_difference_cny"])
        close(source[8], target["normalized_order_sensitivity"])
        assert source[9] == target["is_order_sensitive"]
    else:
        assert source[7] is None and source[8] is None and source[9] is None

reconciliation = {(row["comparison_id"], row["month_id"]): row for row in DATA["attribution_reconciliation"]}
for source in rows("Attribution"):
    if source[10] is None:
        continue
    target = reconciliation[(source[10], month(source[11]))]
    for actual, expected in zip(source[12:17], [target["expected_variable_cost_difference_cny"], target["chain_total_cny"], target["chain_delta_cny"], target["shapley_total_cny"], target["shapley_delta_cny"]]):
        close(actual, expected)
    assert source[17:] == ["PASS", "PASS"]

assert len(rows("Scenarios")) == 12
for source in rows("Scenarios"):
    scenario_month = month(source[1])
    target, forecast = monthly[(source[0], scenario_month)], monthly[("FORECAST", scenario_month)]
    expected = [target["orders"], target["total_cost_cny_report"], forecast["total_cost_cny_report"], decimal(target["total_cost_cny_high_precision"]) - decimal(forecast["total_cost_cny_high_precision"]), target["on_time_rate"], forecast["on_time_rate"], (decimal(target["on_time_rate"]) - decimal(forecast["on_time_rate"])) * 100]
    for actual, value in zip(source[2:9], expected):
        close(actual, value)
    assert source[9] == "UNVERIFIED_UNLIMITED_FOR_MVP"

questions = {row["id"]: row for row in EVALUATION["questions"]}
assert len(rows("Evaluation")) == len(questions) == 20
for source in rows("Evaluation"):
    target = questions[source[0]]
    assert source[1:4] == [target["category"], target["question"], target["standard_answer"]]
    assert json.loads(source[4]) == target["required_numbers"]
    assert source[5] == " | ".join(target["evidence"])
    assert source[6] == target.get("hard_guardrail")

check_rows = EXTRACT["Checks"]["values"][8:]
assert EXTRACT["Checks"]["values"][4][0] == "PASS"
assert len(check_rows) == 11 and all(row[4] == "PASS" for row in check_rows)

print("Audit workbook alignment: PASS")
print("matched routes=10 drivers=360 costs=2160 fixed=252 gmv=108 service=360 monthly=48 country=144 attribution=800 scenarios=12 evaluation=20")
print(f"source_sha256={source_hash}")
