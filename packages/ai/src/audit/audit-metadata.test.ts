import { describe, expect, it } from "vitest";

import {
  AI_AUDIT_FIELD_NAMES,
  AI_AUDIT_FORBIDDEN_CONTENT_KINDS,
  type AiAuditMetadata,
} from "./audit-metadata";
import { PROVIDER_CAPABILITY_NAMES } from "../adapter/provider-capabilities";
import {
  capabilityGate,
  missingRequiredCapabilities,
  noCapabilitiesGranted,
  allCapabilitiesGranted,
} from "../adapter/provider-capabilities";

/** 审计元数据边界（D-138）与能力门（docs/gate2-design.md §1.3）。 */

const AUDIT: AiAuditMetadata = {
  request_id: "REQ-FIXTURE",
  occurred_at: "2026-09-01T00:00:00.000Z",
  environment: "test",
  role: "management_analysis",
  provider: "PROVIDER_A",
  model: "MODEL_A",
  adapter_version: "ADAPTER_V1",
  system_prompt_version: "PROMPT_V1",
  output_schema_version: "G2_ANSWER_V1_0",
  price_version: "PRICE_2026_V1",
  input_tokens: 1_200,
  output_tokens: 400,
  latency_ms: 1_234,
  cost_estimate_usd: 0.01,
  http_status: 200,
  error_code: null,
  cancelled: false,
  fell_back_to_fixed_example: false,
};

describe("审计元数据字段边界", () => {
  it("字段名与白名单完全一致（多一个字段即失败）", () => {
    expect(Object.keys(AUDIT)).toEqual([...AI_AUDIT_FIELD_NAMES]);
  });

  it("版本元数据齐备，覆盖 D-174 要求的五项", () => {
    for (const field of [
      "provider",
      "model",
      "adapter_version",
      "system_prompt_version",
      "output_schema_version",
      "price_version",
    ] as const) {
      expect(AUDIT[field].length, field).toBeGreaterThan(0);
    }
  });

  it("不包含任何正文、身份或连接信息字段", () => {
    const names = new Set<string>(AI_AUDIT_FIELD_NAMES);
    for (const forbidden of AI_AUDIT_FORBIDDEN_CONTENT_KINDS) {
      expect(names.has(forbidden), forbidden).toBe(false);
    }
    const serialized = JSON.stringify(AUDIT);
    for (const marker of [
      "question_text",
      "answer_text",
      "evidence",
      "cookie",
      "authorization",
      "postgres",
      "user_agent",
      "raw_ip",
    ]) {
      expect(serialized.toLowerCase(), marker).not.toContain(marker);
    }
  });
});

describe("能力门", () => {
  it("全部能力满足时放行", () => {
    expect(capabilityGate(allCapabilitiesGranted, PROVIDER_CAPABILITY_NAMES)).toEqual({ ok: true });
    expect(missingRequiredCapabilities(allCapabilitiesGranted, ["structuredOutput"])).toEqual([]);
  });

  it("任一必需能力为 false 即失败关闭", () => {
    for (const name of PROVIDER_CAPABILITY_NAMES) {
      const capabilities = {
        ...allCapabilitiesGranted,
        [name]: false,
      } as typeof allCapabilitiesGranted;
      const gate = capabilityGate(capabilities, [name]);
      expect(gate.ok, name).toBe(false);
      if (gate.ok) throw new Error("能力缺失时必须失败关闭");
      expect(gate.missing).toEqual([name]);
    }
    expect(capabilityGate(noCapabilitiesGranted, PROVIDER_CAPABILITY_NAMES)).toEqual({
      ok: false,
      missing: [...PROVIDER_CAPABILITY_NAMES],
    });
    expect(capabilityGate(noCapabilitiesGranted, [])).toEqual({ ok: true });
  });
});
