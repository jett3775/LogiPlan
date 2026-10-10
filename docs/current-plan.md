# LogiPlan 当前工作计划（滚动文档）

最后更新：2026-10-09。适用窗口：从计划执行日起一个工作日，净工作预算 **8 小时（480 分钟）**，不指定日历起止时刻。

本文件每轮覆盖更新，只保留当前状态、当天任务和顺延项。用户已指定将滚动计划与项目交接保存在仓库；历史交接保留原文件。最新接续入口为 [handoff-2026-10-09.md](handoff-2026-10-09.md)。**本次仅更新文档；下列阶段全部待执行，估时不代表完成承诺。**

> **2026-10-09 晚些时候的增补（本文件写入之后发生，由主 Agent 追加）**：本文件写入后，同一窗口又完成一件事，**其余内容不受影响**。
> ① 本地 `main` 由 `402cff65` → **`3bd6f338`**（新增 `c837ac6e`：`packages/ai` 纳入覆盖率门；`3bd6f338`：该 CI 证据回填），与 `origin/main` 同步。
> ② **阶段 3 的前提已变**：经用户批准扩大写范围，`vitest.config.ts` 的 `coverage.include` 新增 `packages/ai/src/**/*.ts`，并新增阈值组（lines 85 / statements 83 / functions 75 / branches 78）。实测 **89.87% lines / 86.81% statements / 78.49% functions / 81.49% branches**，`pnpm test:coverage` 退出码 0，CI run `37910980424` 全绿且实测与本机**逐项一致**。故「AI 包覆盖率未知、只测不达标、不改配置与阈值」**不再成立**——**阶段 3 视为已完成**，AI 专项测量已并入默认 `coverage.include`（原先的 `--coverage.include` 覆盖式测量不再需要）。
> ③ **阶段 1（A：运行时密钥隔离）与阶段 2（B：只读用量受控失败）未受影响，仍然有效**；阶段 4 / 5 / 6 照旧。唯一新增的写范围偏差是 `vitest.config.ts`（见 §2「禁止扩写」行）。`vitest.config.ts` 不在 `scripts/neon-baseline.mjs` 的 `executionClosurePaths` 内，**不触发工具 SHA 重锚定**。

## 1. 总体目标与当前位置

项目主线是：**确定性异常识别 → 英国下钻与五因素归因 → 数字级证据 → 受控真实 AI 管理分析 → 20 题验收**。业务口径见 [CONTEXT.md](../CONTEXT.md)，阶段与冻结规则分别见 [开发路线](development-roadmap.md)、[决策](decisions.md) 和 [查询契约](query-contract.md)。

| 层次                | 当前状态或完成条件                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 确定性页面与证据    | 闸门一已有代码、CI 与生产验收记录；稳定性权威证据仍按 D-188 取 CI ubuntu，本地证据单列                            |
| 闸门二切片 1a / 1b  | 已收口；2026-10-08 的生产 Promote 记录为 `3308ced5`                                                               |
| 闸门二切片 2        | 主体 `21cef684`、AC2.11 CLI `675290a8` 已完成代码、审查和 CI 收口；没有该切片独立生产发布记录                     |
| 当天目标            | 加固切片 2 的运行时密钥隔离与只读用量入口，形成可复验的本地交付包                                                 |
| 后续切片 3          | 门 B、C 均开启后才能开工：供应商适配器、网关及首次真实调用                                                        |
| 后续切片 4 / 闸门二 | 20 题均须真实生成，至少 18/20，E19、E20 全通过；数字按 4 位小数精确一致，语义由人工复核；固定示例不能充当通过证据 |

截至编写时，本地 `main` 的 HEAD 为 `402cff65`，文档写入前工作区干净；未 fetch，不能据此声称远端最新状态。**2026-10-09 晚些时候更新**：HEAD 已推进至 **`3bd6f338`**（见文首增补），与 `origin/main` 同步。CI 历史记录为 run `37867164623`（`21cef684`）与 `37868916338`（`675290a8`）全绿；历史全量测试为 **309 passed / 11 skipped（320）**，不是本次实跑。

