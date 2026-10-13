# LogiPlan 本周开发进度与计划

最后更新：2026-10-13（**§6—§10 为执行结果**，正文其余部分为 2026-10-12 制定的本周计划）。适用窗口：**2026-10-12（周一）至 2026-10-18（周日）**，按上海日期；主要工作安排在 10-12—10-16，周末预留，不设必须开发任务。

**本次仅更新本文件，未执行下列代码任务。** A/B 修复工作流的净工时估算为 **8 小时**，包含回归、审查和必要返工，不计已完成的覆盖率配置任务，也不代表 40 小时周预算或完成承诺。历史交接保留在 [handoff-2026-10-09.md](handoff-2026-10-09.md)，本周状态以本文件为接续入口。

## 1. 当前进度与证据边界

确定性查询、英国下钻、五因素归因和数字证据链已有闸门一代码、CI 与生产验收记录。AI 仍输出 `FIXED_EXAMPLE`，真实模型接入和 20 题真实生成评估尚未实施，闸门二尚未通过。业务、阶段与冻结规则分别以 [CONTEXT](../CONTEXT.md)、[开发路线](development-roadmap.md)、[决策](decisions.md) 和 [查询契约](query-contract.md) 为准。

| 工作项             | 当前状态与证据边界                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 闸门二切片 1a / 1b | 已收口；2026-10-08 生产 Promote 记录为 `3308ced5`                                                                                                                |
| 闸门二切片 2       | 主体 `21cef684`、只读 CLI `675290a8` 已实现、审查及 CI 收口；没有该切片独立生产发布记录                                                                          |
| AI 覆盖率纳入门槛  | 2026-10-09 已完成：配置提交 `c837ac6e`，证据回填 `3bd6f338`；默认覆盖率检查已包含 AI 包                                                                          |
| A：运行时密钥隔离  | **已实施并验收（2026-10-12）**：`runtimeByRedis` 改按「Redis 实例 + 当前主密钥的不可逆摘要」缓存，摘要变化即替换条目；工作区未提交                               |
| B：只读用量失败    | **已实施并验收（2026-10-12）**：`runReadMonthlyUsage` 将 `budgetRead` 异常收敛为既有 `ok:false` 固定文案；工作区未提交                                           |
| C：Lua 返回值精度  | **已修复并验收（2026-10-13）**：真实 Upstash 验证暴露 Lua 返回值被截断为整数（审计字段 `budget_used_cny` 少报）；改为 `tostring` 返回并新增受门控集成测试；见 §9 |
| D：跨实例 L1 熔断  | **已实施并验收（2026-10-13）**：L1 状态由进程内存迁到注入的 `RedisLike`（3 个原子脚本 + 键 + TTL），**跨实例一致已用真实 Upstash 验证**；工作区未提交；见 §10    |
| 切片 3 / 4         | 待前置验证和授权；切片 3 须门 B、C 均开启，之后才具备真实生成评估的实施条件                                                                                      |

本次只读核查的本地基线为 `main / 8ab93f4581423ede29a10d51138c2f6134674067`（10-10 文档提交），写入前工作区干净。未 fetch，也未查询线上状态，不能据此断言最新远端或当前生产状态。

以下均为**历史验证**，没有在本次文档更新中重跑：

- 切片 2 主体与 CLI 的 CI run `37867164623`、`37868916338` 全绿；全量测试记录为 **309 passed / 11 skipped（320）**，后续计数按实际运行记录，不要求与历史相同。
- AI 覆盖率历史实测为 **lines 89.87% / statements 86.81% / functions 78.49% / branches 81.49%**；现有门槛分别为 **85 / 83 / 75 / 78**。`pnpm test:coverage` 历史退出 0，CI run `37910980424` 全绿。本周修复后仍须执行默认覆盖率回归，不再安排覆盖式 AI 专项测量或重复配置任务。
- 生产 P95 **511.312 ms** 来自 2026-10-08 的 100 请求、并发 5 测量，不是当前 HEAD 的性能实测。生产记录见 [runbook §11.5、§12](neon-vercel-baseline-runbook.md)，实现与 CI 记录见 [切片实施结果 §4.1](gate2-implementation-plan.md)。

## 2. 本周工作流范围与不变量

**目标**：完成切片 2 的 A/B 加固，用替身证明运行时身份正确、只读入口失败受控且无写副作用，再完成 L2 回归和独立审查。两项属于同一控制面工作流，后续实施按 **L2**，由同一 `slice_owner` 完成实现、自测及返工，独立 `independent_auditor` 审查。本次事实性文档同步为 **L1**，本周排期不构成已执行代码任务的证据。

| 用途       | 允许范围                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本次更新   | 仅 `docs/current-plan.md`；不新增交接，不改历史 handoff                                                                                                                                          |
| 后续 A     | `packages/ai/src/control-plane/server.ts`、`server.test.ts`（同目录）                                                                                                                            |
| 后续 B     | `packages/ai/src/read-monthly-usage.ts`、`read-monthly-usage.test.ts`（同目录）                                                                                                                  |
| 只读参照   | `control-plane.ts`、`anonymous-id.ts`、`circuit-breaker.ts`、`budget-ledger.ts`、`redis-like.ts`、`test-doubles.ts`（均在 `packages/ai/src/control-plane/`）；`vitest.config.ts`、根与 AI 包脚本 |
| 范围外事项 | 其他源码、配置、依赖、锁文件、AGENTS、冻结决策、查询契约、路线图及历史交接；需扩范围时先返回主 Agent重评                                                                                         |

后续执行先按 [AGENTS](../AGENTS.md) 与 [多 Agent 工作流](multi-agent-workflow.md) 形成最小交接包，不把本次文档请求解释为代码实施或外部操作授权。整个工作流保持：

