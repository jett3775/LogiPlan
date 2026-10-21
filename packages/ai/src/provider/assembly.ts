/**
 * 供应商客户端装配入口（门 C，D-192 阶段 2）——`@logiplan/ai/provider`。
 *
 * ## 为什么这一层存在
 *
 * 两条既有的边界约束把它逼出来了：
 * 1. **AC3.3**（`supplier-neutrality.test.ts`）：`apps/web`、`packages/ai`、`packages/db`、
 *    `packages/domain`、`packages/contracts` **不得导入供应商 SDK**；`packages/ai-provider-*`
 *    是唯一允许持有 SDK 的地方。
 * 2. **适配器包的边界自证**（`ai-provider-openai/src/neutral-boundary.test.ts`）：
 *    该包**只被 `packages/ai` 依赖**，且**不得**从 `packages/ai` 的 barrel 导出。
 *
 * 于是真实客户端的构造必须落在适配器包内（1），而调用方只能是 `packages/ai`（2）。
 * 本文件就是那个唯一的调用方：**子路径**导出（不是 barrel），因此既不会把供应商 SDK
 * 带进浏览器包，也不会破坏「barrel 不导出适配器包」的断言。
 *
 * ## 与主 barrel 的关系
 *
 * 本模块**不在** `packages/ai` 的主 barrel 里（`index.ts` 不导出它）。`no-live-call.test.ts`
 * 有一条从 `index.ts` 出发的静态可达性断言，锁死「主 barrel 不可达供应商适配器包」。
 */

export {
  createDeepSeekAdapterFromApiKey,
  type DeepSeekAdapterFromApiKeyOptions,
} from "@logiplan/ai-provider-deepseek";
export {
  createOpenAiAdapterFromApiKey,
  type OpenAiAdapterFromApiKeyOptions,
} from "@logiplan/ai-provider-openai";