生产历史 P95 **511.312 ms** 来自 2026-10-08 的 100 请求、并发 5 测量，不是当前 HEAD 的新性能结论。生产状态、回切及部署细节只查 [runbook §11.5、§12](neon-vercel-baseline-runbook.md)，本计划不重复发布步骤。

## 2. 当天工作流边界

**objective**：修复同一 Redis 下主密钥变化仍复用旧运行时的问题；使 `runReadMonthlyUsage` 的读取异常返回受控失败，并用行为断言证明读操作不触发计费、限流或熔断状态改变。

**level**：未来代码实施为 **L2**，涉及匿名身份与费用控制面。由同一个 `slice_owner` 连续实现、自测、返工，再由独立 `independent_auditor` 审查。本次两份文档的事实同步为 L1，不等于已执行 L2 工作。

**acceptance**：阶段 1、2 的行为验收均通过；取得 AI 包完整测试范围的覆盖率测量；阶段 4 完整 L2 矩阵通过；独立审查通过；证据区分通过、失败、跳过、未执行。任一必需检查未完成，交付状态只能是“未完成 / 待验证”。

**relevant_files / write_scope**：

| 用途            | 文件与权限                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A：运行时隔离   | 仅改 `packages/ai/src/control-plane/server.ts`、`server.test.ts`（同目录）                                                                                                                                  |
| B：只读用量入口 | 仅改 `packages/ai/src/read-monthly-usage.ts`、`read-monthly-usage.test.ts`（同目录）                                                                                                                        |
| 最终有效结论    | 阶段 6 仅更新本文件与 `docs/handoff-2026-10-09.md`                                                                                                                                                          |
| 只读参照        | `control-plane.ts`、`anonymous-id.ts`、`circuit-breaker.ts`、`budget-ledger.ts`、`redis-like.ts`、`test-doubles.ts`（均在 `packages/ai/src/control-plane/`）；`vitest.config.ts`、根与 AI 包 `package.json` |
| 禁止扩写        | 其他源码、测试、配置、依赖、锁文件、AGENTS、冻结决策、查询契约、闸门设计、路线图、历史交接（**唯一例外**：`vitest.config.ts` 的 `coverage.include` 与阈值，经用户批准于 2026-10-09 单独修改，见文首增补）   |

**invariants**：

- AI 输出继续为 `FIXED_EXAMPLE`；不新增 provider 包，不改变产品供应商或模型路由。
- 门 A 仅授权既有 `@upstash/redis` 依赖；门 B（`openai` 依赖）、门 C（真实付费调用）未开。[切片实施计划 §5](gate2-implementation-plan.md) 明确二门均开前切片 3 不得开工。
- 不改匿名派生算法、冻结限流/熔断参数、月度 30 元同池预算、价格与汇率版本；不改精确数值、证据原子性、失败关闭和服务端基础设施隔离。
- 密钥、token、连接串及底层异常不进入输出或报告；只记录配置是否存在及受控结果。
- 不使用真实 Redis、真实密钥、付费 API 或外部账户；不提交、暂存、创建分支、远程写入或部署。已有未提交改动视为用户资产。

**verification**：各阶段定向命令 + `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` + 既有覆盖率检查、AI 专项测量、独立审查。数据库和页面没有改动时不追加其专项验收；若影响扩展到这些层，先由主 Agent 重评范围。

**risks**：8 小时包括审查返工，可能不足；覆盖率测值未知；运行时缓存修改不能破坏同配置下跨请求 L1 累计；替身不能证明真实 Upstash 原子性。遇到范围扩大、冻结口径不清或外部操作，停止相关写入并交主 Agent。

## 3. 面向 DeepSeek v4.1 Flash 的执行方式

