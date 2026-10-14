/**
 * 输入内容审核（设计 §2、D-180）。
 *
 * 调用 `omni-moderation-latest` 检查用户输入。**命中或审核服务异常**（网络错误、超时、
 * 返回不可用）一律判定为拒绝 → `INPUT_REJECTED`（受控中文状态 + 固定示例，设计 §7）。
 * 审核在**任何模型调用之前**完成，且**不重试**。
 */

import type { OpenAiResponsesClient } from "./client-types";

export const MODERATION_MODEL = "omni-moderation-latest";

export type ModerationDecision = "allowed" | "rejected";

/**
 * 用假客户端 / 替身可确定性地驱动。`timed` 为硬超时结果；超时视为审核服务异常 → 拒绝。
 * 返回布尔由调用方映射为 `INPUT_REJECTED`。
 */
export const moderateInput = async (
  client: OpenAiResponsesClient,
  input: string,
  withHardTimeout: <T>(
    task: () => Promise<T>,
    timeoutMs: number,
  ) => Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }>,
  timeoutMs: number,
): Promise<ModerationDecision> => {
  const timed = await withHardTimeout(async () => {
    try {
      const response = await client.moderations.create({ model: MODERATION_MODEL, input });
      return { ok: true as const, response };
    } catch (error) {
      return { ok: false as const, error };
    }
  }, timeoutMs);

  if (timed.timedOut) return "rejected";
  if (!timed.value.ok) return "rejected";
  return timed.value.response.results.some((result) => result.flagged) ? "rejected" : "allowed";
};
