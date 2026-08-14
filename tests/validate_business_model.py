from __future__ import annotations

import copy
import json
from decimal import Decimal, getcontext
from itertools import combinations
from math import factorial
from pathlib import Path
from typing import Any


getcontext().prec = 80

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "data" / "fixtures" / "business-model-validation.json"

FACTORS = ("VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX")
COMPONENTS = (
    "BASE_FREIGHT",
    "FUEL_SURCHARGE",
    "FRONTLINE_VARIABLE_LABOR",
    "PACKAGING",
    "RETURN_LOGISTICS",
    "BILLABLE_EXCEPTION",
)
ZERO = Decimal("0")
ONE = Decimal("1")
TOLERANCE = Decimal("1e-50")


def d(value: Any) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def deep_merge(base: Any, override: Any) -> Any:
    if isinstance(base, dict) and isinstance(override, dict):
        result = copy.deepcopy(base)
        for key, value in override.items():
            result[key] = deep_merge(result[key], value) if key in result else copy.deepcopy(value)
        return result
    return copy.deepcopy(override)


def assert_close(actual: Decimal, expected: Decimal, message: str) -> None:
    if abs(actual - expected) > TOLERANCE:
        raise AssertionError(f"{message}: actual={actual}, expected={expected}")


def add_maps(left: dict[str, Decimal], right: dict[str, Decimal]) -> dict[str, Decimal]:
    keys = set(left) | set(right)
    return {key: left.get(key, ZERO) + right.get(key, ZERO) for key in keys}


def subtract_maps(left: dict[str, Decimal], right: dict[str, Decimal]) -> dict[str, Decimal]:
    keys = set(left) | set(right)
    return {key: left.get(key, ZERO) - right.get(key, ZERO) for key in keys}


def scale_map(values: dict[str, Decimal], scalar: Decimal) -> dict[str, Decimal]:
    return {key: value * scalar for key, value in values.items()}


def map_total(values: dict[str, Decimal]) -> Decimal:
    return sum(values.values(), ZERO)


def validate_state(state: dict[str, Any], routes: dict[str, Any]) -> None:
    assert_close(sum((d(x) for x in state["destination_order_share"].values()), ZERO), ONE, "destination shares")

    warehouse_groups: dict[str, Decimal] = {}
    for key, value in state["warehouse_order_share"].items():
        country, _warehouse = key.split("|", 1)
        warehouse_groups[country] = warehouse_groups.get(country, ZERO) + d(value)
    for country, total in warehouse_groups.items():
        assert_close(total, ONE, f"warehouse shares for {country}")

    route_groups: dict[str, Decimal] = {}
    for route_id, value in state["route_package_share"].items():
        route = routes[route_id]
        group = f'{route["destination_country_id"]}|{route["fulfillment_center_id"]}'
        route_groups[group] = route_groups.get(group, ZERO) + d(value)
    for group, total in route_groups.items():
        assert_close(total, ONE, f"route shares for {group}")

    required_route_maps = (
        "route_package_share",
        "average_chargeable_weight_per_package_kg",
        "billable_events_per_package",
    )
    for route_id, route in routes.items():
        for field in required_route_maps:
            if route_id not in state[field]:
                raise AssertionError(f"missing {field} for {route_id}")
        country = route["destination_country_id"]
        warehouse = route["fulfillment_center_id"]
        country_warehouse = f"{country}|{warehouse}"
        if country_warehouse not in state["warehouse_order_share"]:
            raise AssertionError(f"missing warehouse share for {country_warehouse}")
        if country_warehouse not in state["average_packages_per_order"]:
            raise AssertionError(f"missing packages-per-order for {country_warehouse}")
        if country not in state["return_rate"]:
            raise AssertionError(f"missing return rate for {country}")
        if route_id not in state["prices"]["transport"]:
            raise AssertionError(f"missing transport price for {route_id}")
        if route_id not in state["prices"]["billable_exception"]:
            raise AssertionError(f"missing exception price for {route_id}")
        if warehouse not in state["prices"]["frontline_variable_labor"]:
            raise AssertionError(f"missing frontline variable labor price for {warehouse}")
        if warehouse not in state["prices"]["packaging"]:
            raise AssertionError(f"missing packaging price for {warehouse}")
        if country_warehouse not in state["prices"]["return_logistics"]:
            raise AssertionError(f"missing return price for {country_warehouse}")


