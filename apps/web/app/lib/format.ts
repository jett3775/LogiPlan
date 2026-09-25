import type { DecimalValue, MoneyValue } from "@logiplan/contracts";

type DecimalParts = { negative: boolean; integer: string; fraction: string };

const decimalParts = (input: string): DecimalParts => {
  const value = input.trim();
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/u, "");
  const [integerRaw = "0", fractionRaw = ""] = unsigned.split(".");
  const integer = integerRaw.replace(/^0+(?=\d)/u, "") || "0";
  return { negative, integer, fraction: fractionRaw.replace(/0+$/u, "") };
};

const isZero = (parts: DecimalParts) =>
  parts.integer.replace(/0/g, "").length === 0 && parts.fraction.replace(/0/g, "").length === 0;

const formatDecimalString = (input: string, places = 2) => {
  const parts = decimalParts(input);
  const grouped = parts.integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = parts.fraction.padEnd(places, "0").slice(0, places);
  return `${parts.negative && !isZero(parts) ? "-" : ""}${grouped}${places > 0 ? `.${fraction}` : ""}`;
};

const shiftTwoPlaces = (input: string) => {
  const parts = decimalParts(input);
  const fraction = parts.fraction.padEnd(2, "0");
  const combined = `${parts.integer}${fraction.slice(0, 2)}`;
  const shiftedFraction = fraction.slice(2);
  return `${parts.negative ? "-" : ""}${combined.replace(/^0+(?=\d)/u, "") || "0"}${shiftedFraction ? `.${shiftedFraction}` : ""}`;
};

export const formatPlainDecimal = (value: string, places = 2) => formatDecimalString(value, places);

export const isPositiveDecimal = (value: string) => {
  const parts = decimalParts(value);
  return !parts.negative && !isZero(parts);
};

export const formatMoney = (value: MoneyValue | null | undefined) =>
  value ? `${formatDecimalString(value.display)} CNY` : "不适用";

export const formatSignedMoney = (value: MoneyValue | null | undefined) => {
  if (!value) return "不适用";
  const sign = isPositiveDecimal(value.high_precision) ? "+" : "";
  return `${sign}${formatDecimalString(value.display)} CNY`;
};

export const formatDecimal = (value: DecimalValue | null | undefined) => {
  if (!value) return "不适用";
  if (value.unit === "RATIO") return `${formatDecimalString(shiftTwoPlaces(value.report))}%`;
  if (value.unit === "PERCENT") return `${formatDecimalString(value.display)}%`;
  return `${isPositiveDecimal(value.high_precision) ? "+" : ""}${formatDecimalString(value.display)} 个百分点`;
};

export const decimalCompare = (left: string, right: string) => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (isZero(leftParts) && isZero(rightParts)) return 0;
  if (leftParts.negative !== rightParts.negative) return leftParts.negative ? -1 : 1;
  const direction = leftParts.negative ? -1 : 1;
  if (leftParts.integer.length !== rightParts.integer.length) {
    return leftParts.integer.length < rightParts.integer.length ? -direction : direction;
  }
  if (leftParts.integer !== rightParts.integer) {
    return leftParts.integer < rightParts.integer ? -direction : direction;
  }
  const fractionLength =
    leftParts.fraction.length > rightParts.fraction.length
      ? leftParts.fraction.length
      : rightParts.fraction.length;
  const leftFraction = leftParts.fraction.padEnd(fractionLength, "0");
  const rightFraction = rightParts.fraction.padEnd(fractionLength, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -direction : direction;
};
