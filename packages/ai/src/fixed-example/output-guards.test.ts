import { describe, expect, it } from "vitest";

import {
  collectStrings,
  findUnsupportedNumbers,
  findUnsupportedSavingsClaims,
  inspectAnswerText,
  inspectText,
  isMoneyLikeToken,
  normalizeNumberToken,
  supportedFormsOf,
} from "./output-guards";
import { FIXED_EXAMPLE_SUPPORTED_NUMBERS } from "./evaluation-baseline";

/** 输出守卫的机械判定行为与「非空判定」自证。 */

describe("数字呈现形式", () => {
  it("归一化千分位并生成百分比形式", () => {
    expect(normalizeNumberToken("891,643.2815")).toBe("891643.2815");
    expect(supportedFormsOf("891643.2815")).toEqual(["891643.2815"]);
    expect(supportedFormsOf("0.1369")).toEqual(["0.1369", "13.69"]);
    expect(supportedFormsOf("0.9200")).toEqual(["0.9200", "92.00"]);
    expect(supportedFormsOf("BASE_FREIGHT")).toEqual([]);
    expect(supportedFormsOf("")).toEqual([]);
  });

  it("区分金额型与普通整数型 token", () => {
    expect(isMoneyLikeToken("574,474.2232", " CNY")).toBe(true);
    expect(isMoneyLikeToken("13.69", "%")).toBe(true);
    expect(isMoneyLikeToken("432453", "万元")).toBe(true);
    expect(isMoneyLikeToken("432453", " 元")).toBe(true);
    expect(isMoneyLikeToken("10", " 单")).toBe(false);
    expect(isMoneyLikeToken("2026", " 年")).toBe(false);
    expect(isMoneyLikeToken("08", "｜英国")).toBe(false);
  });
});

describe("不可回指数字守卫", () => {
  const supported = FIXED_EXAMPLE_SUPPORTED_NUMBERS;

  it("接受基线内数字及其呈现形式", () => {
    expect(findUnsupportedNumbers("不利差异 574,474.2232 CNY。", supported)).toEqual([]);
    expect(findUnsupportedNumbers("空运占比 66.02%。", supported)).toEqual([]);
    expect(findUnsupportedNumbers("成熟度 92.00%，共 3 个仓库。", supported)).toEqual([]);
  });

  it("拒绝基线外的金额、比例与千分位数字", () => {
    expect(findUnsupportedNumbers("总成本 123,456.0001 CNY", supported)).toHaveLength(1);
    expect(findUnsupportedNumbers("可下降 3%", supported)[0]?.value).toBe("3");
    expect(findUnsupportedNumbers("金额 999999 CNY", supported)[0]?.value).toBe("999999");
    expect(findUnsupportedNumbers("58% 的仓库", supported)[0]?.value).toBe("58");
  });

  it("违规记录带上下文，便于定位", () => {
    const [violation] = findUnsupportedNumbers(
      "基准 574,474.2232 CNY，另有 7,777.0001 CNY 待核。",
      supported,
    );
    expect(violation?.kind).toBe("UNSUPPORTED_NUMBER");
    expect(violation?.context).toContain("7,777.0001");
  });
});

describe("节省金额守卫", () => {
  it("识别未经情景计算支持的节省金额", () => {
    for (const text of [
      "预计可节省约 120,000 CNY。",
      "节约 3% 成本。",
      "降本 12.5 万元。",
      "通过换承运商可减少 88,000 元。",
      "该方案能回收 4 万元投入。",
      "可降低基础运价 0.12 元/公斤。",
      "空运占比下降后单位成本下降 0.35 元/公斤。",
      "下调燃油附加费预计每月降本 3.2 万元。",
      "量因素回落 8,000 CNY。",
    ]) {
      expect(findUnsupportedSavingsClaims(text).length, text).toBeGreaterThan(0);
      expect(findUnsupportedSavingsClaims(text)[0]?.kind).toBe("UNSUPPORTED_SAVINGS_AMOUNT");
    }
  });

  it("否定陈述与无金额的表述不算违规", () => {
    for (const text of [
      "本条建议尚未做情景计算，不给出任何节省金额。",
      "尚未量化节省金额。",
      "请在情景计算后再评估降本空间。",
      "节省",
    ]) {
      expect(findUnsupportedSavingsClaims(text), text).toEqual([]);
    }
  });

  it("同一段文本可同时命中节省声明与不可回指数字", () => {
    const violations = inspectText("预计节省 120,000 CNY。", FIXED_EXAMPLE_SUPPORTED_NUMBERS);
    expect(violations.map((violation) => violation.kind).sort()).toEqual([
      "UNSUPPORTED_NUMBER",
      "UNSUPPORTED_SAVINGS_AMOUNT",
    ]);
  });
});

describe("回答级扫描", () => {
  const answer = {
    scope_label: "2026 年 8 月｜英国",
    conclusion: { text: "不利差异 574,474.2232 CNY。" },
    evidence: { text: "结构因素 324,207.8221 CNY。" },
    impact: { text: "基础运费 432,453.0802 CNY。" },
    recommendations: [{ text: "复核分配规则，尚未做情景计算。" }],
    limitations: { text: "相关性不等于因果。" },
  };

  it("只扫描陈述字段，干净文本无违规", () => {
    expect(inspectAnswerText(answer, FIXED_EXAMPLE_SUPPORTED_NUMBERS)).toEqual([]);
  });

  it("任一区块出现编造数字都判违规", () => {
    expect(
      inspectAnswerText(
        { ...answer, impact: { text: "基础运费 1,000,000.0000 CNY。" } },
        FIXED_EXAMPLE_SUPPORTED_NUMBERS,
      ),
    ).toHaveLength(1);
    expect(
      inspectAnswerText(
        {
          ...answer,
          recommendations: [{ text: "预计每年节省 45,000 CNY。" }],
        },
        FIXED_EXAMPLE_SUPPORTED_NUMBERS,
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      inspectAnswerText(
        { ...answer, scope_label: "2026 年 8 月｜英国｜差异 888,888.8888 CNY" },
        FIXED_EXAMPLE_SUPPORTED_NUMBERS,
      ),
    ).toHaveLength(1);
    expect(
      inspectAnswerText(
        { ...answer, limitations: { text: "相关 5,555.5555 CNY 不等于因果。" } },
        FIXED_EXAMPLE_SUPPORTED_NUMBERS,
      ),
    ).toHaveLength(1);
    expect(
      inspectAnswerText(
        {
          ...answer,
          conclusion: { text: "结论 3,333.3333 CNY。" },
          evidence: { text: "证据 4,444.4444 CNY。" },
        },
        FIXED_EXAMPLE_SUPPORTED_NUMBERS,
      ),
    ).toHaveLength(2);
  });
});

describe("字符串收集", () => {
  it("深度收集对象、数组与标量中的字符串", () => {
    expect(collectStrings({ a: "x", b: ["y", { c: "z" }], d: 1, e: null, f: true })).toEqual([
      "x",
      "y",
      "z",
    ]);
    expect(collectStrings("only")).toEqual(["only"]);
  });
});
