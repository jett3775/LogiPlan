import type { ManagementAnalysis } from "@logiplan/contracts";
import { describe, expect, it } from "vitest";

import { REQUIRED_LIMITATION_LABEL_ZH } from "../labels/zh-labels";
import { runOutputChecks } from "./output-checks";
import {
  FIXED_EXAMPLE_SCOPE_ANCHOR,
  fixedExampleWhitelist,
  liveAnalysis,
} from "./gateway-fixtures.test";

/**
 * 输出三检（docs/gate2-design.md §4.3；AC3.5—AC3.8）。
 *
 * 逐检驱动：① 模式校验、①b 输出契约、② 证据白名单、③ 数值回指（额外数字 / 跨结果集 /
 * 范围不一致）。任一不过即失败，调用方据此**整体丢弃**。
 */

const asAnalysis = (value: unknown): ManagementAnalysis => value as ManagementAnalysis;

const withImpactText = (suffix: string): ManagementAnalysis => {
  const analysis = asAnalysis(liveAnalysis());
  return { ...analysis, impact: { ...analysis.impact, text: `${analysis.impact.text}${suffix}` } };
};

const check = (output: unknown, overrides: Partial<Parameters<typeof runOutputChecks>[0]> = {}) =>
  runOutputChecks({
    output,
    evidence: fixedExampleWhitelist(),
    expectedScopeAnchor: FIXED_EXAMPLE_SCOPE_ANCHOR,
    ...overrides,
  });

describe("① 模式校验", () => {
  it("合法输出通过全部三检", () => {
    const result = check(liveAnalysis());
    expect(result.ok).toBe(true);
  });

  it("缺字段 / 空文本 / 未知枚举 → SCHEMA_VALIDATION_FAILED", () => {
    const base = asAnalysis(liveAnalysis());
    const cases: unknown[] = [
      (() => {
        const clone = { ...base } as Record<string, unknown>;
        delete clone.impact;
        return clone;
      })(),
      { ...base, conclusion: { ...base.conclusion, text: "" } },
      { ...base, answer_type: "LIVE" },
      { ...base, extra_field: "x" },
    ];
    for (const output of cases) {
      const result = check(output);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("SCHEMA_VALIDATION_FAILED");
    }
  });
});

describe("①b 输出契约（§4.4 中文 limitations 与建议状态）", () => {
  it("缺强制限制标签 → SCHEMA_VALIDATION_FAILED", () => {
    const base = asAnalysis(liveAnalysis());
    const result = check({
      ...base,
      limitations: {
        ...base.limitations,
        status_labels: (base.limitations.status_labels ?? []).filter(
          (label) => label !== REQUIRED_LIMITATION_LABEL_ZH,
        ),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("SCHEMA_VALIDATION_FAILED");
      expect(result.failure.reason).toBe("required_limitation_label_missing");
    }
  });

  it("建议状态非 NOT_RUN → SCHEMA_VALIDATION_FAILED", () => {
    const base = asAnalysis(liveAnalysis());
    const result = check({
      ...base,
      recommendations: [
        { ...base.recommendations[0], scenario_validation_status: "RUN" },
        ...base.recommendations.slice(1),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("scenario_validation_status_not_run_required");
    }
  });
});

describe("② 证据白名单", () => {
  it("引用白名单之外的证据 → EVIDENCE_WHITELIST_VIOLATION", () => {
    const base = asAnalysis(liveAnalysis());
    const result = check({
      ...base,
      conclusion: {
        ...base.conclusion,
        evidence_ids: [...base.conclusion.evidence_ids, "UNKNOWN:ID"],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("EVIDENCE_WHITELIST_VIOLATION");
      expect(result.failure.reason).toContain("unknown_evidence_id_count=1");
    }
  });

  it("（§4.3 2026-10-05 注记）英国归因范围下引用公司口径证据必须失败", () => {
    // 白名单**只**含英国归因范围锚点；公司口径证据（E08-* 等）不在其中。
    const base = asAnalysis(liveAnalysis());
    const result = check({
      ...base,
      evidence: {
        ...base.evidence,
        evidence_ids: [...base.evidence.evidence_ids, "E08-company-total"],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("EVIDENCE_WHITELIST_VIOLATION");
  });
});

describe("③ 数值回指（同一次确定性结果）", () => {
  it("额外数字（不在任何结果集）→ NUMERIC_MISMATCH / extra_number", () => {
    const result = check(withImpactText(" 另有 999,999.9999 CNY 待核。"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("NUMERIC_MISMATCH");
      expect(result.failure.reason).toBe("extra_number");
    }
  });

  it("跨结果集引用同一数字（AC3.6）→ NUMERIC_MISMATCH / cross_result_set_number", () => {
    // 结果集 A = 固定示例（被引用）；结果集 B = 另一结果集（未被引用），其数字 777,777.0001
    // 在 B 中合法，但输出只引用了 A 的证据 → 该数字属跨结果集引用。
    const evidence = fixedExampleWhitelist();
    const withSecondSet = {
      scope_anchor: evidence.scope_anchor,
      result_sets: [
        ...evidence.result_sets,
        {
          result_id: "RESULT_OTHER_2026_08",
          scope_anchor: evidence.scope_anchor,
          evidence_ids: ["OTHER:RESULT:EVIDENCE"],
          numbers: ["777777.0001"],
        },
      ],
    };
    const result = check(withImpactText(" 另一结果集为 777,777.0001 CNY。"), {
      evidence: withSecondSet,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("NUMERIC_MISMATCH");
      expect(result.failure.reason).toBe("cross_result_set_number");
    }
  });

  it("范围不一致 → NUMERIC_MISMATCH / scope_anchor_mismatch", () => {
    const result = check(liveAnalysis(), { expectedScopeAnchor: "SCOPE|DE|2026-08" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("NUMERIC_MISMATCH");
      expect(result.failure.reason).toBe("scope_anchor_mismatch");
    }
  });

  it("白名单内部锚点不一致 → NUMERIC_MISMATCH / scope_anchor_mismatch", () => {
    const evidence = fixedExampleWhitelist();
    const mixed = {
      scope_anchor: evidence.scope_anchor,
      result_sets: evidence.result_sets.map((set) => ({ ...set, scope_anchor: "OTHER_SCOPE" })),
    };
    const result = check(liveAnalysis(), { evidence: mixed });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("scope_anchor_mismatch");
  });
});
