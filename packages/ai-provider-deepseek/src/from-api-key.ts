import { createDeepSeekAdapter, type CostLookup, type DeepSeekAdapterHooks } from "./adapter";
import { createDeepSeekHttpClient, type DeepSeekFetch } from "./client";
import type {
  DeepSeekResponsesClient,
  JsonSchema,
  ProviderAdapter,
} from "./types";

/**
 * 由 API key 装配真实 DeepSeek 适配器（门 C 激活入口）。
 *
 * 密钥只**接收**、不读取环境变量；返回值与抛出的错误都不含密钥。缺少密钥即抛错——
 * 装配方负责在缺密钥时**不调用**本函数，而不是静默降级（D-193 决策五）。
 */

export interface DeepSeekAdapterFromApiKeyOptions {
  /** 服务端环境变量读出的密钥；只用于构造客户端，不外泄。 */
  readonly apiKey: string;
  readonly priceVersion: string;
  /** 注入的美元价格查询函数（单一来源在 `packages/ai` 的 `pricing.ts`）。 */
  readonly costLookup: CostLookup;
  /** 提示词版本 → 文本；未知版本返回 `null`（失败关闭）。 */
  readonly resolveSystemPrompt: (version: string) => string | null;
  /** 输出模式版本 → 中立 JSON Schema；未知版本返回 `null`（失败关闭）。 */
  readonly resolveOutputSchema: (version: string) => JsonSchema | null;
  /** 可选注入的客户端（测试用）；缺省构造真实 HTTP 客户端。 */
  readonly client?: DeepSeekResponsesClient;
  /** 注入的网络能力（测试用）；缺省使用全局 `fetch`。 */
  readonly fetchImpl?: DeepSeekFetch;
  readonly baseUrl?: string;
  readonly hooks?: DeepSeekAdapterHooks;
}

export const createDeepSeekAdapterFromApiKey = (
  options: DeepSeekAdapterFromApiKeyOptions,
): ProviderAdapter => {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new Error("DeepSeek adapter requires a non-blank apiKey");
  }
  const client =
    options.client ??
    createDeepSeekHttpClient({
      apiKey: options.apiKey,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
  return createDeepSeekAdapter({
    client,
    priceVersion: options.priceVersion,
    costLookup: options.costLookup,
    resolveSystemPrompt: options.resolveSystemPrompt,
    resolveOutputSchema: options.resolveOutputSchema,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
};
