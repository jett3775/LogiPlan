import { describe, expect, it } from "vitest";

import { addExactDecimals, LogiPlanDecimal } from "./index";

describe("LogiPlanDecimal", () => {
  it("uses the frozen precision and exact decimal input", () => {
    expect(LogiPlanDecimal.precision).toBe(80);
    expect(addExactDecimals("0.1", "0.2")).toBe("0.3");
  });
});