- 输出仍为 `FIXED_EXAMPLE`，不新增 provider 包或改变产品模型路由。门 A 仅覆盖既有 `@upstash/redis` 依赖授权；门 B（`openai` 依赖）和门 C（首次真实付费调用）未开启，二门均开启前切片 3 不得开工。
- 月度 **30 元**同池预算包含开发、排错和评估；匿名派生算法、限流/熔断参数、价格与汇率版本、精确数值、证据原子性、失败关闭及服务端隔离保持不变。
- 不回显密钥、token、连接串、secret 摘要或底层异常。测试仅注入替身；真实 Upstash、真实密钥、外部账户、付费调用、远程写入和发布须另有对应授权，本计划不提供该授权。
- 写入、审查前检查 Git，保护已有改动。子 Agent 不暂存、提交、创建分支、变基、合并、推送或改写历史。

**完成条件**：A/B 行为验收、完整 L2 矩阵、默认覆盖率回归和独立审查均通过，实际结果区分通过、失败、跳过和未执行；任何必需项未完成，工作流只能标为“未完成 / 待验证”。代码与本地验证完成、生产发布、阶段闸门通过分别记录。

## 3. 本周排期

日期表示安排，初始状态均为待执行；后一项以所列前置完成为条件。

| 日期          | 安排                             | 前置与当日验收                                           |
| ------------- | -------------------------------- | -------------------------------------------------------- |
| 10-12（周一） | 复核基线，实施 A：运行时密钥隔离 | 基线清楚；A 行为与定向测试通过                           |
| 10-13（周二） | 实施 B：只读失败及副作用断言     | A 通过；B 行为及 A/B 合并定向测试通过                    |
| 10-14（周三） | 完整 L2、默认覆盖率与类型复验    | A/B 通过；L2 矩阵、覆盖率和 Web 非增量类型复验通过       |
| 10-15（周四） | 独立审查、必要返工及定向复查     | owner 自测完成；独立结论 PASS，无阻断项                  |
| 10-16（周五） | 收口证据、列后续授权与验收缺口   | 据实际结果更新本文件；明确未完成项，不推导发布或闸门结论 |
| 10-17—10-18   | 预留                             | 不预设开发承诺；前序失败则更新顺延安排                   |

下列命令均从仓库根目录、PowerShell 单独执行并记录退出码；历史成功不能替代本轮验证。使用现有依赖，构建若需要数据库，只能使用已确认的本地隔离环境，不默认读取真实连接。

### 阶段 0：基线复核

只读核对四个目标文件、既有测试和配置加载方式；实际 HEAD 有变化时核对差异归属，不回退。记录 Node / pnpm 版本，确认替身测试不加载真实凭据。

```powershell
git status --short --branch
git rev-parse HEAD
node --version
pnpm --version
pnpm exec vitest run packages/ai/src/control-plane/server.test.ts packages/ai/src/read-monthly-usage.test.ts
```

**验收**：基线与已有改动归属清楚，四文件边界成立，定向测试退出 0。环境与代码失败分别记录；基线异常未澄清不进入修复，依赖问题不通过改清单或锁文件处理。

### 阶段 1：A 运行时密钥隔离

**前置**：阶段 0 通过。**写范围**：仅 A 两文件。

1. 补旧行为的回归测试：同 Redis + 同 secret 复用；同 Redis + 不同 secret 产生新运行时及新的匿名派生值；不同 Redis 隔离；再次使用当前 secret 继续复用。
2. 推荐每个 Redis 只保存“当前 secret 的不可逆摘要 + runtime”，相同复用、变化替换，避免按历史 secret 建立无限增长的嵌套缓存。仅改生产 Redis 的 url/token 缓存不能解决此问题。
3. 保持同配置 L1 跨请求累计：第 4 次不熔断、第 5 次熔断；密钥缺失仍返回 `null`。原密钥及摘要均不输出，不迁移 L1 到 Redis，不顺带整理其他缓存。

```powershell
pnpm exec vitest run packages/ai/src/control-plane/server.test.ts
pnpm --filter @logiplan/ai typecheck
pnpm exec prettier --check packages/ai/src/control-plane/server.ts packages/ai/src/control-plane/server.test.ts
git diff -- packages/ai/src/control-plane/server.ts packages/ai/src/control-plane/server.test.ts
```

**验收**：上述复用、轮换、匿名派生、隔离及 L1 行为均有断言并通过，无新增外部调用或输出泄漏。需改其他模块或冻结语义时停止，交主 Agent重评。

### 阶段 2：B 只读用量受控失败

**前置**：A 通过。**写范围**：仅 B 两文件。

1. 使 `runReadMonthlyUsage` 的 `budgetRead` 异常统一返回既有 `ok: false` 和 `USAGE_UNAVAILABLE_MESSAGE_ZH` 固定文案，沿用 CLI 已有受控失败语义。
2. 复用失败替身或测试内 spy，错误内容可含伪造 URL、token、secret，断言结果只含固定文案。成功报告仍恰含 `month / used_cny / cap_cny / price_version / fx_version` 五字段，缺配置路径仍受控。
3. 成功和读取失败均断言 `budgetRead` 恰一次，`budgetReserve`、`budgetSettle`、`slidingWindow` 及熔断写入口零调用。直接观测 `recordSuccess`、`recordTransientFailure` 等入口，并排除经 `evaluateControlPlane` / `recordProviderAttemptOutcome` 间接改状态；只看“open 仍 open”不足以证明只读。

```powershell
pnpm exec vitest run packages/ai/src/control-plane/server.test.ts packages/ai/src/read-monthly-usage.test.ts
pnpm --filter @logiplan/ai typecheck
pnpm exec prettier --check packages/ai/src/read-monthly-usage.ts packages/ai/src/read-monthly-usage.test.ts
```

