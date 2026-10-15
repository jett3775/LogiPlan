/**
 * 真实客户端装配入口（门 C，D-192 阶段 2）。
 *
 * ## 为什么装配代码放在本包，而不是 `apps/web`
 *
 * AC3.3（`packages/ai/src/supplier-neutrality.test.ts`）脚本化断言 `apps/web`、`packages/ai`、
 * `packages/db`、`packages/domain`、`packages/contracts` **未导入任何供应商 SDK**；本包是**唯一**
 * 允许持有供应商 SDK 的地方。因此 `apps/web` 只能调用本函数并传入 API key，**不得**自己
 * `import "openai"`。
 *
 * ## `maxRetries: 0` 是硬要求
 *
 * SDK 自带重试（默认 2 次）发生在**适配器内部**，中立层看不到那几次尝试，会让
 * `GatewayOutcome.spend.cost_complete` 误判为「成本完整」而**少记支出**、使月度上限可被击穿
 * （D-192 决策七）。重试的唯一归属是 `packages/ai` 的 `gateway/retry-policy.ts`。
 *
 * ## 密钥边界
 *
 * 本函数只**接收** API key，不读取任何环境变量（由装配层 `apps/web` 从服务端环境读出后传入）；
 * 返回值与抛出的错误都**不含**密钥。
 */

import OpenAI from "openai";

import { createOpenAiAdapter, type OpenAiAdapterHooks } from "./adapter";
import type { OpenAiResponsesClient } from "./client-types";
import type { JsonSchema, ProviderAdapter } from "./contract";
import type { CostLookup } from "./cost";

export interface OpenAiAdapterFromApiKeyOptions {
  /** 服务端环境变量读出的密钥；**只**用于构造客户端，不外泄。 */
  readonly apiKey: string;
  /** 匿名派生值；不得传原始 IP 或 User-Agent（D-138、D-181）。 */
  readonly safetyIdentifier: string;
  readonly priceVersion: string;
  /** 注入的美元价格查询函数（单一来源在 `packages/ai` 的 `pricing.ts`）。 */
  readonly costLookup: CostLookup;
  /** 提示词版本 → 文本；未知版本返回 `null`（失败关闭）。 */
  readonly resolveSystemPrompt: (version: string) => string | null;
  /** 输出模式版本 → 中立 JSON Schema；未知版本返回 `null`（失败关闭）。 */
  readonly resolveOutputSchema: (version: string) => JsonSchema | null;
  /** 可选注入的客户端（测试用）；缺省构造真实 SDK 客户端。 */
  readonly client?: OpenAiResponsesClient;
  readonly hooks?: OpenAiAdapterHooks;
}

/**
 * 由 API key 装配真实 OpenAI 适配器。
 *
 * 缺密钥即抛错——本函数**不**做「缺配置就静默降级」：装配层负责在缺密钥时**不调用**本函数。
 */
export const createOpenAiAdapterFromApiKey = (
  options: OpenAiAdapterFromApiKeyOptions,
): ProviderAdapter => {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new Error("OpenAI adapter requires a non-blank apiKey");
  }
  const client =
    options.client ??
    // `maxRetries: 0`：见文件头。SDK 客户端在结构上满足本包的最小客户端面。
    (new OpenAI({ apiKey: options.apiKey, maxRetries: 0 }) as unknown as OpenAiResponsesClient);
  return createOpenAiAdapter({
    client,
    safetyIdentifier: options.safetyIdentifier,
    priceVersion: options.priceVersion,
    costLookup: options.costLookup,
    resolveSystemPrompt: options.resolveSystemPrompt,
    resolveOutputSchema: options.resolveOutputSchema,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
};
