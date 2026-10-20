# `@logiplan/ai-provider-deepseek`

DeepSeek Responses API 的未激活供应商适配器。它把中立请求映射为 `/responses` 请求，并把已完成的结构化 JSON、用量、延迟、成本和错误映射回 LogiPlan 的适配器契约。

本包只接受调用方注入的最小客户端、提示词与 JSON Schema 解析器、价格版本和 `CostLookup`。它不读取环境变量或密钥，不创建 HTTP 客户端，不发起真实网络调用，不实现重试，也不包含业务查询、证据生成或数值判断。价格未知时返回保守的 `Infinity`，使中立层保留预算预留；这不代表真实费用已经结算。缓存 token、峰谷价格和价格变更应在未来的版本化中立价格表中处理，推理 token 已包含在供应商报告的输出 token 内。

固定能力声明仅把 `structuredOutput` 与 `reasoningControl` 标为 `true`；`dataRetentionToggle`、`safetyIdentifier` 与 `moderation` 固定为 `false`，不可由构造参数覆盖。低层 `invoke` 可用于协议兼容测试，但不表示满足正式角色的安全条件。当前三个角色要求全部五项能力，因此现有中立网关会在调用客户端前失败关闭。正式激活还需单独完成受控角色配置、价格、客户端装配、完整评估与发布审批。

协议依据（核查日期：2026-10-20）：

- <https://api-docs.deepseek.com/api/create-response/>
- <https://api-docs.deepseek.com/guides/responses_api/>

本轮全程使用注入替身，零真实调用、零付费。