**验收**：程序化调用不泄露 rejection 或底层异常；成功、失败读取都不计费、不限流、不改熔断。观测需要扩文件范围时先返回主 Agent。`pnpm --filter @logiplan/ai run usage` 会加载根 `.env`，本工作流不直接执行该入口，全部以替身验证。

### 阶段 3：完整回归与既有覆盖率

**前置**：A/B 通过。**写范围**：允许的检查产物；失败修复回原 owner 四文件范围。

```powershell
pnpm test
pnpm typecheck
pnpm --filter @logiplan/web exec tsc --noEmit --incremental false
pnpm lint
pnpm format:check
pnpm build
pnpm test:coverage
git diff --check
git status --short
```

**验收**：五项 L2 命令、Web 非增量类型复验、默认覆盖率均退出 0；记录实际测试计数和 skipped 原因，覆盖报告包含 AI 包且现有阈值通过；差异限于允许文件及可识别产物，不降低阈值。四文件未影响页面或数据库时不机械追加专项验证；若影响扩展，先重评范围。此轮回归不构成合并、部署或阶段闸门验收。

**失败处理**：按本轮实际结果记录环境、工具或代码失败，不沿用历史限制推定现在不能执行，不关闭安全保护。修复后重跑受影响检查；审查返工改变代码时，同步更新回归和覆盖率证据。

### 阶段 4：独立审查与返工

**前置**：owner 自测及阶段 3 完成。主 Agent创建独立 auditor，交付 [工作流 §5](multi-agent-workflow.md) 的最小包和实际验证摘要。auditor 不写源码或文档，先检查 Git，再检查密钥身份、缓存复用、只读副作用、失败输出、服务端隔离及范围，至少独立复跑 A/B 定向测试。

```powershell
git status --short
git diff -- packages/ai/src/control-plane/server.ts packages/ai/src/control-plane/server.test.ts packages/ai/src/read-monthly-usage.ts packages/ai/src/read-monthly-usage.test.ts
pnpm exec vitest run packages/ai/src/control-plane/server.test.ts packages/ai/src/read-monthly-usage.test.ts
```

**验收**：独立结论 PASS、无阻断问题，必需验证齐全。问题回原 owner 修复、自测，再由原 auditor 定向复查；两轮修复—复查仍未通过即停止，由主 Agent提出一个明确决策问题，不更换审查者绕过结论。

### 阶段 5：证据与后续缺口

按实际结果收口：HEAD、四文件改动、行为验收、覆盖率四项值、命令结果、跳过及未执行原因、审查结论、模型偏差和剩余风险。正式状态仅更新本文件，不覆盖历史交接，不保存逐次 Agent 对话或原始日志。

```powershell
pnpm exec prettier --check docs/current-plan.md
git diff --check
git status --short
```

**验收**：事实、日期、相对链接和差异范围一致；“代码与本地验证完成”“生产已发布”“闸门二通过”分别有对应证据，没有证据的项目明确待验证。真实服务和后续切片只列条件项，不承诺本周启动或过闸。

## 4. 顺延、条件项与剩余风险

前置失败则后续顺延。A 未完成时 B 不启动；已产生改动优先完成其测试与审查，不能因工时不足跳过验证。回归、覆盖率或审查未完成则保留“待验证”，周五只收口实际结果，不将未通过项目标成完成。

- **真实基础设施验证**：~~Upstash Lua 原子性、`eval` 行为和 CLI 真实成功路径尚未验证，替身无法替代；取得对应真实服务授权后另排验证~~ ——**已于 2026-10-13 用真实 Upstash 完成**（用户提供凭据，见 §9），并据此**发现并修复**一处 Lua 返回值截断缺陷。切片 2 专项 Playwright / axe 及会话内隔离数据库仍缺本地证据（`spawnSync` 恒 `EBUSY`），历史 CI 隔离验证曾通过，两者分别记录。合并、部署或阶段闸门前仍须补齐完整 Playwright、性能、可访问性及路线图要求，不能用历史生产结果代替。
- **真实 AI 与 20 题评估**：须先完成前置验证并开启门 B、C；切片 3 / 4 依 [实施计划 §5、§6](gate2-implementation-plan.md) 单独推进。20 题必须全为真实生成，至少 **18/20**，E19、E20 全通过；数字按 **4 位小数精确一致、无容差**，语义人工复核，固定示例不能计通过；开发、排错、评估同池计入月度 30 元。
- **多快照恢复**：15 条证据跨 4 个快照，回答契约只有单值快照 ID；逐条证据可打开不等于页面恢复能力成立，需 contracts / 查询契约的独立 L2 工作流。
- **其他独立项**：~~原 url/token 缓存容量~~、~~动态 import 可达性断言~~ **已于 2026-10-13 完成**（见 §7）；~~跨实例 L1~~ **已于 2026-10-13 完成**（阻塞点由 §9 的真实 Upstash 解除；实现与跨实例验证见 §10）；`noopAuditSink`（**按设计留切片 3**）、XFF 语义（**已确认无需改**）**已处置**（见 §8）。**§4 五条独立项至此全部收口。**
- **Windows 稳定性**：`3221226505 = 0xC0000409` 根因未定性；2026-10-08 取证未命中，维持 D-188，稳定性权威证据取 CI ubuntu、本地证据单列，见 [取证文档](windows-crash-evidence.md)。新一轮环境可执行性按实际运行判断。

## 5. 执行模型与本次更新范围

历史计划指定 **DeepSeek v4.1 Flash** 为开发执行模型偏好；这不改变产品模型路由，也不代表本次已由该模型执行。后续运行者应按平台实际可用模型与 [多 Agent 工作流](multi-agent-workflow.md) 记录偏差；模型选择不降低 L2 验证和独立审查要求。