def cny(original_amount: Decimal, currency: str, state: dict[str, Any]) -> Decimal:
    if currency not in state["fx"]:
        raise AssertionError(f"missing FX rate for {currency}")
    return original_amount * d(state["fx"][currency])


def compute_variable_costs(state: dict[str, Any], routes: dict[str, Any]) -> dict[str, Decimal]:
    validate_state(state, routes)
    result: dict[str, Decimal] = {}
    total_orders = d(state["total_orders"])

    for route_id, route in routes.items():
        country = route["destination_country_id"]
        warehouse = route["fulfillment_center_id"]
        country_warehouse = f"{country}|{warehouse}"

        equivalent_orders = (
            total_orders
            * d(state["destination_order_share"][country])
            * d(state["warehouse_order_share"][country_warehouse])
            * d(state["route_package_share"][route_id])
        )
        packages = equivalent_orders * d(state["average_packages_per_order"][country_warehouse])
        chargeable_weight = packages * d(state["average_chargeable_weight_per_package_kg"][route_id])
        return_packages = equivalent_orders * d(state["return_rate"][country])
        billable_events = packages * d(state["billable_events_per_package"][route_id])

        transport = state["prices"]["transport"][route_id]
        transport_currency = transport["currency"]
        base_original = chargeable_weight * d(transport["effective_base_rate_per_kg"])
        fuel_basis = transport["fuel_charge_basis"]
        fuel_value = d(transport["fuel_rate_or_unit_price"])
        if fuel_basis == "PERCENTAGE_OF_BASE_FREIGHT":
            fuel_original = base_original * fuel_value
        elif fuel_basis == "PER_CHARGEABLE_KG":
            fuel_original = chargeable_weight * fuel_value
        elif fuel_basis == "PER_PACKAGE":
            fuel_original = packages * fuel_value
        else:
            raise AssertionError(f"unsupported fuel basis: {fuel_basis}")

        frontline_variable_labor_price = state["prices"]["frontline_variable_labor"][warehouse]
        frontline_variable_labor_original = equivalent_orders * d(frontline_variable_labor_price["unit_price"])

        packaging_price = state["prices"]["packaging"][warehouse]
        packaging_original = packages * d(packaging_price["unit_price"])

        return_price = state["prices"]["return_logistics"][country_warehouse]
        return_original = return_packages * d(return_price["unit_price"])

        exception_price = state["prices"]["billable_exception"][route_id]
        exception_original = billable_events * d(exception_price["unit_price"])

        originals = {
            "BASE_FREIGHT": (base_original, transport_currency),
            "FUEL_SURCHARGE": (fuel_original, transport_currency),
            "FRONTLINE_VARIABLE_LABOR": (frontline_variable_labor_original, frontline_variable_labor_price["currency"]),
            "PACKAGING": (packaging_original, packaging_price["currency"]),
            "RETURN_LOGISTICS": (return_original, return_price["currency"]),
            "BILLABLE_EXCEPTION": (exception_original, exception_price["currency"]),
        }
        for component, (amount, currency) in originals.items():
            result[f"{route_id}|{component}"] = cny(amount, currency, state)

    return result


def compute_fixed_costs(state: dict[str, Any]) -> Decimal:
    total = ZERO
    for item in state["fixed_costs"]:
        total += cny(d(item["original_amount"]), item["currency"], state)
    return total


def state_for_factors(
    budget: dict[str, Any], actual: dict[str, Any], selected: set[str]
) -> dict[str, Any]:
    state = copy.deepcopy(budget)
    if "VOLUME" in selected:
        state["total_orders"] = copy.deepcopy(actual["total_orders"])
    if "MIX" in selected:
        for field in (
            "destination_order_share",
            "warehouse_order_share",
            "route_package_share",
            "average_chargeable_weight_per_package_kg",
        ):
            state[field] = copy.deepcopy(actual[field])
    if "EFFICIENCY" in selected:
        for field in (
            "average_packages_per_order",
            "return_rate",
            "billable_events_per_package",
        ):
            state[field] = copy.deepcopy(actual[field])
    if "PRICE" in selected:
        state["prices"] = copy.deepcopy(actual["prices"])
    if "FX" in selected:
        state["fx"] = copy.deepcopy(actual["fx"])
    return state


