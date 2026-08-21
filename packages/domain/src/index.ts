import Decimal from "decimal.js";

export const LogiPlanDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -100,
  toExpPos: 100,
});

export function addExactDecimals(left: string, right: string): string {
  return new LogiPlanDecimal(left).plus(new LogiPlanDecimal(right)).toFixed();
}