本次文档实现首选 `gpt-5.6-terra / medium`，运行环境可用列表未提供该模型，按工作流 §2.6 使用默认配置；实际精确模型 ID 与推理强度未暴露，记为未知。此次仅做本地只读事实核对和单文档更新，代码测试、真实服务、线上状态查询和发布均未执行。

## 6. 2026-10-12 执行结果（阶段 0—4）

**本次由主 Agent 按本计划执行，A/B 与回归均在本地完成；工作区 4 文件未提交。**

- **阶段 0 基线**：HEAD `8ab93f4581423ede29a10d51138c2f6134674067`，与 `origin/main` 同步；Node **24.15.0** / pnpm **10.34.5**；定向基线测试退出 0。工作区另有用户资产 `docs/current-plan.md`（M）与 `docs/debug.log`（未跟踪，Chromium 杂散日志），**均未触碰**。
- **阶段 1（A）**：改 `packages/ai/src/control-plane/server.ts`（+47/−8）与 `server.test.ts`（+90）。`runtimeByRedis` 值类型改为 `{ secretDigest, runtime }`；新增 `digestMasterSecret`（Web Crypto SHA-256，**零新 import**）；**摘要相同复用、变化替换**（条目数不随历史密钥增长）；`productionRedisByCredentials` 未改。新增 3 条用例；slice_owner 回退验证：改回旧判定 → **2 failed / 7 passed**，恢复后 9 passed。
- **阶段 2（B）**：改 `packages/ai/src/read-monthly-usage.ts` 与 `read-monthly-usage.test.ts`。`readMonthlyUsage` 调用包进 `try/catch`，收敛为**同一** `USAGE_UNAVAILABLE_MESSAGE_ZH`；测试侧新增**局部替身** `RejectingReadRedisLike`（未改共享 `test-doubles.ts`）。新增 1 条用例（伪造 URL/token/secret 与 `ECONNREFUSED` 均不出现在输出；`budgetRead` 恰一次；reserve/settle/slidingWindow 与熔断写入口零调用）；回退验证：还原无 try/catch → **1 failed / 4 passed**，恢复后 5 passed。
- **阶段 3 回归（本机实测，退出码全部 0）**：

| 命令                                                                | 结果                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                         | 35 文件 / **313 passed / 11 skipped（324）**；11 条 skipped 全部位于 `packages/db/src/evidence-snapshot.test.ts`，由 `SNAPSHOT_TEST_*` 环境变量门控（需真实快照数据库 / API 的集成用例），本机未提供该环境 |
| `pnpm typecheck`                                                    | 0                                                                                                                                                                                                          |
| `pnpm --filter @logiplan/web exec tsc --noEmit --incremental false` | 0                                                                                                                                                                                                          |
| `pnpm lint` / `pnpm format:check`                                   | 0 / 0                                                                                                                                                                                                      |
| `pnpm build`                                                        | 0（路由含 `/api/v1/ai/respond`）                                                                                                                                                                           |
| `pnpm test:coverage`                                                | 0                                                                                                                                                                                                          |
| `git diff --check`                                                  | 干净                                                                                                                                                                                                       |

- **AI 包覆盖率（本次实测）**：lines **90.02%**（577/641）、statements **86.99%**（635/730）、functions **78.72%**（148/188）、branches **81.60%**（275/337）；现有阈值 **85 / 83 / 75 / 78 全部通过**（较 2026-10-09 基线 89.87 / 86.81 / 78.49 / 81.49 略有提升）。`All files` = 93.61 / 92.16 / 88.49 / 85.90。
- **阶段 4 独立审查**：结论 **PASS**，无阻断项。审查者独立复跑定向（14 passed）与 `packages/ai`（177 passed），并核对范围合规（仅 4 文件）。遗留 **2 条 P2（非阻断）**：① `catch {}` 无参，会一并吞掉 `clock.now()` 抛错（与 `control-plane.ts:229` 的失败关闭口径一致）；② 文案 `控制面未配置…` 在「已配置但读取失败」时措辞不精确——两者都是本计划 §阶段 2 明文指定实现方式的直接后果。
- **跳过与未执行（如实记录，不表述为通过）**：真实 Upstash Lua 原子性与 `eval` 运行时、CLI 真实 Redis 成功路径（本机无凭据/实例，替身不可替代）；切片 2 专项 Playwright / axe 与会话内隔离数据库（`spawnSync`/`execSync` 恒 `EBUSY`）；**独立审查者未做回退验证**（受只读约束，改为代码推理；回退验证由 slice_owner 完成并报告）。
- **提交与 CI 证据（2026-10-12）**：提交 `64a4f2c2`（`feat(ai)`：A/B 四文件）与 `eaa6a2d6`（`docs`：本文件）。推送后 CI run **`38224713233`**（head `eaa6a2d6`）**全绿**——`Gate 1 deterministic validation`（含 `Test with coverage` 与 ubuntu 上的 isolated Gate 1 validation）、`Cross-platform checks`（ubuntu / macOS / Windows 三矩阵）、`CodeQL` 全 success；`Pull request dependency review` 按设计 skipped。**CI 是稳定性权威证据（D-188）**，本机结果与 CI 结果分别记录、不得合并。
- **模型偏差**：本计划指定 L2 使用 `gpt-5.6-sol` / `high`，运行环境不提供该档位名称，按工作流 §2.6 降级使用环境可用推理档位；**分级、验证矩阵与独立审查要求均未降低**。实际精确模型 ID 与推理强度未暴露，记为未知。
- **状态边界**：以上仅为「代码与本地验证完成」。**生产发布与闸门二通过本次均无证据**，不得由本地结果推导。后续切片 3 / 4 仍待门 B、C 授权。

## 7. 2026-10-13 执行结果（其他独立项 2 条）

