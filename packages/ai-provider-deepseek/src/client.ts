import type { DeepSeekResponsesClient } from "./types";

/**
 * DeepSeek 真实客户端（门 C 激活接缝）。
 *
 * ## 为什么网络能力是注入的
 *
 * 本包其余部分保持 dormant：适配器只调用注入的 `DeepSeekResponsesClient`，不读环境、
 * 不直接发起网络请求。真实 HTTP 能力集中在**本文件**这唯一的激活接缝里，由装配方
 * （`packages/ai` 的 `provider/assembly.ts`）显式构造并注入。
 *
 * ## 硬约束
 *
 * - **不读环境变量**：密钥只作为参数传入，由装配方从服务端环境读出（D-177）。
 * - **单次尝试、无内部重试**：重试唯一归属中立网关（D-192 决策七）。
 * - **不新增 SDK 依赖**：使用调用方注入的 `fetch` 兼容函数。
 * - 错误只携带 HTTP status，不回传响应正文或密钥；供应商错误由适配器映射为中立案码。
 */

/** 单次 HTTP 调用接受的响应面；`globalThis.fetch` 的返回值在结构上满足本接口。 */
export interface DeepSeekHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type DeepSeekFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<DeepSeekHttpResponse>;

export interface DeepSeekHttpClientOptions {
  /** 服务端环境变量读出的密钥；**只**用于请求头，不外泄。 */
  readonly apiKey: string;
  /** 注入的网络能力；缺省使用运行时的全局 `fetch`。 */
  readonly fetchImpl?: DeepSeekFetch;
  readonly baseUrl?: string;
}

/** DeepSeek Responses API 基址。 */
export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";

/** 供应商错误：只带 status，供适配器映射为中立错误码。 */
const providerHttpError = (status: number): Error =>
  Object.assign(new Error("DeepSeek response failed"), { status });

export const createDeepSeekHttpClient = (
  options: DeepSeekHttpClientOptions,
): DeepSeekResponsesClient => {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new Error("DeepSeek client requires a non-blank apiKey");
  }
  const fetchImpl =
    options.fetchImpl ??
    (globalThis.fetch.bind(globalThis) as unknown as DeepSeekFetch);
  const baseUrl = options.baseUrl ?? DEEPSEEK_API_BASE_URL;

  return {
    responses: {
      create: async (body, { signal }) => {
        const response = await fetchImpl(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) throw providerHttpError(response.status);
        return await response.json();
      },
    },
  };
};
