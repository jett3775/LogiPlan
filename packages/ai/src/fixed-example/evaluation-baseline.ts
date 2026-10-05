import { z } from "zod";

import evaluationBaseline from "../../../../data/generated/ai-evaluation-baseline.json";

/**
 * 评估集读取（docs/gate2-implementation-plan.md §2）。
 *
 * 固定示例的内容范围由 docs/query-contract.md §10 冻结为 E01、E05—E10、E20，
 * 标准答案取自 `data/generated/ai-evaluation-baseline.json`。
 */

const evaluationQuestionSchema = z.object({
  id: z.string(),
  category: z.string(),
  question: z.string(),
  standard_answer: z.string(),
  required_numbers: z.record(z.string(), z.string()),
  evidence: z.array(z.string()),
});

export interface EvaluationQuestion {
  readonly id: string;
  readonly category: string;
  readonly question: string;
  readonly standard_answer: string;
  readonly required_numbers: Readonly<Record<string, string>>;
  readonly evidence: readonly string[];
}

/** 固定示例引用的评估题 ID，顺序即呈现顺序。 */
export const FIXED_EXAMPLE_EVALUATION_IDS = [
  "E01",
  "E05",
  "E06",
  "E07",
  "E08",
  "E09",
  "E10",
  "E20",
] as const;

export type FixedExampleEvaluationId = (typeof FIXED_EXAMPLE_EVALUATION_IDS)[number];

const parseBaseline = (): readonly EvaluationQuestion[] => {
  const parsed = z.array(evaluationQuestionSchema).min(1).safeParse(evaluationBaseline.questions);
  if (!parsed.success) {
    throw new Error("评估集文件不符合约定结构，固定示例不得在数据不可信时构造");
  }
  return parsed.data;
};

const ALL_QUESTIONS = parseBaseline();

/** 按固定顺序取出的评估题；缺题即抛错，不做部分构造。 */
export const FIXED_EXAMPLE_EVALUATION_QUESTIONS: readonly EvaluationQuestion[] =
  FIXED_EXAMPLE_EVALUATION_IDS.map((id) => {
    const question = ALL_QUESTIONS.find((candidate) => candidate.id === id);
    if (question === undefined) {
      throw new Error(`评估集缺少固定示例必需的题目：${id}`);
    }
    return question;
  });

/**
 * 固定示例允许出现的数字集合（`required_numbers` 的全部取值）。
 *
 * 该集合是「输出中的每个数字都能回指确定性结果」的本切片基线：
 * 输出守卫只接受出现在这里的数字及其百分比呈现形式。
 */
export const FIXED_EXAMPLE_SUPPORTED_NUMBERS: readonly string[] = [
  ...new Set(
    FIXED_EXAMPLE_EVALUATION_QUESTIONS.flatMap((question) =>
      Object.values(question.required_numbers),
    ),
  ),
];