按「最少人工干预」优先，先做 §4 中**零外部依赖**的两条；另三条（跨实例 L1、`noopAuditSink`、XFF 语义）仍待后续。

- **范围**：`packages/ai/src/control-plane/server.ts`、`server.test.ts`、`packages/ai/src/no-live-call.test.ts`。`packages/ai` **不在** `executionClosurePaths` 内 → **不触发工具 SHA 重锚定**；**零新依赖**。
- **① 凭据缓存容量上限**：`productionRedisByCredentials` 由「只增不减、无上限」改为具名上限 `MAX_CACHED_REDIS_CREDENTIALS = 4` + **LRU 淘汰**；命中时做 LRU 触碰；淘汰时**同步删除对应 `runtimeByRedis` 条目**（不留孤儿）。**单凭据常态下该条目恒为最近使用项、永不被淘汰**，故 L1 跨请求累计不受影响；仅当同一进程**同时**使用超过 4 组凭据时最久未用者才被淘汰并重置其 L1 计数——属已文档化的取舍。新增 3 条用例（有界且最旧被淘汰、两表一致无孤儿、单凭据不淘汰且复用同一运行时）。
- **② 动态 import 可达性断言**：`no-live-call.test.ts` 把依赖边提取抽成纯函数 `extractImportSpecifiers`，覆盖 `from "..."`、`import("...")`、`import "..."` 三形态；既有三条断言与两条正对照**原样保留**，另补一条正对照证明扩展真的生效。**扩展未发现此前不可见的可达路径**（全包源码扫描确认）。
- **回归（本机实测，退出码全部 0）**：

| 命令                              | 结果                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `pnpm test`                       | 35 文件 / **317 passed / 11 skipped（328）**（较 10-12 +4） |
| `pnpm typecheck` / web 非增量 tsc | 0 / 0                                                       |
| `pnpm lint` / `pnpm format:check` | 0 / 0                                                       |
| `pnpm build`                      | 0                                                           |
| `pnpm test:coverage`              | 0                                                           |
| `git diff --check`                | 干净                                                        |

- **AI 包覆盖率（本次实测）**：lines **90.23%**（591/655）、statements **87.11%**（649/745）、functions **78.95%**（150/190）、branches **81.23%**（277/341）；阈值 **85 / 83 / 75 / 78 全部通过**。
- **独立审查**：结论 **PASS**，无阻断项。审查者独立复跑定向（20 passed）与 `packages/ai`（181 passed），并用 node 复刻 LRU 逻辑做隔离模拟、扫描全包源码验证正则扩展未新增可达边。遗留 **2 条非阻断 P2**：① `server.test.ts` 硬编码上限 `4` 而未引用生产常量（方向 fail-safe，但失败信息会误导）；② 三条正则仅匹配双引号，模板字面量 `import(...)` 未覆盖（本仓无此形态，已注释记录）。
- **未执行（如实记录）**：真实 Upstash（无凭据/实例）；docker 相关脚本（`spawnSync`/`execSync` 恒 `EBUSY`）；**独立审查者未做回退验证**（受只读约束，改为代码推理 + node 模拟；回退验证由 slice_owner 完成并报告）。
- **提交与 CI 证据（2026-10-13）**：提交 `2684e5bf`（`feat(ai)`：三文件）与 `807202fc`（`docs`：本文件与闸门二实施计划 §4.1）。推送后 CI run **`38333340375`**（head `807202fc`）**全绿**——`Gate 1 deterministic validation`（含 `Test with coverage` 与 ubuntu 上的 isolated Gate 1 validation）、`Cross-platform checks`（ubuntu / macOS / Windows 三矩阵）、`CodeQL` 全 success；`Pull request dependency review` 按设计 skipped。
- **模型偏差**：同 §6（环境不提供 `gpt-5.6-sol` 档位名，按工作流 §2.6 降级；分级、验证与独立审查要求未降低）。

## 8. 2026-10-13 追加：其余 3 条独立项的处置（结论：本轮均无需改代码）

- **跨实例 L1 —— 仍阻塞，需真实 Upstash**。把 L1 状态落到注入的 `RedisLike`（新增原子脚本与键）在替身上可以写，但「**跨实例一致**」这个验收目标**没有真实共享 Redis 就无法证明**，故不启动，避免产出未经验证的改动。
- **`noopAuditSink` —— 按设计留给切片 3，本轮不改**。`audit-log.ts` 已明确记录「切片 2 不落盘……真实 sink 由切片 3 注入」，且 AC2.10 在本切片验证的是「记录字段恰好等于白名单」（类型 + 单测锁定）。现在注入真实 sink 会**违背已文档化的设计**，并给生产 AI 端点引入真实日志行为。
- **XFF 语义 —— 已确认，当前实现安全，无需改代码**。`respond/route.ts:62` 取 `x-forwarded-for` 首个值。外部技术分析（2026-04-18）明确指出：**Vercel 会在函数看到请求头之前清洗 `X-Forwarded-For`、剥离客户端自带的段，因此首个值即真实客户端 IP，可以安全地取 `[0]`**；并指出 `x-real-ip` **Vercel 并不保证**、`x-vercel-forwarded-for` 才是最可靠的单值来源。
  **证据强度与边界**：该结论来自**第三方**技术分析；Vercel 官方 `request-headers` 页面为客户端渲染，本会话工具**取不到正文**，**未获第一方确认**。风险有界——控制面不可用时限流本就失败关闭，且 L2 的 30 元/月全局上限仍然生效；该项本就排在「切片 3 前确认」，可在有真实部署时复验。
  **切片 3 可选加固**：优先读 `x-vercel-forwarded-for`、回退到 XFF 首个值，并在路由处补注释说明该假设（本轮**未改代码**）。
