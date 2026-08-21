from __future__ import annotations

import copy
import hashlib
import json
from decimal import Decimal, ROUND_HALF_UP, getcontext
from itertools import combinations
from math import factorial
from pathlib import Path
from typing import Any


getcontext().prec = 80

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "data" / "generated"
OUTPUT_PATH = OUTPUT_DIR / "logiplan-2026-demo-data.json"
SOURCE_WORKBOOK_RELATIVE = Path("outputs") / "2026-demo-data-current-labor-split" / "LogiPlan-AI-2026-Demo-Data.xlsx"
SOURCE_WORKBOOK_PATH = ROOT / SOURCE_WORKBOOK_RELATIVE
SOURCE_WORKBOOK_EXPECTED_SHA256 = "a3a61b423900d00db4309a15ce37e153a82f1e3d56a10974075aa741b7a766c6"

ZERO = Decimal("0")
ONE = Decimal("1")
FACTORS = ("VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX")
COMPONENTS = (
    "BASE_FREIGHT",
    "FUEL_SURCHARGE",
    "FRONTLINE_VARIABLE_LABOR",
    "PACKAGING",
    "RETURN_LOGISTICS",
    "BILLABLE_EXCEPTION",
)
MONTHS = tuple(f"2026-{month:02d}" for month in range(1, 13))
ACTUAL_MONTHS = MONTHS[:8]
FUTURE_MONTHS = MONTHS[8:]


def d(value: Any) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def q(value: Decimal, places: str = "0.0001") -> str:
    return format(value.quantize(Decimal(places), rounding=ROUND_HALF_UP), "f")


