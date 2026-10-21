# `@logiplan/ai-provider-deepseek`

DeepSeek Responses API 的供应商适配器。它把中立请求映射为 `/responses` 请求，并把已完成的结构化 JSON、用量、延迟、成本和错误映射回 LogiPlan 的适配器契约。

本包的核心适配器只接受调用方注入的最小客户端、提示词与 JSON Schema 解析器、价格版本和 `CostLookup`：它不读取环境变量或密钥，不发起真实网络调用，不实现重试，也不包含业务查询、证据生成或数值判断。真实网络能力只存在于激活接缝 `client.ts` 与 `createDeepSeekAdapterFromApiKey`：密钥作为参数传入、不读环境，网络能力以 `fetch` 注入，单次尝试、无内部重试。价格未知时返回保守的 `Infinity`，使中立层保留预算预留；这不代表真实费用已经结算。缓存 token、峰谷价格和价格变更应在未来的版本化中立价格表中处理，推理 token 已包含在供应商报告的输出 token 内。

固定能力声明仅把 `structuredOutput` 与 `reasoningControl` 标为 `true`；`dataRetentionToggle`、`safetyIdentifier` 与 `moderation` 固定为 `false`，不可由构造参数覆盖。三个角色按 D-193 决策二只要求前两项能力，能力门据此放行。真实 HTTP 客户端只在门 C 下由装配层构造（`LOGIPLAN_AI_LIVE_CALLS=1` 且 `DEEPSEEK_API_KEY` 非空）；开关关闭时不构造适配器，零真实调用。推理强度按 D-193 决策二映射：`minimal → "none"`、`low → "low"`，避免思考模式占用 400 token 输出预算。20 题评估尚未执行，`verified` 仅表示契约与能力兼容，不表示评估通过。

协议依据（核查日期：2026-10-20）：

- <https://api-docs.deepseek.com/api/create-response/>
- <https://api-docs.deepseek.com/guides/responses_api/>

包内测试全程使用注入替身，零真实调用、零付费。