- **本机隔离验收仍不可执行（已复测）**：`spawnSync` 仍恒 `EBUSY`（`docker` 本身可用，29.7.2，但 `scripts/run-docker-compose.mjs` 依赖 `spawnSync`）→ `pnpm verify:gate1:isolated` 仍只能在用户终端或 CI 执行。按「不沿用历史限制推定现在不能执行」的要求已复测，**结论未变**。
- **§4 五条独立项至此全部有处置**：2 条已修复（§7）、1 条已确认无需改（XFF）、1 条按设计顺延（`noopAuditSink`）、1 条阻塞于真实 Upstash（跨实例 L1）。
- **提交与 CI 证据**：提交 `6ebdbb67`（`docs`：本文件与闸门二实施计划 §4.1 的第 4、5 条处置）。CI run **`38335810758`**（head `6ebdbb67`）**全绿**——`Gate 1 deterministic validation`、`Cross-platform checks`（ubuntu / macOS / Windows 三矩阵）、`CodeQL` 全 success；`Pull request dependency review` 按设计 skipped。**本轮未改任何源码**。

## 9. 2026-10-13 追加：真实 Upstash 验证与 Lua 返回值截断修复

用户 2026-10-13 提供真实 Upstash 凭据（写入本地 `.env`，该文件已被 `.gitignore:8` 忽略；**未提交、未回显**）。据此完成两项此前「未执行」的真实基础设施验证，并**发现并修复一个真实缺陷**。

### 9.1 缺口补上（原「未执行」项）

- **AC2.11 只读 CLI 的真实 Redis 成功路径**：`pnpm --filter @logiplan/ai run usage` 退出码 0，输出
  `{"month":"2026-10","used_cny":0,"cap_cny":30,"price_version":"PRICE_2026_V1","fx_version":"FX_2026_V1"}`
  —— 恰好五字段，`cap_cny=30` 与冻结口径一致。
- **真实 Lua 原子性（AC2.2 / AC2.5）**：以**生产装配**（`createControlPlaneFromEnvironment`）取真实
  `UpstashRedisLike`，全部使用 `logiplan-verify-<ts>:*` **测试专用键**，跑完清理（REST `del` 返回 200），
  **生产账本未被触碰**（CLI 读回 `used_cny=0`）。5 项中 **4 项通过**：滑动窗口并发 50 / limit 10 →
  allowed 恰好 10（maxCount=10）；并发 reserve 20 个不同 requestId / cap 5 → accepted=5（maxTotal=5）；
  settle 差额结算与幂等；并发 settle 同一 requestId → applied=1。

### 9.2 发现的缺陷：Lua 脚本返回值被截断为整数

第 5 项（reserve 幂等）暴露：`applied` 正确，但返回的 `total` 为 **1** 而非 **1.5**。精确复现（返回值 vs 实际存储）：

| 调用                                | 脚本**返回** `totalCny` | 实际**存储**（`budgetRead`） |
| ----------------------------------- | ----------------------- | ---------------------------- |
| `budgetReserve(1.5)`                | **1**                   | 1.5 ✓                        |
| `budgetSettle(3.5)`（先 reserve 5） | **3**                   | 3.5 ✓                        |
| `budgetReserve(0.4)` 两次           | 第二次 **0**            | 0.8 ✓                        |

**根因**：Redis 会把 Lua 脚本**返回值**中的 Lua number 转成 RESP integer（截断），而 `SET` 的参数转换保留小数
⇒ **存储永远正确，只有返回值错**。`upstash-redis.ts` 的 `asNumber(raw[1])` / `asNumber(raw[0])` 因此拿到整数。
**影响面**：`totalCny` → `budget-ledger.ts` → `control-plane.ts:189/201` → 审计字段 **`budget_used_cny`**
（D-138 白名单）**少报**（如 29.7 → 29）。**L2 封顶判定本身是安全的**（Lua 内部用全精度比较 `total + amount > cap`）。
**为什么单测抓不到**：`InMemoryRedisLike` 替身返回精确浮点、**不模拟 RESP 截断** ⇒ 全部单测绿，只有真实 Redis 才暴露。

### 9.3 修复（L2 工作流）

- **改动**：`packages/ai/src/control-plane/upstash-redis.ts`（+22/−9）——两个预算脚本把总量以 `tostring(...)`
  **字符串**返回；**同一个 `tostring` 结果既作 `SET` 的值又作返回值**，使返回值与持久化值**逐字节一致**
  （顺带消除「依赖 Redis 对 `SET` 数字参数的内部格式化」这一隐式假设）。`ok` / `applied` 标志**仍为整数**；
  `SLIDING_WINDOW_SCRIPT` 未改（返回计数）。
- **新增受门控集成测试**：`packages/ai/src/control-plane/upstash-redis.integration.test.ts`——需**同时**满足
  凭据存在**与**显式 opt-in（`LOGIPLAN_UPSTASH_INTEGRATION=1`）才运行，用 `describe.skipIf` 并**写明跳过原因**；
  随机测试键前缀 `logiplan-test-<rand>-<ts>:*`，`afterAll` 清理；断言返回的 `totalCny` 与随后 `budgetRead`
  **完全相等**（覆盖 1.5 / 0.4+0.4 / 3.5），并保留幂等与 cap 断言。
- **独立审查**：全新上下文只读审查 **PASS**，**无 P0/P1**。审查者独立复跑门控集成测试（带 opt-in **5 passed**、
  不带 opt-in **5 skipped**，验证门控有效），并确认：5 条返回分支**全部**改为字符串（无漏改）、
  `tostring`（Lua 5.1 `%.14g`）对本项目金额范围（2—4 位小数、量级 ≤10⁷）**精确往返**、`SET` 与返回值**同源**、
  无凭据回显、范围合规。