用户指定 **DeepSeek v4.1 Flash 作为开发执行模型**；[DeepSeek 官方更新记录](https://api-docs.deepseek.com/updates/)已列出该系列发布。下列小步组织方式是工程规划假设，不使用未经验证的能力分数，也不表示将产品 LLM 供应商切换为 DeepSeek。

1. 主 Agent 每次只交一个阶段；执行者先复述目标、允许文件、不变量与验收，再读取该阶段入口。阶段内按编号顺序做最小改动。
2. 每个实现阶段完成后立即跑定向测试；失败先定位原因，不删用例、不放宽断言、不改冻结数字来制造通过。
3. 可从代码或文档回答的问题先查证；不得猜测业务、权限或接口。超出四个源码/测试文件的修改，先返回主 Agent 重评。
4. 每阶段只交付：改动文件、命令与退出码、关键结果、未执行项及原因、下一步。保存最终有效结论，不保存逐次 Agent 对话和原始日志。
5. 项目仍遵守 [多 Agent 工作流](multi-agent-workflow.md)：单点写入、独立审查、问题回原 owner 修复及原 auditor 复查；两轮修复—复查仍失败即停止并由主 Agent 提一个决策问题。
6. 不自动修改 AGENTS 或协作配置。未来运行者如使用 DeepSeek，应记录与仓库首选配置的偏差及实际可知模型；若平台无法路由该模型，如实交回主 Agent，不声称已使用。模型选择不降低 L2 验证与独立审查。

本次**文档实现**的配置偏差：L1 首选 `gpt-5.6-terra / medium` 未出现在运行环境可用列表，按工作流 §2.6 使用环境默认模型；实际精确模型 ID 与推理强度未暴露，记为未知。此记录不代表未来代码阶段已经由 DeepSeek 执行。

## 4. 一个工作日排期

| 阶段     | 任务                                                                       |                净预算 | 初始状态 |
| -------- | -------------------------------------------------------------------------- | --------------------: | -------- |
| 0        | 复核基线、范围与执行环境                                                   |               30 分钟 | 待执行   |
| 1        | A：运行时密钥隔离与回归                                                    |               90 分钟 | 待执行   |
| 2        | B：只读用量受控失败与副作用断言                                            |               90 分钟 | 待执行   |
| 3        | ~~既有覆盖率检查、AI 包覆盖率测量~~ **已于 2026-10-09 完成（见文首增补）** |               60 分钟 | 已完成   |
| 4        | 完整 L2 回归与差异检查                                                     |               90 分钟 | 待执行   |
| 5        | 独立审查与必要返工                                                         |               90 分钟 | 待执行   |
| 6        | 最终证据与交接                                                             |               30 分钟 | 待执行   |
| **合计** |                                                                            | **480 分钟 / 8 小时** |          |

所有命令均从仓库根目录、PowerShell 执行，使用现有依赖。每条命令单独运行并记录退出码；上一条失败不得被下一条成功覆盖。

### 阶段 0：基线与最小交接（30 分钟）

**前置 / 只读入口 / 写范围**：先读 [AGENTS](../AGENTS.md)、工作流 §5 / §8 / §10、[切片实施结果 §4.1](gate2-implementation-plan.md) 及上表列出的代码；本阶段不写文件。

1. 运行基线命令，记录实际 HEAD、已有改动、Node / pnpm 版本；若已偏离 `402cff65`，只读核对受影响差异，不能回退。
2. 阅读四个目标文件和既有测试，确认 `runtimeByRedis` 与 `runReadMonthlyUsage` 仍为问题入口。
3. 确认测试只注入替身；检查拟用命令的配置加载方式，不打印 `.env`。构建若需要数据库，只能使用已确认的本地隔离环境，不能默用真实连接。
4. 主 Agent 将 §2 的八项整理为最小交接包，记录执行模型、验证环境及偏差，再进入阶段 1。

```powershell
git status --short --branch
git rev-parse HEAD
node --version
pnpm --version
pnpm exec vitest run packages/ai/src/control-plane/server.test.ts packages/ai/src/read-monthly-usage.test.ts
```

**验收**：基线差异归属清楚，四文件边界成立，既有定向测试退出 0。**失败处理**：环境失败与代码失败分别记录；依赖缺失先交主 Agent，不改清单或锁文件。基线异常未澄清，不进入修复。

### 阶段 1：运行时密钥隔离（90 分钟）

**前置**：阶段 0 通过。**只读入口**：`server.ts` 的 `productionRedisByCredentials`、`runtimeByRedis`、`createControlPlaneFromEnvironment`，及匿名派生、L1 既有测试。**写范围**：仅 A 两文件。

1. 补能暴露旧行为的测试：同 Redis + 同 secret 复用；同 Redis + 不同 secret 不复用旧身份配置；不同 Redis 隔离。固定时钟与请求输入，用 `deriveAnonymousId` 验证主密钥变化后的匿名派生值变化。
2. 修改 `runtimeByRedis` 的配置身份；推荐每个 Redis 仅保存“当前 secret 的不可逆摘要 + runtime”，摘要相同复用、变化替换，避免另建按每个历史 secret 无限增长的嵌套缓存。先按源码确认实现；不能只改生产 Redis 的 url/token 缓存。
3. 保留同配置跨请求累计 L1 的测试，并覆盖再次使用新 secret 时的复用；检查密钥缺失仍返回 `null`。摘要只在服务端内存使用，不输出原值或摘要。
4. 运行定向测试、AI 类型检查及两文件格式检查；检查 diff，禁止顺带迁移 L1 到 Redis 或重构其他缓存。

```powershell
pnpm exec vitest run packages/ai/src/control-plane/server.test.ts
pnpm --filter @logiplan/ai typecheck
pnpm exec prettier --check packages/ai/src/control-plane/server.ts packages/ai/src/control-plane/server.test.ts
git diff -- packages/ai/src/control-plane/server.ts packages/ai/src/control-plane/server.test.ts
```

**验收**：同配置复用、轮换后用新身份、再次同配置复用、不同 Redis 隔离均有断言；第 4 次不熔断、第 5 次熔断的既有行为继续通过；无新增外部调用或输出泄漏。

**失败处理**：若修改改变冻结熔断语义或需要改其他模块，停止写入并交主 Agent。既有 url/token 缓存容量问题不在本阶段修复。

### 阶段 2：只读用量入口（90 分钟）

**前置**：阶段 1 通过。**只读入口**：`runReadMonthlyUsage`、`USAGE_UNAVAILABLE_MESSAGE_ZH`、`readMonthlyUsage`、`FailingRedisLike`、L1 方法。**写范围**：仅 B 两文件。

1. 明确现状：CLI 顶层 `.catch` 已受控，程序化调用 `runReadMonthlyUsage` 遇 `budgetRead` rejection 仍会抛出。将异常统一收敛为既有 `ok: false` 结果，沿用固定中文文案，不暴露底层异常。
2. 优先复用既有失败替身，并在测试文件内用 spy 或局部替身统计调用；模拟错误文本含伪造 URL、token、secret，断言输出只含固定文案。不得使用真实凭据。
3. 对成功和读取失败两条路径断言：`budgetRead` 恰调用一次；`budgetReserve`、`budgetSettle`、`slidingWindow` 调用增量均为 0；同时探测 `recordSuccess`、`recordTransientFailure` 等写状态入口，防止仅凭“open 仍 open”漏检。
4. 保留未配置路径和五字段报告契约；覆盖只读入口不会经 `evaluateControlPlane` / `recordProviderAttemptOutcome` 间接改状态。用现有测试边界选最小观测方式，不改公共接口。
5. 运行两阶段合并定向测试、类型检查、格式检查。若现有替身不能在测试文件内完成观测，返回主 Agent 申请最小扩范围，不默改 `test-doubles.ts`。

```powershell
pnpm exec vitest run packages/ai/src/control-plane/server.test.ts packages/ai/src/read-monthly-usage.test.ts
pnpm --filter @logiplan/ai typecheck
pnpm exec prettier --check packages/ai/src/read-monthly-usage.ts packages/ai/src/read-monthly-usage.test.ts
```

**验收**：读取异常不向调用方泄露 rejection 或底层消息；成功报告恰含 `month / used_cny / cap_cny / price_version / fx_version`；成功、失败读取均不计费、不限流、不改熔断。缺配置路径继续受控。

**失败处理**：不扩大失败文案或公开接口，不用真实 Redis 排错。`pnpm --filter @logiplan/ai run usage` 会自动加载根 `.env`，**本日不直接执行该入口**；使用 Vitest 注入替身验证。

### 阶段 3：覆盖率检查与测量（60 分钟）——**已于 2026-10-09 完成**

> **2026-10-09 晚些时候：本阶段已完成，见文首增补**——`packages/ai` 已进 `coverage.include` 并有专属阈值，故下列「不改配置、阈值」与「只能称已测量」的表述**不再适用**，原文保留作历史记录。

**前置**：阶段 2 通过。**只读入口**：`vitest.config.ts` 与 AI 全量测试。**写范围**：仅可生成已忽略的 `coverage/` 产物，本阶段不改配置、阈值或源码。

1. 先跑既有 `pnpm test:coverage`，保留其对 contracts / domain / db 的既定门槛。
2. 再跑 AI 包全部测试并用 CLI 指定 AI 源码范围，测量当前基线；核对报告确实包含 `packages/ai/src/**/*.ts` 且排除测试文件，不能把只跑两文件的结果称为包覆盖率。
3. 分别记录 lines / statements / functions / branches、关键未覆盖分支、实际包含范围及命令退出码。读取两份独立摘要，不覆盖或混同结果。

```powershell
pnpm test:coverage
pnpm exec vitest run packages/ai/src --coverage --coverage.include='packages/ai/src/**/*.ts' --coverage.reporter=text --coverage.reporter=json-summary --coverage.reportsDirectory=coverage/ai-baseline
```

**验收**：既有覆盖率检查退出 0；AI 测量有可核对的范围、四项数值和缺口。当前没有 `packages/ai` 专属覆盖率门槛，因此结果只能称“已测量”，不能称“AI 覆盖率达标”。报告分别为 `coverage/coverage-summary.json`、`coverage/ai-baseline/coverage-summary.json`。

**失败处理**：CLI include 行为不符时先查本机 Vitest help；不修改 `vitest.config.ts`、不新增依赖、不设置 `thresholds.autoUpdate`、不降低既有阈值。与 A / B 无关的覆盖缺口顺延。

### 阶段 4：完整 L2 回归（90 分钟）

**前置**：阶段 3 结果已记录；使用阶段 0 确认的隔离环境。**只读入口**：根脚本、Web 类型配置与四文件 diff。**写范围**：构建/检查产物；若需修复，只能回到原 owner 的四文件范围。

1. 顺序执行完整 L2 矩阵；类型检查额外禁用 Web 增量模式复验，避免陈旧 `tsbuildinfo` 假绿，不递归删除仓库或 `.next`。
2. 每条记录退出码和实际测试计数，核对 skipped 原因；历史 309 / 11 不作为本轮必须相同的计数。
3. 检查差异只有允许文件和可识别产物，无锁文件/配置变化，无真实凭据进入差异。
4. 本日不改页面、数据库或公开接口，故数据库迁移/权限/查询计划与浏览器专项不适用；这不构成合并、部署或阶段闸门验收。若发现实际影响这些层，停止并重评范围及预算。

```powershell
pnpm test
pnpm typecheck
pnpm --filter @logiplan/web exec tsc --noEmit --incremental false
pnpm lint
pnpm format:check
pnpm build
git diff --check
git status --short
```

**验收**：五项 L2 必需命令及无增量类型复验退出 0，差异范围正确。**失败处理**：不为赶时限跳过检查；若 build 被工具策略或环境阻断，记录实际失败/阻断与未完成项，交用户终端按同命令补证，不关闭安全保护。修复后重跑受影响检查；若阶段 5 又改代码，相应验证结论需更新。

### 阶段 5：独立审查与返工（90 分钟）

**前置**：owner 自测与阶段 4 完成。**只读入口**：四文件 diff、§2 不变量、各命令结果、覆盖率摘要。**写范围**：auditor 不写源码/文档；必要修复回原 owner 的四文件范围。

1. 主 Agent 创建独立 auditor，交付工作流 §5 的最小包，以及 `changed_files / implementation_summary / invariants_checked / tests_run / tests_not_run / remaining_risks / git_status_delta`。
2. auditor 先记录 Git 状态，再检查密钥身份与缓存复用、只读副作用、失败输出、服务端隔离及范围；至少独立复跑两文件定向命令，必要时增加验证。
3. 问题回原 owner 修复；owner 自测后，由原 auditor 定向复查。两轮仍未通过必须停止，不能换审查者绕过问题。
4. 审查通过后由主 Agent验收；若返工改变测量结果，重跑受影响的覆盖率和回归，更新最终证据。

```powershell
git status --short
git diff -- packages/ai/src/control-plane/server.ts packages/ai/src/control-plane/server.test.ts packages/ai/src/read-monthly-usage.ts packages/ai/src/read-monthly-usage.test.ts
pnpm exec vitest run packages/ai/src/control-plane/server.test.ts packages/ai/src/read-monthly-usage.test.ts
```

**验收**：独立结论为 PASS，无阻断问题，必需验证齐全。**失败处理**：预算耗尽或未通过均保留非破坏性改动，标记未完成，顺延剩余工作；不省略审查来换取“当天完成”。

### 阶段 6：最终证据与接续（30 分钟）

**前置**：前序结果已经确定，包括失败或未执行。**只读入口**：最终 diff、实际命令摘要、审查结论。**写范围**：仅本文件与 [最新交接](handoff-2026-10-09.md)。

1. 写入最终有效结论：实际 HEAD、改动文件、行为验收、覆盖率四项数值、命令退出码、跳过/未执行项、审查结果、模型偏差、剩余风险。
2. 区分“代码与本地验证完成”“生产已发布”“闸门二通过”，后两者本日没有相应操作和证据；不把本地结果回写为生产状态。
3. 状态只按实测更新；未完成阶段保留待执行及下一步。校验两文件格式、相对链接、差异范围，再由主 Agent 接收。

```powershell
pnpm exec prettier --check docs/current-plan.md docs/handoff-2026-10-09.md
git diff --check
git status --short
```

**验收**：文档能让下一会话按入口复验，所有未执行项显式保留；没有新增逐次工作日志、提交或部署。**失败处理**：事实与证据不一致时先修文档，不能修改验收口径迎合结果。

## 5. 超时与顺延

优先保证已改动部分的测试和独立审查。阶段 1 超时尚未开始 B 时，可由主 Agent 将 B 整体顺延，明确当天目标仅部分完成；已写入的 B 不能因时间不足跳过验证。覆盖测量、完整矩阵或审查没完成时，保留“待验证”，不得宣称工作流完成。

以下不纳入当天 8 小时：

- **真实 AI 与 20 题评估**：门 B、C 未开；后续依 [切片实施计划 §5、§6](gate2-implementation-plan.md) 单独启动。开发、排错、评估调用同池计入月度 30 元，不为实施绕过 L2。
- **多快照恢复**：15 条证据跨 4 个快照，回答契约只有单值快照 ID；逐条证据可打开，但页面恢复能力尚不成立。需 contracts / 查询契约的独立 L2 工作流。
- **真实基础设施与其他 P2**：Upstash Lua 原子性、真实 Redis 读取成功路径、跨实例 L1、原 url/token 缓存容量、真实审计 sink、XFF 语义、动态 import 可达性断言分别留待后续，不随 A / B 扩写。
- **环境与发布**：Windows `3221226505 = 0xC0000409` 根因仍未定性；2026-10-08 一轮取证未命中，维持 D-188，见 [取证文档](windows-crash-evidence.md)。部署、合并与阶段闸门前另补覆盖率、完整 Playwright、性能和可访问性验证；历史生产结果不能替代。