def hp(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.000000000001")), "f")


def json_ready(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, dict):
        return {key: json_ready(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_ready(item) for item in value]
    return value


ROUTES: dict[str, dict[str, str]] = {
    "R_DE_DE_A_ROAD": {"destination_country_id": "DE", "fulfillment_center_id": "DE_FC", "carrier_id": "CARRIER_A", "transport_mode_id": "ROAD"},
    "R_DE_DE_B_ROAD": {"destination_country_id": "DE", "fulfillment_center_id": "DE_FC", "carrier_id": "CARRIER_B", "transport_mode_id": "ROAD"},
    "R_DE_FR_B_ROAD": {"destination_country_id": "DE", "fulfillment_center_id": "FR_FC", "carrier_id": "CARRIER_B", "transport_mode_id": "ROAD"},
    "R_FR_FR_A_ROAD": {"destination_country_id": "FR", "fulfillment_center_id": "FR_FC", "carrier_id": "CARRIER_A", "transport_mode_id": "ROAD"},
    "R_FR_FR_B_ROAD": {"destination_country_id": "FR", "fulfillment_center_id": "FR_FC", "carrier_id": "CARRIER_B", "transport_mode_id": "ROAD"},
    "R_GB_DE_A_ROAD": {"destination_country_id": "GB", "fulfillment_center_id": "DE_FC", "carrier_id": "CARRIER_A", "transport_mode_id": "ROAD"},
    "R_GB_DE_B_ROAD": {"destination_country_id": "GB", "fulfillment_center_id": "DE_FC", "carrier_id": "CARRIER_B", "transport_mode_id": "ROAD"},
    "R_GB_DE_B_AIR": {"destination_country_id": "GB", "fulfillment_center_id": "DE_FC", "carrier_id": "CARRIER_B", "transport_mode_id": "AIR"},
    "R_GB_DE_C_AIR": {"destination_country_id": "GB", "fulfillment_center_id": "DE_FC", "carrier_id": "CARRIER_C", "transport_mode_id": "AIR"},
    "R_GB_FR_B_AIR": {"destination_country_id": "GB", "fulfillment_center_id": "FR_FC", "carrier_id": "CARRIER_B", "transport_mode_id": "AIR"},
}

COUNTRY_NAMES = {"DE": "德国", "FR": "法国", "GB": "英国"}
WAREHOUSE_NAMES = {"DE_FC": "德国仓", "FR_FC": "法国仓", "SHARED": "共享"}
CARRIER_NAMES = {"CARRIER_A": "Carrier A", "CARRIER_B": "Carrier B", "CARRIER_C": "Carrier C"}
MODE_NAMES = {"ROAD": "公路", "AIR": "空运"}

BUDGET_ORDERS = dict(zip(MONTHS, map(d, [14000, 13500, 15000, 15500, 16000, 16500, 17000, 16000, 16000, 18000, 22000, 26000])))
ACTUAL_ORDERS = dict(zip(ACTUAL_MONTHS, map(d, [13850, 13680, 15300, 15800, 16600, 17200, 18000, 20300])))
FORECAST_ORDERS = dict(zip(FUTURE_MONTHS, map(d, [17200, 19500, 24800, 28600])))

BUDGET_DESTINATION_SHARES = {
    "2026-01": ("0.42", "0.32", "0.26"), "2026-02": ("0.42", "0.32", "0.26"),
    "2026-03": ("0.40", "0.32", "0.28"), "2026-04": ("0.40", "0.32", "0.28"),
    "2026-05": ("0.39", "0.32", "0.29"), "2026-06": ("0.39", "0.32", "0.29"),
    "2026-07": ("0.38", "0.32", "0.30"), "2026-08": ("0.38", "0.32", "0.30"),
    "2026-09": ("0.38", "0.31", "0.31"), "2026-10": ("0.36", "0.31", "0.33"),
    "2026-11": ("0.34", "0.30", "0.36"), "2026-12": ("0.34", "0.29", "0.37"),
}

ACTUAL_DESTINATION_SHARES = {
    "2026-01": ("0.421", "0.319", "0.260"), "2026-02": ("0.414", "0.323", "0.263"),
    "2026-03": ("0.397", "0.319", "0.284"), "2026-04": ("0.398", "0.321", "0.281"),
    "2026-05": ("0.386", "0.319", "0.295"), "2026-06": ("0.382", "0.315", "0.303"),
    "2026-07": ("0.365", "0.305", "0.330"), "2026-08": ("0.310", "0.250", "0.440"),
}

FORECAST_DESTINATION_SHARES = {
    "2026-09": ("0.36", "0.30", "0.34"), "2026-10": ("0.34", "0.30", "0.36"),
    "2026-11": ("0.32", "0.29", "0.39"), "2026-12": ("0.32", "0.28", "0.40"),
}

ACTUAL_FX = {
    "2026-01": ("7.78", "9.05"), "2026-02": ("7.76", "9.02"), "2026-03": ("7.82", "9.08"),
    "2026-04": ("7.84", "9.11"), "2026-05": ("7.87", "9.13"), "2026-06": ("7.89", "9.16"),
    "2026-07": ("7.91", "9.18"), "2026-08": ("7.95", "9.22"),
}

FORECAST_FX = {
    "2026-09": ("7.92", "9.15"), "2026-10": ("7.90", "9.10"),
    "2026-11": ("7.88", "9.05"), "2026-12": ("7.86", "9.00"),
}


def destination_shares(values: tuple[str, str, str]) -> dict[str, Decimal]:
    return {"DE": d(values[0]), "FR": d(values[1]), "GB": d(values[2])}


def base_route_shares() -> dict[str, Decimal]:
    return {
        "R_DE_DE_A_ROAD": d("0.60"), "R_DE_DE_B_ROAD": d("0.40"), "R_DE_FR_B_ROAD": ONE,
        "R_FR_FR_A_ROAD": d("0.35"), "R_FR_FR_B_ROAD": d("0.65"),
        "R_GB_DE_A_ROAD": d("0.65"), "R_GB_DE_B_ROAD": d("0.25"),
        "R_GB_DE_B_AIR": d("0.07"), "R_GB_DE_C_AIR": d("0.03"), "R_GB_FR_B_AIR": ONE,
    }


def route_weights(month: str) -> dict[str, Decimal]:
    month_num = int(month[-2:])
    seasonal = d("1") + (d("0.01") if month_num in (10, 11, 12) else ZERO)
    return {
        "R_DE_DE_A_ROAD": d("0.78") * seasonal, "R_DE_DE_B_ROAD": d("0.80") * seasonal,
        "R_DE_FR_B_ROAD": d("0.86") * seasonal, "R_FR_FR_A_ROAD": d("0.76") * seasonal,
        "R_FR_FR_B_ROAD": d("0.79") * seasonal, "R_GB_DE_A_ROAD": d("1.02") * seasonal,
        "R_GB_DE_B_ROAD": d("1.00") * seasonal, "R_GB_DE_B_AIR": d("0.94") * seasonal,
        "R_GB_DE_C_AIR": d("0.92") * seasonal, "R_GB_FR_B_AIR": d("0.90") * seasonal,
    }


def base_prices() -> dict[str, Any]:
    def transport(currency: str, rate: str, basis: str, fuel: str) -> dict[str, Any]:
        return {"currency": currency, "effective_base_rate_per_kg": d(rate), "fuel_charge_basis": basis, "fuel_rate_or_unit_price": d(fuel)}

    return {
        "transport": {
            "R_DE_DE_A_ROAD": transport("EUR", "2.20", "PERCENTAGE_OF_BASE_FREIGHT", "0.095"),
            "R_DE_DE_B_ROAD": transport("EUR", "2.75", "PER_CHARGEABLE_KG", "0.21"),
            "R_DE_FR_B_ROAD": transport("EUR", "3.30", "PER_CHARGEABLE_KG", "0.24"),
            "R_FR_FR_A_ROAD": transport("EUR", "2.10", "PERCENTAGE_OF_BASE_FREIGHT", "0.090"),
            "R_FR_FR_B_ROAD": transport("EUR", "2.60", "PER_CHARGEABLE_KG", "0.20"),
            "R_GB_DE_A_ROAD": transport("GBP", "4.00", "PERCENTAGE_OF_BASE_FREIGHT", "0.100"),
            "R_GB_DE_B_ROAD": transport("GBP", "4.70", "PER_CHARGEABLE_KG", "0.33"),
            "R_GB_DE_B_AIR": transport("GBP", "6.20", "PERCENTAGE_OF_BASE_FREIGHT", "0.115"),
            "R_GB_DE_C_AIR": transport("GBP", "7.50", "PER_CHARGEABLE_KG", "0.58"),
            "R_GB_FR_B_AIR": transport("EUR", "6.70", "PERCENTAGE_OF_BASE_FREIGHT", "0.105"),
        },
        "frontline_variable_labor": {
            "DE_FC": {"currency": "EUR", "unit_price": d("1.18")},
            "FR_FC": {"currency": "EUR", "unit_price": d("1.05")},
        },
        "packaging": {
            "DE_FC": {"currency": "EUR", "unit_price": d("0.42")},
            "FR_FC": {"currency": "EUR", "unit_price": d("0.38")},
        },
        "return_logistics": {
            "DE|DE_FC": {"currency": "EUR", "unit_price": d("3.20")},
            "DE|FR_FC": {"currency": "EUR", "unit_price": d("3.80")},
            "FR|FR_FC": {"currency": "EUR", "unit_price": d("3.00")},
            "GB|DE_FC": {"currency": "GBP", "unit_price": d("4.80")},
            "GB|FR_FC": {"currency": "EUR", "unit_price": d("5.20")},
        },
        "billable_exception": {
            route_id: {"currency": ("GBP" if route["destination_country_id"] == "GB" and route["fulfillment_center_id"] == "DE_FC" else "EUR"),
                       "unit_price": d("3.60") if route["carrier_id"] == "CARRIER_C" else d("2.80") if route["transport_mode_id"] == "AIR" else d("2.30")}
            for route_id, route in ROUTES.items()
        },
    }


def apply_price_multiplier(prices: dict[str, Any], multiplier: Decimal, special: dict[str, Decimal] | None = None) -> None:
    special = special or {}
    for route_id, item in prices["transport"].items():
        route_multiplier = multiplier * special.get(route_id, ONE)
        item["effective_base_rate_per_kg"] *= route_multiplier
        item["fuel_rate_or_unit_price"] *= route_multiplier
    for group in ("frontline_variable_labor", "packaging", "return_logistics", "billable_exception"):
        for item in prices[group].values():
            item["unit_price"] *= multiplier


def fixed_costs(multiplier: Decimal = ONE) -> list[dict[str, Any]]:
    return [
        {"scope": "DE_FC", "category": "WAREHOUSE_RENT", "currency": "EUR", "original_amount": d("25000") * multiplier},
        {"scope": "DE_FC", "category": "FRONTLINE_BASE_LABOR", "currency": "EUR", "original_amount": d("14000") * multiplier},
        {"scope": "DE_FC", "category": "WAREHOUSE_MANAGEMENT_LABOR", "currency": "EUR", "original_amount": d("4000") * multiplier},
        {"scope": "FR_FC", "category": "WAREHOUSE_RENT", "currency": "EUR", "original_amount": d("18000") * multiplier},
        {"scope": "FR_FC", "category": "FRONTLINE_BASE_LABOR", "currency": "EUR", "original_amount": d("11000") * multiplier},
        {"scope": "FR_FC", "category": "WAREHOUSE_MANAGEMENT_LABOR", "currency": "EUR", "original_amount": d("3000") * multiplier},
        {"scope": "SHARED", "category": "SYSTEM_COST", "currency": "CNY", "original_amount": d("50000") * multiplier},
    ]


def add_frontline_variable_labor_amount(state: dict[str, Any], warehouse: str, original_amount: Decimal) -> None:
    warehouse_orders = sum((
        state["total_orders"]
        * destination_share
        * state["warehouse_order_share"].get(f"{country}|{warehouse}", ZERO)
        for country, destination_share in state["destination_order_share"].items()
    ), ZERO)
    if warehouse_orders <= ZERO:
        raise ValueError(f"cannot allocate variable labor without warehouse orders: {warehouse}")
    state["prices"]["frontline_variable_labor"][warehouse]["unit_price"] += original_amount / warehouse_orders


def base_on_time_rates() -> dict[str, Decimal]:
    return {
        "R_DE_DE_A_ROAD": d("0.965"), "R_DE_DE_B_ROAD": d("0.976"), "R_DE_FR_B_ROAD": d("0.968"),
        "R_FR_FR_A_ROAD": d("0.961"), "R_FR_FR_B_ROAD": d("0.973"), "R_GB_DE_A_ROAD": d("0.930"),
        "R_GB_DE_B_ROAD": d("0.950"), "R_GB_DE_B_AIR": d("0.974"), "R_GB_DE_C_AIR": d("0.988"),
        "R_GB_FR_B_AIR": d("0.971"),
    }


def build_budget_state(month: str) -> dict[str, Any]:
    month_num = int(month[-2:])
    aov_season = d("1.03") if month_num in (11, 12) else ONE
    shares = destination_shares(BUDGET_DESTINATION_SHARES[month])
    total = BUDGET_ORDERS[month]
    return {
        "total_orders": total,
        "destination_order_share": shares,
        "warehouse_order_share": {"DE|DE_FC": d("0.97"), "DE|FR_FC": d("0.03"), "FR|FR_FC": ONE, "GB|DE_FC": d("0.96"), "GB|FR_FC": d("0.04")},
        "route_package_share": base_route_shares(),
        "average_chargeable_weight_per_package_kg": route_weights(month),
        "average_packages_per_order": {"DE|DE_FC": d("1.05"), "DE|FR_FC": d("1.08"), "FR|FR_FC": d("1.06"), "GB|DE_FC": d("1.12"), "GB|FR_FC": d("1.15")},
        "return_rate": {"DE": d("0.050"), "FR": d("0.060"), "GB": d("0.080")},
        "billable_events_per_package": {
            "R_DE_DE_A_ROAD": d("0.016"), "R_DE_DE_B_ROAD": d("0.013"), "R_DE_FR_B_ROAD": d("0.014"),
            "R_FR_FR_A_ROAD": d("0.017"), "R_FR_FR_B_ROAD": d("0.014"), "R_GB_DE_A_ROAD": d("0.022"),
            "R_GB_DE_B_ROAD": d("0.017"), "R_GB_DE_B_AIR": d("0.013"), "R_GB_DE_C_AIR": d("0.009"),
            "R_GB_FR_B_AIR": d("0.012"),
        },
        "prices": base_prices(),
        "fx": {"CNY": ONE, "EUR": d("7.80"), "GBP": d("9.00")},
        "gmv": {
            "DE": {"currency": "EUR", "original_amount": total * shares["DE"] * d("82") * aov_season},
            "FR": {"currency": "EUR", "original_amount": total * shares["FR"] * d("86") * aov_season},
            "GB": {"currency": "GBP", "original_amount": total * shares["GB"] * d("78") * aov_season},
        },
        "fixed_costs": fixed_costs(),
        "on_time_rate": base_on_time_rates(),
        "service_maturity_rate": ONE,
        "event_note": "UK promotion" if month == "2026-08" else None,
        "management_action_note": None,
        "capacity_assumption": "UNVERIFIED_UNLIMITED_FOR_MVP",
    }


def build_actual_state(month: str, budget: dict[str, Any]) -> dict[str, Any]:
    state = copy.deepcopy(budget)
    month_num = int(month[-2:])
    state["total_orders"] = ACTUAL_ORDERS[month]
    state["destination_order_share"] = destination_shares(ACTUAL_DESTINATION_SHARES[month])
    state["route_package_share"].update({"R_GB_DE_A_ROAD": d("0.62"), "R_GB_DE_B_ROAD": d("0.25"), "R_GB_DE_B_AIR": d("0.09"), "R_GB_DE_C_AIR": d("0.04")})
    if month == "2026-07":
        state["route_package_share"].update({"R_GB_DE_A_ROAD": d("0.57"), "R_GB_DE_B_ROAD": d("0.26"), "R_GB_DE_B_AIR": d("0.11"), "R_GB_DE_C_AIR": d("0.06")})
    if month == "2026-08":
        state["warehouse_order_share"].update({"GB|DE_FC": d("0.97"), "GB|FR_FC": d("0.03")})
        state["route_package_share"].update({"R_GB_DE_A_ROAD": d("0.22"), "R_GB_DE_B_ROAD": d("0.13"), "R_GB_DE_B_AIR": d("0.25"), "R_GB_DE_C_AIR": d("0.40")})
        state["average_packages_per_order"].update({"GB|DE_FC": d("1.22"), "GB|FR_FC": d("1.18")})
        state["return_rate"]["GB"] = d("0.105")
        for route_id in ("R_GB_DE_A_ROAD", "R_GB_DE_B_ROAD", "R_GB_DE_B_AIR", "R_GB_DE_C_AIR", "R_GB_FR_B_AIR"):
            state["average_chargeable_weight_per_package_kg"][route_id] *= d("1.03")
        state["billable_events_per_package"].update({
            "R_GB_DE_A_ROAD": d("0.030"), "R_GB_DE_B_ROAD": d("0.022"), "R_GB_DE_B_AIR": d("0.017"),
            "R_GB_DE_C_AIR": d("0.012"), "R_GB_FR_B_AIR": d("0.015"),
        })
        state["event_note"] = "UK promotion"
        state["management_action_note"] = "为维持促销期间履约时效，提高德国仓至英国的空运和 Carrier C 份额"
    else:
        ppo_multiplier = d("1") + d(month_num - 1) * d("0.001")
        for key in state["average_packages_per_order"]:
            state["average_packages_per_order"][key] *= ppo_multiplier
        for key in state["average_chargeable_weight_per_package_kg"]:
            state["average_chargeable_weight_per_package_kg"][key] *= d("1.005")
        for key in state["billable_events_per_package"]:
            state["billable_events_per_package"][key] *= d("1.02")

    price_multiplier = ONE + d(month_num) * d("0.002")
    special = None
    if month == "2026-08":
        special = {"R_GB_DE_A_ROAD": d("1.02"), "R_GB_DE_B_ROAD": d("1.03"), "R_GB_DE_B_AIR": d("1.08"), "R_GB_DE_C_AIR": d("1.12")}
    apply_price_multiplier(state["prices"], price_multiplier, special)
    if month == "2026-08":
        add_frontline_variable_labor_amount(state, "DE_FC", d("2800"))
    eur, gbp = ACTUAL_FX[month]
    state["fx"] = {"CNY": ONE, "EUR": d(eur), "GBP": d(gbp)}

    aov = {"DE": d("83"), "FR": d("86.5"), "GB": d("77")}
    if month == "2026-08":
        aov["GB"] = d("72")
    state["gmv"] = {
        country: {"currency": "GBP" if country == "GB" else "EUR", "original_amount": state["total_orders"] * state["destination_order_share"][country] * aov[country]}
        for country in ("DE", "FR", "GB")
    }
    fixed_multiplier = ONE + d(month_num) * d("0.0015")
    state["fixed_costs"] = fixed_costs(fixed_multiplier)
    service_delta = d("-0.003") if month in ("2026-07", "2026-08") else d("0.001")
    state["on_time_rate"] = {route_id: max(d("0.85"), rate + service_delta) for route_id, rate in base_on_time_rates().items()}
    if month == "2026-08":
        state["on_time_rate"].update({"R_GB_DE_A_ROAD": d("0.918"), "R_GB_DE_B_ROAD": d("0.944"), "R_GB_DE_B_AIR": d("0.971"), "R_GB_DE_C_AIR": d("0.985"), "R_GB_FR_B_AIR": d("0.968")})
    state["service_maturity_rate"] = d("0.92") if month == "2026-08" else d("0.995") if month == "2026-07" else ONE
    return state


def build_forecast_state(month: str, budget: dict[str, Any]) -> dict[str, Any]:
    state = copy.deepcopy(budget)
    state["total_orders"] = FORECAST_ORDERS[month]
    state["destination_order_share"] = destination_shares(FORECAST_DESTINATION_SHARES[month])
    paths = {
        "2026-09": ("0.30", "0.17", "0.25", "0.28"),
        "2026-10": ("0.36", "0.20", "0.24", "0.20"),
        "2026-11": ("0.42", "0.23", "0.22", "0.13"),
        "2026-12": ("0.48", "0.25", "0.19", "0.08"),
    }
    a, b, b_air, c_air = paths[month]
    state["route_package_share"].update({"R_GB_DE_A_ROAD": d(a), "R_GB_DE_B_ROAD": d(b), "R_GB_DE_B_AIR": d(b_air), "R_GB_DE_C_AIR": d(c_air)})
    state["average_packages_per_order"].update({"GB|DE_FC": d("1.19") if month == "2026-09" else d("1.17"), "GB|FR_FC": d("1.17")})
    state["return_rate"]["GB"] = d("0.095") if month == "2026-09" else d("0.090")
    for route_id in ("R_GB_DE_A_ROAD", "R_GB_DE_B_ROAD", "R_GB_DE_B_AIR", "R_GB_DE_C_AIR", "R_GB_FR_B_AIR"):
        state["average_chargeable_weight_per_package_kg"][route_id] *= d("1.02")
    state["billable_events_per_package"].update({
        "R_GB_DE_A_ROAD": d("0.027"), "R_GB_DE_B_ROAD": d("0.020"), "R_GB_DE_B_AIR": d("0.016"),
        "R_GB_DE_C_AIR": d("0.011"), "R_GB_FR_B_AIR": d("0.014"),
    })
    apply_price_multiplier(state["prices"], d("1.035"), {"R_GB_DE_B_AIR": d("1.04"), "R_GB_DE_C_AIR": d("1.06")})
    add_frontline_variable_labor_amount(state, "DE_FC", d("1800") if month in ("2026-09", "2026-10") else d("800"))
    eur, gbp = FORECAST_FX[month]
    state["fx"] = {"CNY": ONE, "EUR": d(eur), "GBP": d(gbp)}
    state["gmv"] = {
        country: {"currency": "GBP" if country == "GB" else "EUR", "original_amount": state["total_orders"] * state["destination_order_share"][country] * (d("83") if country == "DE" else d("87") if country == "FR" else d("76"))}
        for country in ("DE", "FR", "GB")
    }
    state["fixed_costs"] = fixed_costs(d("1.018"))
    state["on_time_rate"] = base_on_time_rates()
    state["service_maturity_rate"] = None
    state["management_action_note"] = "正式 Forecast 逐月降低英国空运及 Carrier C 份额，但仍高于 Budget"
    return state


def adjust_country_volume(state: dict[str, Any], country: str, adjustment: Decimal) -> None:
    country_orders = {key: state["total_orders"] * share for key, share in state["destination_order_share"].items()}
    country_orders[country] *= ONE + adjustment
    new_total = sum(country_orders.values(), ZERO)
    state["total_orders"] = new_total
    state["destination_order_share"] = {key: value / new_total for key, value in country_orders.items()}
    for key, item in state["gmv"].items():
        if key == country:
            item["original_amount"] *= ONE + adjustment


def build_scenario_state(month: str, scenario_id: str, forecast: dict[str, Any]) -> dict[str, Any]:
    state = copy.deepcopy(forecast)
    if scenario_id == "BASE":
        state["scenario_note"] = "沿用当前正式 Forecast"
        return state
    if scenario_id == "GROWTH":
        adjust_country_volume(state, "GB", d("0.10"))
        state["scenario_note"] = "英国 9—12 月订单量分别相对各月正式 Forecast 增加 10%，不复利"
        return state
    if scenario_id != "COST_SAVING":
        raise ValueError(f"unsupported scenario {scenario_id}")
    if month == "2026-09":
        state["scenario_note"] = "准备期：沿用正式 Forecast"
        return state
    paths = {
        "2026-10": ("0.44", "0.24", "0.20", "0.12", "0.02", "0.95"),
        "2026-11": ("0.55", "0.28", "0.13", "0.04", "0.04", "0.90"),
        "2026-12": ("0.58", "0.28", "0.10", "0.04", "0.04", "0.90"),
    }
    a, b, b_air, c_air, ppo_improvement, event_multiplier = paths[month]
    state["route_package_share"].update({"R_GB_DE_A_ROAD": d(a), "R_GB_DE_B_ROAD": d(b), "R_GB_DE_B_AIR": d(b_air), "R_GB_DE_C_AIR": d(c_air)})
    state["average_packages_per_order"]["GB|DE_FC"] -= d(ppo_improvement)
    for route_id in ("R_GB_DE_A_ROAD", "R_GB_DE_B_ROAD", "R_GB_DE_B_AIR", "R_GB_DE_C_AIR", "R_GB_FR_B_AIR"):
        state["billable_events_per_package"][route_id] *= d(event_multiplier)
    state["scenario_note"] = "仅在现有承运商与有效线路内调整英国运输结构；承运能力未验证；一次性切换成本不适用"
    return state


def validate_state(state: dict[str, Any]) -> None:
    destination_total = sum(state["destination_order_share"].values(), ZERO)
    if abs(destination_total - ONE) > d("1e-60"):
        raise AssertionError(f"destination shares do not sum to 1: {destination_total}")
    warehouse_groups: dict[str, Decimal] = {}
    for key, value in state["warehouse_order_share"].items():
        country = key.split("|", 1)[0]
        warehouse_groups[country] = warehouse_groups.get(country, ZERO) + value
    if any(abs(value - ONE) > d("1e-60") for value in warehouse_groups.values()):
        raise AssertionError("warehouse shares do not sum to 1")
    route_groups: dict[str, Decimal] = {}
    for route_id, value in state["route_package_share"].items():
        route = ROUTES[route_id]
        key = f'{route["destination_country_id"]}|{route["fulfillment_center_id"]}'
        route_groups[key] = route_groups.get(key, ZERO) + value
    if any(abs(value - ONE) > d("1e-60") for value in route_groups.values()):
        raise AssertionError(f"route shares do not sum to 1: {route_groups}")


def compute_state(state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Decimal]]:
    validate_state(state)
    details: dict[str, Any] = {}
    costs: dict[str, Decimal] = {}
    for route_id, route in ROUTES.items():
        country = route["destination_country_id"]
        warehouse = route["fulfillment_center_id"]
        country_warehouse = f"{country}|{warehouse}"
        equivalent_orders = state["total_orders"] * state["destination_order_share"][country] * state["warehouse_order_share"][country_warehouse] * state["route_package_share"][route_id]
        packages = equivalent_orders * state["average_packages_per_order"][country_warehouse]
        weight = packages * state["average_chargeable_weight_per_package_kg"][route_id]
        returns = equivalent_orders * state["return_rate"][country]
        events = packages * state["billable_events_per_package"][route_id]
        transport = state["prices"]["transport"][route_id]
        base_original = weight * transport["effective_base_rate_per_kg"]
        if transport["fuel_charge_basis"] == "PERCENTAGE_OF_BASE_FREIGHT":
            fuel_original = base_original * transport["fuel_rate_or_unit_price"]
        elif transport["fuel_charge_basis"] == "PER_CHARGEABLE_KG":
            fuel_original = weight * transport["fuel_rate_or_unit_price"]
        else:
            fuel_original = packages * transport["fuel_rate_or_unit_price"]
        frontline_variable_labor_price = state["prices"]["frontline_variable_labor"][warehouse]
        packaging_price = state["prices"]["packaging"][warehouse]
        return_price = state["prices"]["return_logistics"][country_warehouse]
        exception_price = state["prices"]["billable_exception"][route_id]
        originals = {
            "BASE_FREIGHT": (base_original, transport["currency"]),
            "FUEL_SURCHARGE": (fuel_original, transport["currency"]),
            "FRONTLINE_VARIABLE_LABOR": (equivalent_orders * frontline_variable_labor_price["unit_price"], frontline_variable_labor_price["currency"]),
            "PACKAGING": (packages * packaging_price["unit_price"], packaging_price["currency"]),
            "RETURN_LOGISTICS": (returns * return_price["unit_price"], return_price["currency"]),
            "BILLABLE_EXCEPTION": (events * exception_price["unit_price"], exception_price["currency"]),
        }
        for component, (original, currency) in originals.items():
            costs[f"{route_id}|{component}"] = original * state["fx"][currency]
        details[route_id] = {
            "equivalent_orders": equivalent_orders, "packages": packages, "chargeable_weight_kg": weight,
            "return_packages": returns, "billable_events": events, "cost_originals": originals,
        }
    return details, costs


def fixed_cost_total(state: dict[str, Any]) -> Decimal:
    return sum((item["original_amount"] * state["fx"][item["currency"]] for item in state["fixed_costs"]), ZERO)


def factor_state(base: dict[str, Any], comparison: dict[str, Any], selected: set[str]) -> dict[str, Any]:
    state = copy.deepcopy(base)
    if "VOLUME" in selected:
        state["total_orders"] = comparison["total_orders"]
    if "MIX" in selected:
        for field in ("destination_order_share", "warehouse_order_share", "route_package_share", "average_chargeable_weight_per_package_kg"):
            state[field] = copy.deepcopy(comparison[field])
    if "EFFICIENCY" in selected:
        for field in ("average_packages_per_order", "return_rate", "billable_events_per_package"):
            state[field] = copy.deepcopy(comparison[field])
    if "PRICE" in selected:
        state["prices"] = copy.deepcopy(comparison["prices"])
    if "FX" in selected:
        state["fx"] = copy.deepcopy(comparison["fx"])
    return state


def subtract_maps(left: dict[str, Decimal], right: dict[str, Decimal]) -> dict[str, Decimal]:
    return {key: left.get(key, ZERO) - right.get(key, ZERO) for key in set(left) | set(right)}


def chain_attribution(base: dict[str, Any], comparison: dict[str, Any]) -> dict[str, dict[str, Decimal]]:
    selected: set[str] = set()
    previous = compute_state(factor_state(base, comparison, selected))[1]
    output: dict[str, dict[str, Decimal]] = {}
    for factor in FACTORS:
        selected.add(factor)
        current = compute_state(factor_state(base, comparison, selected))[1]
        output[factor] = subtract_maps(current, previous)
        previous = current
    return output


def shapley_attribution(base: dict[str, Any], comparison: dict[str, Any]) -> dict[str, dict[str, Decimal]]:
    coalitions: dict[frozenset[str], dict[str, Decimal]] = {}
    for size in range(len(FACTORS) + 1):
        for subset in combinations(FACTORS, size):
            coalitions[frozenset(subset)] = compute_state(factor_state(base, comparison, set(subset)))[1]
    output: dict[str, dict[str, Decimal]] = {}
    n = len(FACTORS)
    for factor in FACTORS:
        contribution = {key: ZERO for key in next(iter(coalitions.values()))}
        others = [item for item in FACTORS if item != factor]
        for size in range(len(others) + 1):
            weight = d(factorial(size) * factorial(n - size - 1)) / d(factorial(n))
            for subset in combinations(others, size):
                marginal = subtract_maps(coalitions[frozenset((*subset, factor))], coalitions[frozenset(subset)])
                for key, value in marginal.items():
                    contribution[key] += value * weight
        output[factor] = contribution
    return output


def build_state_facts(version_id: str, data_type: str, scenario_id: str | None, month: str, state: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    details, costs = compute_state(state)
    driver_rows: list[dict[str, Any]] = []
    cost_rows: list[dict[str, Any]] = []
    service_rows: list[dict[str, Any]] = []
    for route_id, route in ROUTES.items():
        country, warehouse = route["destination_country_id"], route["fulfillment_center_id"]
        key = f"{country}|{warehouse}"
        transport = state["prices"]["transport"][route_id]
        frontline_variable_labor_price = state["prices"]["frontline_variable_labor"][warehouse]
        packaging_price = state["prices"]["packaging"][warehouse]
        return_price = state["prices"]["return_logistics"][key]
        exception_price = state["prices"]["billable_exception"][route_id]
        detail = details[route_id]
        driver_rows.append({
            "version_id": version_id, "data_type": data_type, "scenario_id": scenario_id, "month_id": month, "route_id": route_id,
            **route, "total_company_orders": state["total_orders"], "destination_order_share": state["destination_order_share"][country],
            "warehouse_order_share": state["warehouse_order_share"][key], "route_package_share": state["route_package_share"][route_id],
            "equivalent_orders": detail["equivalent_orders"], "average_packages_per_order": state["average_packages_per_order"][key],
            "package_count": detail["packages"], "average_chargeable_weight_per_package_kg": state["average_chargeable_weight_per_package_kg"][route_id],
            "chargeable_weight_kg": detail["chargeable_weight_kg"], "return_rate": state["return_rate"][country],
            "return_package_count": detail["return_packages"], "billable_events_per_package": state["billable_events_per_package"][route_id],
            "billable_event_count": detail["billable_events"], "transport_currency": transport["currency"],
            "effective_base_rate_per_kg": transport["effective_base_rate_per_kg"], "fuel_charge_basis": transport["fuel_charge_basis"],
            "fuel_rate_or_unit_price": transport["fuel_rate_or_unit_price"], "frontline_variable_labor_currency": frontline_variable_labor_price["currency"],
            "frontline_variable_labor_unit_price": frontline_variable_labor_price["unit_price"], "packaging_currency": packaging_price["currency"],
            "packaging_unit_price": packaging_price["unit_price"], "return_currency": return_price["currency"],
            "return_unit_price": return_price["unit_price"], "exception_currency": exception_price["currency"],
            "exception_unit_price": exception_price["unit_price"], "eur_cny_rate": state["fx"]["EUR"], "gbp_cny_rate": state["fx"]["GBP"],
            "event_note": state.get("event_note"), "management_action_note": state.get("management_action_note"),
            "scenario_note": state.get("scenario_note"), "capacity_assumption": state["capacity_assumption"],
        })
        maturity = state["service_maturity_rate"]
        cohort = detail["packages"]
        due = None if maturity is None else cohort * maturity
        on_time = None if due is None else due * state["on_time_rate"][route_id]
        service_rows.append({
            "version_id": version_id, "data_type": data_type, "scenario_id": scenario_id, "month_id": month, "route_id": route_id,
            **route, "cohort_package_count": cohort, "due_package_count": due, "on_time_package_count": on_time,
            "on_time_rate": state["on_time_rate"][route_id], "service_maturity_rate": maturity,
        })
        for component in COMPONENTS:
            original, currency = detail["cost_originals"][component]
            amount = costs[f"{route_id}|{component}"]
            cost_rows.append({
                "version_id": version_id, "data_type": data_type, "scenario_id": scenario_id, "month_id": month, "route_id": route_id,
                **route, "cost_component_id": component, "currency": currency, "original_amount": original,
                "fx_rate": state["fx"][currency], "model_cost_cny_high_precision": amount,
                "model_cost_cny_report": q(amount), "authority_cost_cny_report": q(amount) if data_type == "ACTUAL" else None,
                "authority_model_delta_cny": q(ZERO) if data_type == "ACTUAL" else None,
                "posting_basis": "ACCRUAL" if data_type == "ACTUAL" and month in ("2026-04", "2026-07") and component in ("RETURN_LOGISTICS", "BILLABLE_EXCEPTION") else "INVOICE_OR_PLAN",
            })
    fixed_rows = [{
        "version_id": version_id, "data_type": data_type, "scenario_id": scenario_id, "month_id": month,
        "scope_id": item["scope"], "fixed_cost_category_id": item["category"], "currency": item["currency"],
        "original_amount": item["original_amount"], "fx_rate": state["fx"][item["currency"]],
        "cost_cny_high_precision": item["original_amount"] * state["fx"][item["currency"]],
        "cost_cny_report": q(item["original_amount"] * state["fx"][item["currency"]]),
    } for item in state["fixed_costs"]]
    return driver_rows, cost_rows, fixed_rows, service_rows


def aggregate_summary(series_id: str, month: str, state: dict[str, Any]) -> dict[str, Any]:
    details, costs = compute_state(state)
    variable = sum(costs.values(), ZERO)
    fixed = fixed_cost_total(state)
    gmv = sum((item["original_amount"] * state["fx"][item["currency"]] for item in state["gmv"].values()), ZERO)
    packages = sum((item["packages"] for item in details.values()), ZERO)
    weight = sum((item["chargeable_weight_kg"] for item in details.values()), ZERO)
    on_time_numerator = sum((details[route_id]["packages"] * state["on_time_rate"][route_id] for route_id in ROUTES), ZERO)
    on_time = on_time_numerator / packages
    return {
        "series_id": series_id, "month_id": month, "orders": state["total_orders"], "packages": packages,
        "chargeable_weight_kg": weight, "variable_cost_cny_high_precision": variable, "variable_cost_cny_report": q(variable),
        "fixed_cost_cny_high_precision": fixed, "fixed_cost_cny_report": q(fixed), "total_cost_cny_high_precision": variable + fixed,
        "total_cost_cny_report": q(variable + fixed), "gmv_cny_high_precision": gmv, "gmv_cny_report": q(gmv),
        "company_total_logistics_cost_rate": (variable + fixed) / gmv, "unit_variable_cost_per_order_cny": variable / state["total_orders"],
        "transport_cost_per_kg_cny": sum((value for key, value in costs.items() if key.endswith("|BASE_FREIGHT") or key.endswith("|FUEL_SURCHARGE")), ZERO) / weight,
        "on_time_rate": on_time, "service_maturity_rate": state["service_maturity_rate"],
    }


def aggregate_country(series_id: str, month: str, state: dict[str, Any]) -> list[dict[str, Any]]:
    details, costs = compute_state(state)
    rows = []
    for country in ("DE", "FR", "GB"):
        route_ids = [route_id for route_id, route in ROUTES.items() if route["destination_country_id"] == country]
        variable = sum((value for key, value in costs.items() if key.split("|", 1)[0] in route_ids), ZERO)
        packages = sum((details[route_id]["packages"] for route_id in route_ids), ZERO)
        air_packages = sum((details[route_id]["packages"] for route_id in route_ids if ROUTES[route_id]["transport_mode_id"] == "AIR"), ZERO)
        carrier_c_packages = sum((details[route_id]["packages"] for route_id in route_ids if ROUTES[route_id]["carrier_id"] == "CARRIER_C"), ZERO)
        gmv_item = state["gmv"][country]
        gmv = gmv_item["original_amount"] * state["fx"][gmv_item["currency"]]
        on_time = sum((details[route_id]["packages"] * state["on_time_rate"][route_id] for route_id in route_ids), ZERO) / packages
        rows.append({
            "series_id": series_id, "month_id": month, "destination_country_id": country,
            "orders": state["total_orders"] * state["destination_order_share"][country], "packages": packages,
            "variable_cost_cny_high_precision": variable, "variable_cost_cny_report": q(variable),
            "gmv_cny_high_precision": gmv, "gmv_cny_report": q(gmv), "destination_variable_cost_rate": variable / gmv,
            "air_package_share": air_packages / packages, "carrier_c_package_share": carrier_c_packages / packages,
            "on_time_rate": on_time, "service_maturity_rate": state["service_maturity_rate"],
        })
    return rows


def build_attribution_rows(comparison_id: str, month: str, base: dict[str, Any], comparison: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    chain = chain_attribution(base, comparison)
    shapley = shapley_attribution(base, comparison)
    detail_rows: list[dict[str, Any]] = []
    summary_rows: list[dict[str, Any]] = []
    base_cost = sum(compute_state(base)[1].values(), ZERO)
    for method, result in (("CHAIN", chain), ("SHAPLEY", shapley)):
        for factor, values in result.items():
            total = sum(values.values(), ZERO)
            summary_rows.append({"comparison_id": comparison_id, "month_id": month, "method_id": method, "factor_id": factor, "amount_cny_high_precision": total, "amount_cny_report": q(total)})
            for key, amount in values.items():
                route_id, component = key.split("|", 1)
                detail_rows.append({
                    "comparison_id": comparison_id, "month_id": month, "method_id": method, "factor_id": factor,
                    "route_id": route_id, **ROUTES[route_id], "cost_component_id": component,
                    "amount_cny_high_precision": amount, "amount_cny_report": q(amount),
                })
    chain_totals = {factor: sum(chain[factor].values(), ZERO) for factor in FACTORS}
    shapley_totals = {factor: sum(shapley[factor].values(), ZERO) for factor in FACTORS}
    denominator = sum((abs(value) for value in shapley_totals.values()), ZERO)
    for factor in FACTORS:
        difference = abs(chain_totals[factor] - shapley_totals[factor])
        normalized = ZERO if denominator == ZERO else difference / denominator
        sensitive = normalized >= d("0.10") and difference >= base_cost * d("0.005")
        for row in summary_rows:
            if row["method_id"] == "CHAIN" and row["factor_id"] == factor:
                row["shapley_difference_cny"] = difference
                row["normalized_order_sensitivity"] = normalized
                row["is_order_sensitive"] = sensitive
    total_difference = sum(compute_state(comparison)[1].values(), ZERO) - base_cost
    if abs(sum(chain_totals.values(), ZERO) - total_difference) > d("1e-50") or abs(sum(shapley_totals.values(), ZERO) - total_difference) > d("1e-50"):
        raise AssertionError(f"attribution does not reconcile for {comparison_id} {month}")
    return detail_rows, summary_rows


def build_dataset() -> dict[str, Any]:
    budget_states = {month: build_budget_state(month) for month in MONTHS}
    actual_states = {month: build_actual_state(month, budget_states[month]) for month in ACTUAL_MONTHS}
    forecast_states = {month: build_forecast_state(month, budget_states[month]) for month in FUTURE_MONTHS}
    scenario_states = {scenario: {month: build_scenario_state(month, scenario, forecast_states[month]) for month in FUTURE_MONTHS} for scenario in ("BASE", "GROWTH", "COST_SAVING")}

    driver_facts: list[dict[str, Any]] = []
    cost_facts: list[dict[str, Any]] = []
    fixed_cost_facts: list[dict[str, Any]] = []
    service_facts: list[dict[str, Any]] = []
    gmv_facts: list[dict[str, Any]] = []
    monthly_summary: list[dict[str, Any]] = []
    country_summary: list[dict[str, Any]] = []
    attribution_detail: list[dict[str, Any]] = []
    attribution_summary: list[dict[str, Any]] = []

    state_sets = [
        ("BUDGET_2026_V1", "BUDGET", None, budget_states),
        ("ACTUAL_2026_08_CLOSE_V1", "ACTUAL", None, actual_states),
        ("FORECAST_2026_08_V1", "FORECAST", None, forecast_states),
    ] + [(f"SCENARIO_{scenario}_2026_08", "SCENARIO", scenario, states) for scenario, states in scenario_states.items()]

    for version_id, data_type, scenario_id, states in state_sets:
        for month, state in states.items():
            drivers, costs, fixed, services = build_state_facts(version_id, data_type, scenario_id, month, state)
            driver_facts.extend(drivers)
            cost_facts.extend(costs)
            fixed_cost_facts.extend(fixed)
            service_facts.extend(services)
            for country, item in state["gmv"].items():
                gmv_facts.append({
                    "version_id": version_id, "data_type": data_type, "scenario_id": scenario_id, "month_id": month,
                    "destination_country_id": country, "currency": item["currency"], "original_amount": item["original_amount"],
                    "fx_rate": state["fx"][item["currency"]], "gmv_cny_high_precision": item["original_amount"] * state["fx"][item["currency"]],
                    "gmv_cny_report": q(item["original_amount"] * state["fx"][item["currency"]]),
                })
            series_id = data_type if scenario_id is None else f"SCENARIO_{scenario_id}"
            monthly_summary.append(aggregate_summary(series_id, month, state))
            country_summary.extend(aggregate_country(series_id, month, state))

    for month in MONTHS:
        state = actual_states[month] if month in ACTUAL_MONTHS else forecast_states[month]
        monthly_summary.append(aggregate_summary("LATEST_OUTLOOK", month, state))
        country_summary.extend(aggregate_country("LATEST_OUTLOOK", month, state))

    for month in ACTUAL_MONTHS:
        detail, summary = build_attribution_rows("ACTUAL_VS_BUDGET", month, budget_states[month], actual_states[month])
        attribution_detail.extend(detail); attribution_summary.extend(summary)
    for month in FUTURE_MONTHS:
        detail, summary = build_attribution_rows("FORECAST_VS_BUDGET", month, budget_states[month], forecast_states[month])
        attribution_detail.extend(detail); attribution_summary.extend(summary)
        for scenario in ("GROWTH", "COST_SAVING"):
            detail, summary = build_attribution_rows(f"SCENARIO_{scenario}_VS_FORECAST", month, forecast_states[month], scenario_states[scenario][month])
            attribution_detail.extend(detail); attribution_summary.extend(summary)

    attribution_country_groups: dict[tuple[str, str, str, str, str], Decimal] = {}
    for row in attribution_detail:
        key = (row["comparison_id"], row["month_id"], row["method_id"], row["factor_id"], row["destination_country_id"])
        attribution_country_groups[key] = attribution_country_groups.get(key, ZERO) + row["amount_cny_high_precision"]
    attribution_country_summary = [
        {
            "comparison_id": key[0], "month_id": key[1], "method_id": key[2], "factor_id": key[3],
            "destination_country_id": key[4], "amount_cny_high_precision": amount, "amount_cny_report": q(amount),
        }
        for key, amount in sorted(attribution_country_groups.items())
    ]

    monthly_index = {(row["series_id"], row["month_id"]): row for row in monthly_summary}
    comparison_series = {
        "ACTUAL_VS_BUDGET": ("BUDGET", "ACTUAL"),
        "FORECAST_VS_BUDGET": ("BUDGET", "FORECAST"),
        "SCENARIO_GROWTH_VS_FORECAST": ("FORECAST", "SCENARIO_GROWTH"),
        "SCENARIO_COST_SAVING_VS_FORECAST": ("FORECAST", "SCENARIO_COST_SAVING"),
    }
    attribution_reconciliation = []
    for comparison_id, month in sorted({(row["comparison_id"], row["month_id"]) for row in attribution_summary}):
        base_series, comparison_series_id = comparison_series[comparison_id]
        expected_difference = monthly_index[(comparison_series_id, month)]["variable_cost_cny_high_precision"] - monthly_index[(base_series, month)]["variable_cost_cny_high_precision"]
        chain_total = sum((row["amount_cny_high_precision"] for row in attribution_summary if row["comparison_id"] == comparison_id and row["month_id"] == month and row["method_id"] == "CHAIN"), ZERO)
        shapley_total = sum((row["amount_cny_high_precision"] for row in attribution_summary if row["comparison_id"] == comparison_id and row["month_id"] == month and row["method_id"] == "SHAPLEY"), ZERO)
        attribution_reconciliation.append({
            "comparison_id": comparison_id, "month_id": month, "expected_variable_cost_difference_cny": expected_difference,
            "chain_total_cny": chain_total, "chain_delta_cny": chain_total - expected_difference,
            "shapley_total_cny": shapley_total, "shapley_delta_cny": shapley_total - expected_difference,
        })

    dataset = {
        "metadata": {
            "dataset_id": "LOGIPLAN_2026_DEMO_V1", "generated_on": "2026-08-14", "reporting_currency": "CNY",
            "latest_closed_month": "2026-08", "budget_version_id": "BUDGET_2026_V1", "actual_version_id": "ACTUAL_2026_08_CLOSE_V1",
            "forecast_version_id": "FORECAST_2026_08_V1", "data_classification": "SYNTHETIC_DEMO_DATA",
            "fact_grain": "month x destination_country x fulfillment_center x carrier x transport_mode",
            "attribution_sequence": list(FACTORS), "shapley_coalition_count": 32, "cost_model_revision": "D-092",
        },
        "dimensions": {
            "countries": [{"id": key, "name_zh": value} for key, value in COUNTRY_NAMES.items()],
            "fulfillment_centers": [{"id": key, "name_zh": value, "timezone": "Europe/Berlin" if key == "DE_FC" else "Europe/Paris" if key == "FR_FC" else None} for key, value in WAREHOUSE_NAMES.items()],
            "carriers": [{"id": key, "name": value} for key, value in CARRIER_NAMES.items()],
            "transport_modes": [{"id": key, "name_zh": value} for key, value in MODE_NAMES.items()],
            "routes": [{"route_id": route_id, **route, "active_from": "2026-01-01", "active_to": None, "capacity_status": "NOT_VALIDATED_MVP"} for route_id, route in ROUTES.items()],
        },
        "versions": [
            {"version_id": "BUDGET_2026_V1", "type": "BUDGET", "status": "PUBLISHED_FROZEN", "coverage": "2026-01..2026-12"},
            {"version_id": "ACTUAL_2026_08_CLOSE_V1", "type": "ACTUAL", "status": "PUBLISHED_FROZEN", "coverage": "2026-01..2026-08"},
            {"version_id": "FORECAST_2026_08_V1", "type": "FORECAST", "status": "PUBLISHED_FROZEN", "coverage": "2026-09..2026-12"},
            {"version_id": "SCENARIO_BASE_2026_08", "type": "SCENARIO", "status": "SESSION_TEMPLATE", "coverage": "2026-09..2026-12"},
            {"version_id": "SCENARIO_GROWTH_2026_08", "type": "SCENARIO", "status": "SESSION_TEMPLATE", "coverage": "2026-09..2026-12"},
            {"version_id": "SCENARIO_COST_SAVING_2026_08", "type": "SCENARIO", "status": "SESSION_TEMPLATE", "coverage": "2026-09..2026-12"},
        ],
        "driver_facts": driver_facts, "cost_facts": cost_facts, "fixed_cost_facts": fixed_cost_facts,
        "service_facts": service_facts, "gmv_facts": gmv_facts, "monthly_summary": monthly_summary,
        "country_summary": country_summary, "attribution_detail": attribution_detail, "attribution_summary": attribution_summary,
        "attribution_country_summary": attribution_country_summary, "attribution_reconciliation": attribution_reconciliation,
    }
    validate_dataset(dataset)
    return dataset


def validate_dataset(dataset: dict[str, Any]) -> None:
    actual_cost_rows = [row for row in dataset["cost_facts"] if row["data_type"] == "ACTUAL"]
    if any(d(row["authority_model_delta_cny"]) != ZERO for row in actual_cost_rows):
        raise AssertionError("actual authority mismatch")
    summary_index = {(row["series_id"], row["month_id"]): row for row in dataset["monthly_summary"]}
    country_index = {(row["series_id"], row["month_id"], row["destination_country_id"]): row for row in dataset["country_summary"]}
    august_budget = country_index[("BUDGET", "2026-08", "GB")]
    august_actual = country_index[("ACTUAL", "2026-08", "GB")]
    if august_actual["variable_cost_cny_high_precision"] <= august_budget["variable_cost_cny_high_precision"]:
        raise AssertionError("August UK anomaly is not adverse")
    if august_actual["air_package_share"] <= august_budget["air_package_share"] or august_actual["carrier_c_package_share"] <= august_budget["carrier_c_package_share"]:
        raise AssertionError("August UK mix story is missing")
    country_variances = {
        country: country_index[("ACTUAL", "2026-08", country)]["variable_cost_cny_high_precision"] - country_index[("BUDGET", "2026-08", country)]["variable_cost_cny_high_precision"]
        for country in ("DE", "FR", "GB")
    }
    if max(country_variances, key=country_variances.get) != "GB":
        raise AssertionError("August UK is not the largest country variance")
    saving = sum((summary_index[("SCENARIO_COST_SAVING", month)]["total_cost_cny_high_precision"] - summary_index[("FORECAST", month)]["total_cost_cny_high_precision"] for month in FUTURE_MONTHS), ZERO)
    if saving >= ZERO:
        raise AssertionError("Cost Saving scenario does not save cost")
    latest_total = sum((summary_index[("LATEST_OUTLOOK", month)]["total_cost_cny_high_precision"] for month in MONTHS), ZERO)
    composed_total = sum((summary_index[("ACTUAL", month)]["total_cost_cny_high_precision"] for month in ACTUAL_MONTHS), ZERO) + sum((summary_index[("FORECAST", month)]["total_cost_cny_high_precision"] for month in FUTURE_MONTHS), ZERO)
    if latest_total != composed_total:
        raise AssertionError("latest outlook composition mismatch")


def main() -> None:
    if not SOURCE_WORKBOOK_PATH.is_file():
        raise FileNotFoundError(f"source audit workbook not found: {SOURCE_WORKBOOK_PATH}")
    source_hash = hashlib.sha256(SOURCE_WORKBOOK_PATH.read_bytes()).hexdigest()
    if source_hash != SOURCE_WORKBOOK_EXPECTED_SHA256:
        raise AssertionError(
            "source audit workbook changed; re-audit the workbook and update the approved SHA-256 before regenerating data"
        )
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    dataset = build_dataset()
    dataset["metadata"].update({
        "source_workbook": SOURCE_WORKBOOK_RELATIVE.as_posix(),
        "source_workbook_sha256": source_hash,
        "source_workbook_role": "AUDIT_SOURCE_OF_TRUTH",
    })
    OUTPUT_PATH.write_text(json.dumps(json_ready(dataset), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"generated {OUTPUT_PATH}")
    print(f"driver_facts={len(dataset['driver_facts'])} cost_facts={len(dataset['cost_facts'])} attribution_detail={len(dataset['attribution_detail'])}")


if __name__ == "__main__":
    main()