- **3 条非阻断 P2（如实记录，本轮未修）**：① 建议在 `vitest.config.ts` 阈值注释补一句「提升覆盖率请以
  `LOGIPLAN_UPSTASH_INTEGRATION=1` 运行」；② 集成测试**默认跳过** ⇒ `upstash-redis.ts` 在**默认覆盖率运行**中
  仍是 20% stmts（**不等于已覆盖**）；③ 审查者受只读约束未做「修复前会失败」的变异复现（改为按 RESP 语义推理），
  该回退验证由 slice_owner 完成并报告。

### 9.4 回归实测（本机）

| 命令                              | 结果                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| 门控集成测试（带 opt-in）         | **5 passed**                                                           |
| `pnpm test`                       | **317 passed / 16 skipped（333）**（skip 由 11 → 16，+5 即新集成测试） |
| `pnpm typecheck` / web 非增量 tsc | 0                                                                      |
| `pnpm lint` / `pnpm format:check` | 0                                                                      |
| `pnpm build`                      | 0                                                                      |
| `pnpm test:coverage`              | 0（AI 包 **90.23 / 87.11 / 78.95 / 81.23**，阈值 85/83/75/78 通过）    |

### 9.5 证据边界

- 本次真实 Upstash 验证**不解锁门 C**（首次真实付费调用），全程**零真实模型调用、零付费**。
- **跨实例 L1** 的阻塞点（真实共享 Redis）**已于 2026-10-13 解除**；该项本身随后在同一日完成，见 §10。
- `docs/current-plan.md` §4 五条独立项中，`跨实例 L1` 的阻塞点据此解除；其余处置结论不变（§7、§8）。
- CI 证据见 §9.6。

### 9.6 提交与 CI 证据

- 提交 **`94c51335`**（`fix(ai)`：`upstash-redis.ts` + 受门控集成测试，2 文件 +141/−9）与
  **`7c0679cc`**（`docs`：本文件 §9 与闸门二实施计划 §4.1 回填，2 文件 +86/−14）。
- CI run **`38354494953`**（head `7c0679cc`）**全绿**——`Gate 1 deterministic validation`（含 `Test with coverage`
  与 ubuntu 上的 isolated Gate 1 validation）、`Cross-platform checks`（ubuntu / macOS / Windows 三矩阵）、
  `CodeQL` 全 success；`Pull request dependency review` 按设计 skipped。
- **仍未执行（如实记录，不表述为通过）**：切片 2 专项 Playwright / axe 与会话内隔离数据库
  （`spawnSync` 恒 `EBUSY`）；真实 Redis 压测。

## 10. 2026-10-13 追加：跨实例 L1 熔断（L1 状态迁至 Redis）

**目标**：把 L1 熔断状态从**进程内存**迁到注入的 `RedisLike`，使「同一角色 5 分钟窗口内连续 5 次」的
计数与判定**跨进程 / 跨实例共享**——这是 Vercel serverless 下 L1 真正生效的前提（此前 `server.ts`
原注释已承认「进程级单例只在单热实例内有效、跨实例不共享」）。该项是
`docs/gate2-implementation-plan.md` §4.1 记录的已知局限，原计划留到切片 3；用户 2026-10-13 指示
提前作为独立项实施（§4 五条独立项的最后一条）。

### 10.1 实现（L2 工作流：slice_owner → 独立审查 → 回归）

- `redis-like.ts` 新增 `CircuitState` / `CircuitSnapshot` / `isCircuitSnapshot`，以及 `RedisLike` 的
  3 个方法：`circuitRead`（**纯读**，单次调用返回「是否放行 + 审计状态 + 窗口内故障数」）、
  `circuitRecordFailure`、`circuitRecordSuccess`。
- `circuit-breaker.ts`：`L1CircuitBreaker` 构造改为 `(redis, options?)`，方法全部改为**异步**；新增
  `read()`（一次纯读同时给出放行判定与审计状态，避免两次往返）与 `circuitKey()`。常量
  （`L1_WINDOW_MS = 300000`、`L1_CONSECUTIVE_FAILURE_THRESHOLD = 5`）与 `isTransientFailure` 不变。
- `upstash-redis.ts`：新增 3 个 Lua 脚本，键 `circuit:{role}:failures|opened|seq`；**唯一成员**
  `now .. ':' .. INCR(seq)` 使同一毫秒的并发故障不互相覆盖（若成员只用 `now`，ZSET 的成员唯一性会把
  并发故障折叠成一条而**漏计数**）；TTL = 2 × 窗口。构造参数由 `Redis` 收窄为结构兼容的
  `RedisScriptClient`，**并移除 `import type { Redis } from "@upstash/redis"`**（该文件自此**无**对
  `@upstash/redis` 的静态导入，只剩 `createUpstashRedisLike` 里的动态 `import()`）。
- `control-plane.ts`：`runChecks` 改为**单次** `await deps.breaker.read(...)`；
  `recordProviderAttemptOutcome` **由同步改异步**（公共接口变更，切片 3 的调用方须处理）。
- `server.ts`：`new L1CircuitBreaker(redis)`；**单例、主密钥摘要隔离、凭据 LRU 上限 4 全部保留**
  （L1 不再依赖单例，但单例仍避免每请求重建配置）。

**语义不变（D-190 决策一）**：同一角色、5 分钟窗口、**连续 5 次**瞬时故障 → 打开；**第 4 次不触发、
第 5 次触发**；窗口滑出 → 半开；半开成功 → 闭合；半开失败 → 重新打开（重置为单次）；按角色隔离。
窗口判定沿用**严格** `nowMs - at < windowMs`（Lua 用 `ZCOUNT ... '(' .. cutoff` 的排他下界）。

### 10.2 独立审查