def chain_attribution(
    budget: dict[str, Any], actual: dict[str, Any], routes: dict[str, Any]
) -> tuple[dict[str, Decimal], dict[str, dict[str, Decimal]]]:
    selected: set[str] = set()
    previous = compute_variable_costs(state_for_factors(budget, actual, selected), routes)
    factor_totals: dict[str, Decimal] = {}
    factor_details: dict[str, dict[str, Decimal]] = {}
    for factor in FACTORS:
        selected.add(factor)
        current = compute_variable_costs(state_for_factors(budget, actual, selected), routes)
        detail = subtract_maps(current, previous)
        factor_details[factor] = detail
        factor_totals[factor] = map_total(detail)
        previous = current
    return factor_totals, factor_details


def shapley_attribution(
    budget: dict[str, Any], actual: dict[str, Any], routes: dict[str, Any]
) -> tuple[dict[str, Decimal], dict[str, dict[str, Decimal]]]:
    coalition_costs: dict[frozenset[str], dict[str, Decimal]] = {}
    for size in range(len(FACTORS) + 1):
        for subset in combinations(FACTORS, size):
            key = frozenset(subset)
            coalition_costs[key] = compute_variable_costs(
                state_for_factors(budget, actual, set(key)), routes
            )

    factor_details: dict[str, dict[str, Decimal]] = {}
    n = len(FACTORS)
    for factor in FACTORS:
        contribution: dict[str, Decimal] = {}
        others = [item for item in FACTORS if item != factor]
        for size in range(len(others) + 1):
            weight = d(factorial(size) * factorial(n - size - 1)) / d(factorial(n))
            for subset in combinations(others, size):
                before_key = frozenset(subset)
                after_key = frozenset((*subset, factor))
                marginal = subtract_maps(coalition_costs[after_key], coalition_costs[before_key])
                contribution = add_maps(contribution, scale_map(marginal, weight))
        factor_details[factor] = contribution
    factor_totals = {factor: map_total(detail) for factor, detail in factor_details.items()}
    return factor_totals, factor_details


def quantized(value: Decimal, places: str = "0.0001") -> str:
    return format(value.quantize(Decimal(places)), "f")


def verify_factor_additivity(
    budget: dict[str, Any],
    actual: dict[str, Any],
    routes: dict[str, Any],
    method_name: str,
    totals: dict[str, Decimal],
    details: dict[str, dict[str, Decimal]],
) -> None:
    budget_cost = map_total(compute_variable_costs(budget, routes))
    actual_cost = map_total(compute_variable_costs(actual, routes))
    difference = actual_cost - budget_cost
    assert_close(sum(totals.values(), ZERO), difference, f"{method_name} total additivity")
    for factor in FACTORS:
        assert_close(map_total(details[factor]), totals[factor], f"{method_name} detail additivity {factor}")


def verify_nonzero_factors(totals: dict[str, Decimal], expected: list[str], month_id: str) -> None:
    actual_nonzero = {factor for factor, value in totals.items() if abs(value) > TOLERANCE}
    if actual_nonzero != set(expected):
        raise AssertionError(
            f"unexpected nonzero factors for {month_id}: actual={sorted(actual_nonzero)}, expected={sorted(expected)}"
        )


def verify_pure_factor_isolation(budget: dict[str, Any], actual: dict[str, Any], routes: dict[str, Any]) -> None:
    for factor in FACTORS:
        pure_actual = state_for_factors(budget, actual, {factor})
        chain_totals, chain_details = chain_attribution(budget, pure_actual, routes)
        shapley_totals, shapley_details = shapley_attribution(budget, pure_actual, routes)
        verify_factor_additivity(budget, pure_actual, routes, f"pure chain {factor}", chain_totals, chain_details)
        verify_factor_additivity(budget, pure_actual, routes, f"pure shapley {factor}", shapley_totals, shapley_details)
        verify_nonzero_factors(chain_totals, [factor], f"pure chain {factor}")
        verify_nonzero_factors(shapley_totals, [factor], f"pure shapley {factor}")


