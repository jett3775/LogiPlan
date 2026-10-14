import { describe, expect, it } from "vitest";

import {
  PROVIDER_CAPABILITY_NAMES,
  allCapabilitiesGranted,
  capabilityGate,
  missingRequiredCapabilities,
  noCapabilitiesGranted,
  requiredCapabilitiesForRole,
  type ProviderCapabilities,
  type ProviderCapabilityName,
} from "./capabilities";
import { ADAPTER_ROLES } from "./roles";

const withCapability = (name: ProviderCapabilityName, value: boolean): ProviderCapabilities => ({
  ...allCapabilitiesGranted,
  [name]: value,
});

describe("能力声明与能力门", () => {
  it("能力表恰为五项布尔", () => {
    expect(PROVIDER_CAPABILITY_NAMES).toEqual([
      "structuredOutput",
      "reasoningControl",
      "dataRetentionToggle",
      "safetyIdentifier",
      "moderation",
    ]);
    expect(Object.keys(allCapabilitiesGranted).sort()).toEqual(
      [...PROVIDER_CAPABILITY_NAMES].sort(),
    );
  });

  it("三个角色都要求全部五项能力（D-180 实际调用字段）", () => {
    for (const role of ADAPTER_ROLES) {
      expect(requiredCapabilitiesForRole(role)).toEqual(PROVIDER_CAPABILITY_NAMES);
    }
  });

  it("全部授予时能力门通过", () => {
    expect(capabilityGate(allCapabilitiesGranted, PROVIDER_CAPABILITY_NAMES)).toEqual({ ok: true });
  });

  it("逐项为 false 时能力门失败关闭并精确报出缺失项", () => {
    for (const name of PROVIDER_CAPABILITY_NAMES) {
      const capabilities = withCapability(name, false);
      expect(capabilityGate(capabilities, PROVIDER_CAPABILITY_NAMES)).toEqual({
        ok: false,
        missing: [name],
      });
      expect(missingRequiredCapabilities(capabilities, PROVIDER_CAPABILITY_NAMES)).toEqual([name]);
    }
  });

  it("全 false 时报出全部五项缺失", () => {
    expect(capabilityGate(noCapabilitiesGranted, PROVIDER_CAPABILITY_NAMES)).toEqual({
      ok: false,
      missing: [...PROVIDER_CAPABILITY_NAMES],
    });
  });
});