全新上下文只读审查 **PASS**，**无 P0/P1**。审查者独立复跑门控集成测试（**4 passed**）并确认：
`circuitRead` 的 Lua **只有** `ZCOUNT` / `GET`（无任何写命令）；`RedisLike` 既有 4 方法与 3 条既有 Lua
脚本的 `git diff` **删除行数为 0**（逐字节未改）；既有测试断言**只加 `await`、无删除或放宽**；
`vitest.config.ts` **无 diff**；`server.ts` 仍是唯一静态可达 `upstash-redis.ts` 的入口；`index.ts` 新增
导出不会让 `upstash-redis.ts` 从主 barrel 可达。审查者另独立验证了主 Agent 的用例超时写法
（`it(name, { timeout }, fn)`）在 vitest 4.1.11 **确实生效**（6508 ms 用例在 20 s 超时下通过）。

**P2 观察（非阻断，如实记录）**：① 静默 2 × 窗口后 `opened` 键过期 → 状态读作 `closed` 而非
`half_open`——两者**放行行为一致**（判定均为 `state !== "open"`），仅审计字段 `circuit_state` 不同；
② `recordProviderAttemptOutcome` 由「永不抛」变为「存储失败即 reject」，切片 3 调用方须处理；
③ `circuitRead` 的纯读断言只覆盖固定写命令清单，`ZREM` / `EXPIRE` / `ZINCRBY` 等会漏网（测试强度小缺口）；
④ `vitest.config.ts` 的注释仍称 `upstash-redis.ts` 约 20% stmts，**现已过期**（该文件不在本轮写范围，未改）。

### 10.3 跨实例一致性验证（本项核心验收）

`packages/ai/src/control-plane/circuit-breaker.integration.test.ts`（**受门控**：需凭据 **+**
`LOGIPLAN_UPSTASH_INTEGRATION=1`，默认跳过并写明原因；随机测试键前缀 + `afterAll` 清理；
**不触碰生产键**）构造**两个相互独立**的客户端 / breaker（模拟实例 A / 实例 B）共享同一 Redis：

| 用例                                                                    | 结果 |
| ----------------------------------------------------------------------- | ---- |
| A 的连续故障对 B 可见：第 4 次不触发、第 5 次跨实例触发打开，且键有 TTL | ✅   |
| 窗口滑出后半开、成功闭合，均跨实例可见                                  | ✅   |
| 半开探测失败重新打开，跨实例可见（重置为单次）                          | ✅   |
| 同一毫秒的并发故障不漏计数（唯一成员机制）                              | ✅   |

**4/4 通过**（真实 Upstash）。反向验证：把 L1 状态临时改回进程内 → 该文件 **4/4 失败**（并发用例收到
`1` 而非 `5`；半开失败用例收到 `half_open` 而非 `open`）→ 还原后 4/4 通过。

### 10.4 回归实测（本机，全部退出码 0）

| 命令                              | 结果                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| 默认 `vitest run packages/ai/src` | **198 passed / 9 skipped**                                                      |
| 门控集成测试（带 opt-in）         | **9 passed**（`circuit-breaker.integration` 4 + `upstash-redis.integration` 5） |
| `pnpm test`                       | **334 passed / 20 skipped（354）**（skip 由 16 → 20，+4 即新集成测试）          |
| `pnpm typecheck` / web 非增量 tsc | 0                                                                               |
| `pnpm lint` / `pnpm format:check` | 0                                                                               |
| `pnpm build`                      | 0                                                                               |
| `pnpm test:coverage`              | 0                                                                               |

**覆盖率显著上升**（**未改** `vitest.config.ts`）：AI 包 lines **90.23% → 93.68%**、statements
**87.11% → 91.15%**、functions **78.95% → 84.62%**、branches **81.23% → 87.74%**；`upstash-redis.ts`
单文件 lines **23.91% → 90.9%**、statements **20% → 92.59%**、functions **5% → 96.87%**、branches
**0% → 90.9%**——长期记录的「20% stmts 拖累项」由「把客户端依赖收窄为可注入接口 + 默认运行单测覆盖
映射逻辑」关闭，**不是**靠排除或下调阈值。

**浏览器产物复核**（本轮动了 barrel 与适配器）：客户端 `.next/static` 搜 `upstash` **零命中**、
搜 `circuit:` **零命中**；服务端产物**有命中**（正向对照）。

### 10.5 证据边界与待办

- 本轮**不解锁门 C**（首次真实付费调用），全程**零真实模型调用、零付费**。
- **未执行**：`pnpm verify:gate1:isolated`（`spawnSync` 恒 `EBUSY`）、Playwright / axe、真实 Redis 压测。
- **待用户决定**：`vitest.config.ts` 的阈值与注释已过期（`upstash-redis.ts` 实际 92.59%，注释仍写
  「约 20% stmts」），是否上调阈值 / 更正注释——该文件**不在**本轮写范围。
- **过程披露**：主 Agent 在实现者交付后自行修正了受门控集成测试的**用例超时**（vitest 默认 5 s 不足，
  最重用例实测 **7.17 s** → 具名常量 `INTEGRATION_TIMEOUT_MS = 60_000`）；该改动已由独立审查确认生效。
- CI 证据见 §10.6。

### 10.6 提交与 CI 证据

- 提交 **`7e2350b3`**（`feat(ai)`：跨实例 L1，13 文件 +961/−125，含 2 个新文件）与 **`a686c7c8`**
  （`docs`：本文件 §10、闸门二实施计划 §4.1、路线图 §0，3 文件 +101/−7）。
- CI run **`38365614014`**（head `a686c7c8`）**全绿**——`Gate 1 deterministic validation`（含
  `Test with coverage` 与 ubuntu 上的 isolated Gate 1 validation）、`Cross-platform checks`
  （ubuntu / macOS / Windows 三矩阵）、`CodeQL` 全 success；`Pull request dependency review`
  按设计 skipped。