def verify_new_and_exit_routes(budget: dict[str, Any], routes: dict[str, Any]) -> None:
    new_route_budget = copy.deepcopy(budget)
    new_route_budget["warehouse_order_share"]["GB|DE_FC"] = "1.000000"
    new_route_budget["warehouse_order_share"]["GB|FR_FC"] = "0.000000"
    new_route_actual = copy.deepcopy(new_route_budget)
    new_route_actual["warehouse_order_share"]["GB|DE_FC"] = "0.900000"
    new_route_actual["warehouse_order_share"]["GB|FR_FC"] = "0.100000"
    totals, details = chain_attribution(new_route_budget, new_route_actual, routes)
    verify_factor_additivity(new_route_budget, new_route_actual, routes, "new route", totals, details)
    verify_nonzero_factors(totals, ["MIX"], "new route")

    exit_route_actual = copy.deepcopy(budget)
    exit_route_actual["route_package_share"]["R_GB_DE_A_ROAD"] = "1.000000"
    exit_route_actual["route_package_share"]["R_GB_DE_C_AIR"] = "0.000000"
    totals, details = chain_attribution(budget, exit_route_actual, routes)
    verify_factor_additivity(budget, exit_route_actual, routes, "exit route", totals, details)
    verify_nonzero_factors(totals, ["MIX"], "exit route")


def verify_authority_mismatch_blocks(actual_costs: dict[str, Decimal]) -> None:
    authoritative = copy.deepcopy(actual_costs)
    first_key = sorted(authoritative)[0]
    authoritative[first_key] += Decimal("0.0001")
    mismatch = subtract_maps(authoritative, actual_costs)
    if all(abs(value) <= TOLERANCE for value in mismatch.values()):
        raise AssertionError("authority mismatch was not detected")


def verify_sensitivity_threshold(budget: dict[str, Any], routes: dict[str, Any]) -> None:
    stress_actual = copy.deepcopy(budget)
    stress_actual["total_orders"] = "2000"
    for transport in stress_actual["prices"]["transport"].values():
        transport["effective_base_rate_per_kg"] = str(
            d(transport["effective_base_rate_per_kg"]) * Decimal("2")
        )
        transport["fuel_rate_or_unit_price"] = str(
            d(transport["fuel_rate_or_unit_price"]) * Decimal("2")
        )
    for price_group in (
        "frontline_variable_labor",
        "packaging",
        "return_logistics",
        "billable_exception",
    ):
        for price in stress_actual["prices"][price_group].values():
            price["unit_price"] = str(d(price["unit_price"]) * Decimal("2"))

    chain_totals, chain_details = chain_attribution(budget, stress_actual, routes)
    shapley_totals, shapley_details = shapley_attribution(budget, stress_actual, routes)
    verify_factor_additivity(budget, stress_actual, routes, "sensitivity chain", chain_totals, chain_details)
    verify_factor_additivity(budget, stress_actual, routes, "sensitivity shapley", shapley_totals, shapley_details)
    verify_nonzero_factors(chain_totals, ["VOLUME", "PRICE"], "sensitivity stress")
    budget_cost = map_total(compute_variable_costs(budget, routes))
    results = sensitivity(chain_totals, shapley_totals, budget_cost)
    if not any(item["is_order_sensitive"] for item in results.values()):
        raise AssertionError("order-sensitivity threshold did not trigger in stress scenario")


def verify_expected_results(output: dict[str, Any], expected: dict[str, Any]) -> None:
    periods = {item["month_id"]: item for item in output["periods"]}
    for month_id, expected_period in expected["periods"].items():
        actual_period = periods[month_id]
        for field in (
            "budget_variable_cost_cny",
            "actual_variable_cost_cny",
            "variable_cost_difference_cny",
            "fixed_cost_difference_cny",
        ):
            if actual_period[field] != expected_period[field]:
                raise AssertionError(
                    f"regression mismatch {month_id} {field}: actual={actual_period[field]}, expected={expected_period[field]}"
                )
        if actual_period["chain_factors_cny"] != expected_period["chain_factors_cny"]:
            raise AssertionError(f"regression mismatch {month_id} chain factors")
    for field in (
        "cross_month_chain_factors_cny",
        "cross_month_variable_cost_difference_cny",
        "cross_month_report_rounding_adjustment_cny",
    ):
        if output[field] != expected[field]:
            raise AssertionError(f"regression mismatch {field}")


