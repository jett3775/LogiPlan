import { describe, expect, it } from "vitest";

import {
  decimalCompare,
  formatDecimal,
  formatMoney,
  formatPlainDecimal,
  formatSignedMoney,
} from "../app/lib/format";

describe("high precision display helpers", () => {
  it("formats decimal strings without coercing business values to Number", () => {
    expect(
      formatMoney({
        high_precision: "891643.2815000000001",
        report: "891643.2815",
        display: "891643.28",
        currency: "CNY",
      }),
    ).toBe("891,643.28 CNY");
    expect(
      formatSignedMoney({
        high_precision: "0.0000000001",
        report: "0.0000",
        display: "0.00",
        currency: "CNY",
      }),
    ).toBe("+0.00 CNY");
    expect(formatPlainDecimal("12345678901234567890.12")).toBe("12,345,678,901,234,567,890.12");
  });

  it("compares values beyond JavaScript safe integer precision and formats ratios", () => {
    expect(decimalCompare("9007199254740993.0001", "9007199254740992.9999")).toBe(1);
    expect(decimalCompare("-100.01", "-100.001")).toBe(-1);
    expect(decimalCompare("1.2300", "1.23")).toBe(0);
    expect(
      formatDecimal({
        high_precision: "0.523241",
        report: "0.5232",
        display: "0.52",
        unit: "RATIO",
      }),
    ).toBe("52.32%");
  });
});
