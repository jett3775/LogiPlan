import { describe, expect, it } from "vitest";

import { compatibilityStatusSchema } from "./index";

describe("compatibilityStatusSchema", () => {
  it("accepts the frozen ready state and rejects unknown fields", () => {
    expect(compatibilityStatusSchema.parse({ state: "ready" })).toEqual({ state: "ready" });
    expect(() => compatibilityStatusSchema.parse({ state: "ready", internal: true })).toThrow();
  });
});