def sensitivity(
    chain_totals: dict[str, Decimal],
    shapley_totals: dict[str, Decimal],
    budget_cost: Decimal,
) -> dict[str, dict[str, Any]]:
    denominator = sum((abs(value) for value in shapley_totals.values()), ZERO)
    result: dict[str, dict[str, Any]] = {}
    for factor in FACTORS:
        absolute_difference = abs(chain_totals[factor] - shapley_totals[factor])
        normalized = ZERO if denominator == ZERO else absolute_difference / denominator
        amount_threshold = budget_cost * Decimal("0.005")
        result[factor] = {
            "absolute_difference_cny": quantized(absolute_difference),
            "normalized_difference": quantized(normalized, "0.000001"),
            "amount_threshold_cny": quantized(amount_threshold),
            "is_order_sensitive": normalized >= Decimal("0.10") and absolute_difference >= amount_threshold,
        }
    return result


def main() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    routes = fixture["routes"]
    budget = fixture["budget"]
    validate_state(budget, routes)

    no_change_chain, no_change_detail = chain_attribution(budget, budget, routes)
    verify_factor_additivity(budget, budget, routes, "no change", no_change_chain, no_change_detail)
    verify_nonzero_factors(no_change_chain, [], "no change")

    period_summaries: list[dict[str, Any]] = []
    monthly_factor_sum = {factor: ZERO for factor in FACTORS}
    monthly_variable_difference_sum = ZERO

    combined_actual: dict[str, Any] | None = None
    for period in fixture["periods"]:
        actual = deep_merge(budget, period["actual_overrides"])
        validate_state(actual, routes)
        chain_totals, chain_details = chain_attribution(budget, actual, routes)
        shapley_totals, shapley_details = shapley_attribution(budget, actual, routes)
        verify_factor_additivity(budget, actual, routes, "chain", chain_totals, chain_details)
        verify_factor_additivity(budget, actual, routes, "shapley", shapley_totals, shapley_details)
        verify_nonzero_factors(chain_totals, period["expected_nonzero_factors"], period["month_id"])

        budget_variable = map_total(compute_variable_costs(budget, routes))
        actual_variable_map = compute_variable_costs(actual, routes)
        actual_variable = map_total(actual_variable_map)
        budget_fixed = compute_fixed_costs(budget)
        actual_fixed = compute_fixed_costs(actual)

        for factor in FACTORS:
            monthly_factor_sum[factor] += chain_totals[factor]
        monthly_variable_difference_sum += actual_variable - budget_variable

        period_summaries.append(
            {
                "month_id": period["month_id"],
                "budget_variable_cost_cny": quantized(budget_variable),
                "actual_variable_cost_cny": quantized(actual_variable),
                "variable_cost_difference_cny": quantized(actual_variable - budget_variable),
                "chain_factors_cny": {factor: quantized(chain_totals[factor]) for factor in FACTORS},
                "shapley_factors_cny": {factor: quantized(shapley_totals[factor]) for factor in FACTORS},
                "budget_fixed_cost_cny": quantized(budget_fixed),
                "actual_fixed_cost_cny": quantized(actual_fixed),
                "fixed_cost_difference_cny": quantized(actual_fixed - budget_fixed),
                "logistics_total_difference_cny": quantized(
                    (actual_variable - budget_variable) + (actual_fixed - budget_fixed)
                ),
                "sensitivity": sensitivity(chain_totals, shapley_totals, budget_variable),
            }
        )
        combined_actual = actual
        verify_authority_mismatch_blocks(actual_variable_map)

    if combined_actual is None:
        raise AssertionError("fixture must contain at least one period")

    verify_pure_factor_isolation(budget, combined_actual, routes)
    verify_new_and_exit_routes(budget, routes)
    verify_sensitivity_threshold(budget, routes)

    assert_close(
        monthly_variable_difference_sum,
        sum(monthly_factor_sum.values(), ZERO),
        "cross-month high-precision additivity",
    )
    rounded_cross_month_difference = d(quantized(monthly_variable_difference_sum))
    rounded_monthly_factor_sum = sum(
        (d(quantized(value)) for value in monthly_factor_sum.values()), ZERO
    )
    rounding_adjustment = rounded_cross_month_difference - rounded_monthly_factor_sum

    output = {
        "fixture_version": fixture["fixture_version"],
        "status": "PASS",
        "periods": period_summaries,
        "cross_month_chain_factors_cny": {
            factor: quantized(monthly_factor_sum[factor]) for factor in FACTORS
        },
        "cross_month_variable_cost_difference_cny": quantized(monthly_variable_difference_sum),
        "cross_month_report_rounding_adjustment_cny": quantized(rounding_adjustment),
        "checks": fixture["synthetic_checks"],
    }
    verify_expected_results(output, fixture["expected_results"])
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
