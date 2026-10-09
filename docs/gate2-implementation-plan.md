# 闸门二实施计划（切片划分、执行步骤、验收标准）

版本：V1.0
日期：2026-10-04
状态：**实施中**。切片 1a 已完成并收口；**切片 1b 已收口（2026-10-08）**——代码已推送、CI 全绿、独立审查的定向复查 **PASS**（唯一 P2 已补回归测试），且本机真实库验收 `pnpm verify:gate1:isolated` **全绿**（AC1.1 / AC1.11 取得本机证据，见 §3.1）。**切片 2 的授权门 A 已于 2026-10-08 开启（用户明示）；切片 3 的授权门 B、C 仍未开启。** **切片 2 已收口（2026-10-08 主体 / 2026-10-09 补 AC2.11）**：**AC2.1—AC2.12 全部满足**；两轮独立审查（首轮 FAIL → 返工 → 定向复查 **PASS**），AC2.11 追加部分另经一次定向复查 PASS；**浏览器产物已复核通过（2026-10-09）**；主体已提交 `21cef684`（CI run `37867164623` 全绿）。详见 §4.1。
依据：`docs/gate2-design.md`（设计 V1.0）、`docs/decisions.md` D-174 / D-181 / D-182 / D-190、`docs/query-contract.md` §10、`docs/ai-evaluation-baseline.md`、`docs/multi-agent-workflow.md`

---

## 0. 排序原则：先建安全与成本包围，再放进真实模型调用

D-190 把月度上限定在 30 元。若适配器先于限流/费用/熔断落地，**第一次真实调用时没有任何支出保护**，而 20 题评估需要大量调用。因此顺序固定为：

```text
切片 1  契约 + 固定示例闭环      零成本、零外部服务依赖
   ↓
切片 2  限流 + 费用 + 两级熔断    仍零真实调用
   ↓
切片 3  适配器 + 网关            首次真实调用（授权门 B、C）
   ↓
切片 4  20 题评估 + 归档
   ↓
阶段闸门 主 Agent 活动，非切片
```

切片 1、2 全程可在**没有 API key、没有 Upstash 凭据**的情况下完整验证。

## 1. 授权门状态

| 门       | 位置      | 内容                                                           | 状态                                  |
| -------- | --------- | -------------------------------------------------------------- | ------------------------------------- |
| —        | 切片 1    | 新增 `packages/ai` workspace 包，**必然修改 `pnpm-lock.yaml`** | ✅ **已授权（2026-10-04，用户明示）** |
| **门 A** | 切片 2 前 | 新增 `@upstash/redis` 依赖                                     | ✅ **已授权（2026-10-08，用户明示）** |
| **门 B** | 切片 3 前 | 新增 `openai` 依赖                                             | ⛔ 未开启                             |
| **门 C** | 切片 3 内 | **首次真实付费调用**                                           | ⛔ 未开启（D-190 明确不授权）         |

**切片 1 锁文件改动的实测依据**：`pnpm-workspace.yaml` 的 `packages/*` glob 已覆盖新包，**该文件无需修改**；但 `pnpm-lock.yaml` 的 `importers` 段会由 5 条增至 6 条（仓库外副本以 `pnpm install --lockfile-only --offline` 实测确认，即使新包零外部依赖亦会写入 `packages/ai: {}`）。`pnpm-lock.yaml` 属 `executionClosurePaths`，故切片 1 会改变执行闭包内容——**这是预期结果，不需修复**；工具 SHA 只在真正执行远程 `--write` 前才锚定（见 `docs/neon-vercel-baseline-runbook.md` §1.1）。

## 2. 已核实的既有事实（切片 1 的起点）

- `ManagementAnalysis` / `RichSection` **只存在于 `docs/query-contract.md` §10 的 TypeScript 草图**，`packages/contracts` 中**没有**对应 Zod 模式 → 切片 1 须新建。
- `MANAGEMENT_ANALYSIS` 当前在 `packages/db/src/query-service.ts:590` 是**被拒绝**的 question_type（「管理分析必须消费确定性结果集合，不能直接查询事实」）→ **AI 层不得走 `POST /api/v1/query`**，必须是独立路由在服务端内部调用查询服务（与 `gate2-design.md` §1.2 一致，无冲突）。
- 现有路由仅 `api/health/live`、`api/health/ready`、`api/v1/query`；`api/v1/ai/respond` 为新增。
- 固定示例引用范围由 `query-contract.md` §10 指定：**E01、E05—E10、E20**。
- 评估集 `data/generated/ai-evaluation-baseline.json` 字段为 `id, category, question, standard_answer, required_numbers, evidence`；`required_numbers` 是可机械比对的数字部分；`data_version` 标注 `LOGIPLAN_2026_DEMO_V1`。
- E19、E20 为越界保护题，标准答案要求分别标记「承运商承接能力未验证」与订单粒度不可得。

---

## 3. 切片 1｜契约与固定示例闭环

**子切分（2026-10-04 追加）**：切片 1 体量偏大，按 `docs/multi-agent-workflow.md` §4.1「可独立验收」拆为两个子切片，各自独立验收、独立审查：

| 子切片 | 范围                                                                                                                  | 验收手段                                                        | 授权                    |
| ------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| **1a** | `packages/contracts` 的 AI 输出模式；`packages/ai` 中立类型、固定示例数据与出口、证据快照存储与六项校验、LRU/容量逻辑 | 纯逻辑，Vitest 单测（时钟与存储可注入）即可验收，**无需浏览器** | 沿用切片 1 的锁文件授权 |
| **1b** | `POST /api/v1/ai/respond` 路由、服务端输入与越界拒绝、五区块 UI、中文映射与可访问性                                   | Playwright + axe + 完整 Gate 1                                  | 同上                    |

拆分理由：1a 是确定性逻辑、可在无浏览器环境完整验证，风险集中在类型与算法；1b 才是集成与呈现层。合并会使单次会话体量过大（首次尝试即空返回、零改动）。

**目标**：把「失败关闭的回退出口」本身建成可用且可验收的东西。本切片结束时 `answer_type` **恒为** `FIXED_EXAMPLE`，系统不调用任何模型即处于完整可用状态。

**写范围**

- `packages/contracts/src/index.ts`（新增 AI 输出模式，独立版本化，不改 V1.0/V1.1 任何现有模式）
- `packages/ai/`（新建包：`package.json`、`tsconfig.json`、`src/`）
- `apps/web/app/api/v1/ai/respond/route.ts`（新建）
- `apps/web/app/ai-workspace.tsx`、`apps/web/app/lib/ai-model.ts` 等新建文件
- `pnpm-lock.yaml`（由新增 workspace 包引起，已授权）

**禁止修改**：`packages/db/src/`、`packages/domain/`、`database/**`、`apps/web/app/page.tsx` 与 `apps/web/app/attribution/page.tsx` 的既有区块、`apps/web/vercel.json`、`vitest.config.ts`、任何覆盖率阈值、既有测试的断言/超时/用例选择。

**执行步骤**

1. 在 `packages/contracts` 新建 `ManagementAnalysis` 与 `RichSection` 的**严格** Zod 模式（`.strict()`），按 `gate2-design.md` §12 独立版本化，不复用或改写 V1.0/V1.1 任何现有模式。
2. 新建 `packages/ai`：中立类型（`GatewayErrorCode`、`ProviderCapabilities`、`AdapterRequest`、`AdapterResult`）、角色路由接口、失败关闭矩阵、审计元数据结构。
3. 实现固定示例出口：内容取自 `data/generated/ai-evaluation-baseline.json` 的 E01、E05—E10、E20 已校验结果。
4. 实现证据快照：键名 `logiplan.ai.snapshot.<snapshot_id>`、六项版本校验、每标签页 20 份 LRU、单份 2 MB 上限（D-190 决策四）。
5. `apps/web` 新增 `POST /api/v1/ai/respond`：浏览器**只提交自然语言（≤500 Unicode 字符）与页面范围地址**；服务端执行确定性查询并组装证据白名单。
6. 页面渲染五区块（结论 / 证据 / 影响 / 建议 / 限制）。

**验收标准**

| 编号   | 内容                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1.1  | 闸门一的页面、数字、证据、性能、安全验收标准**逐项不变**：`pnpm verify:gate1:isolated` 全绿（`Firefox 核心冒烟` 除外，见已记录本地环境限制）                                                       |
| AC1.2  | 新 Zod 模式有 schema 测试：合法样例通过；缺字段、多字段、错误枚举值、空字符串、超长字符串全部失败                                                                                                  |
| AC1.3  | `answer_type` **恒为** `FIXED_EXAMPLE`；用测试断言锁死「本切片不存在任何产生 `LIVE_GENERATED` 的路径」                                                                                             |
| AC1.4  | 固定示例覆盖 E01、E05—E10、E20；每条建议的 `scenario_validation_status` 为 `NOT_RUN`；**输出中不出现任何未经情景计算支持的节省金额**（需断言）                                                     |
| AC1.5  | `limitations.status_labels` 含「相关性不等于因果 · 不得推断未记录的经营因果」；订单粒度保护显示 `ORDER_LEVEL_NOT_AVAILABLE` 对应的中文 `message_zh`，**不向用户只显示内部错误码**                  |
| AC1.6  | 六项版本校验（契约、数据发布、供应商、模型、提示词、输出模式）任一不一致即丢弃快照并回到固定示例，**不得静默降级为「部分可用」**——六个分支各有测试                                                 |
| AC1.7  | 快照容量：第 21 份触发 LRU 淘汰；单份超 2 MB 被拒绝；淘汰依据是**访问时间**而非写入顺序（需构造访问序列验证）                                                                                      |
| AC1.8  | 全部面向用户的字段走**穷尽中文映射**——新增枚举值会导致编译或测试失败                                                                                                                               |
| AC1.9  | 服务端**拒绝**携带供应商名、模型名、任意证据 ID、供应商参数的浏览器请求（各有测试）                                                                                                                |
| AC1.10 | 输入超 500 Unicode 字符被拒绝并返回受控中文状态                                                                                                                                                    |
| AC1.11 | Playwright + axe：五区块可读、键盘可达、焦点可见、中文可访问名称；`/api/health/live` 与 `/api/health/ready` 行为不变                                                                               |
| AC1.12 | `pnpm typecheck`（4 workspace）、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm test:coverage` 退出码 0；`packages/contracts` 覆盖率阈值 95%（D-178）仍满足；新增代码不得使任何既有阈值下降 |
| AC1.13 | `git diff` 证明既有测试的断言、超时、用例选择零改动；`packages/db`、`packages/domain`、`database/`、`apps/web/app/page.tsx`、`apps/web/app/attribution/page.tsx` 零改动                            |

---

**子切片归属**

- **1a 负责**：AC1.2、AC1.3、AC1.4、AC1.6、AC1.7、AC1.12、AC1.13；以及 AC1.8 的映射表与测试部分。1a 另需自证：`packages/ai` 无供应商 SDK 痕迹、无任何 `LIVE_GENERATED` 产出路径。
- **1b 负责**：AC1.1、AC1.5、AC1.9、AC1.10、AC1.11，以及 AC1.8 的页面渲染部分。1b 需实跑 `pnpm verify:gate1:isolated`。

**1b 追加写范围：依赖装配（2026-10-05 授权）**

首次派发时 `slice_owner` 按 R5 停工并报告硬阻塞：`apps/web` **无法 import `@logiplan/ai`**，因为 workspace 依赖边从未建立（`apps/web/node_modules/@logiplan/` 只有 `contracts`/`db`/`domain` 三个软链）。经主 Agent 实测确认，三处装配为必需，已获用户授权：

| 文件                      | 改动                                                | 必要性                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/package.json`   | `dependencies` 增加 `"@logiplan/ai": "workspace:*"` | 不做则 Node/Next 解析 `MODULE_NOT_FOUND`                                                                                                                                             |
| `pnpm-lock.yaml`          | `apps/web` importer 段增加对应条目                  | 不做则 CI 的 `pnpm install --frozen-lockfile` 失败（`.github/workflows/gate1.yml`）                                                                                                  |
| `apps/web/next.config.ts` | `transpilePackages` 增加 `"@logiplan/ai"`           | 该列表现只含被**客户端组件** import 的两个包（`contracts`、`domain`）；1b 的 `ai-workspace.tsx` 是 `"use client"` 且需 import 依赖浏览器 `sessionStorage` 的 `EvidenceSnapshotStore` |

三处均为**纯装配**：`packages/ai` 自身依赖只有 `@logiplan/contracts` 与 `zod@4.4.3`，两者都已在锁文件内，**不引入任何新外部依赖**。`pnpm-lock.yaml` 属 `executionClosurePaths`，切片 1 已就同类改动开过授权先例。

**不得用深相对路径 import 绕过**（如 `../../../../../../packages/ai/src/index`）：那会绕过 package 边界与依赖声明，违反 `gate2-design.md` §1.1 的单向依赖口径；也不得在 `apps/web` 复刻固定示例正文（会造成与 `packages/ai` 的单一真相源分叉，威胁 AC1.3/AC1.4 的断言）。

### 3.1 切片 1b 实施结果（2026-10-05，提交 `392924e2`）

**状态：已收口（2026-10-08）。** 代码已完成并推送、CI 全绿；独立审查首轮 FAIL → 返工 →
**2026-10-08 定向复查 PASS**（三项处置全部成立、未发现新 P0/P1；唯一 P2 = AC1.9 缺 `page_address`
参数的回归测试，已于同日补齐）；**本机真实库验收 `pnpm verify:gate1:isolated` 全绿**（见本节末）。

| 交付项                                                                                          | 提交                                                                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 新建 `apps/web/app/api/v1/ai/respond/route.ts`、`lib/ai-model.ts`、`lib/ai-server.ts`           | `392924e2`                                                                  |
| 新建 `apps/web/app/ai-workspace.tsx`（`"use client"` 五区块）、`tests/gate2-ai-respond.spec.ts` | `392924e2`                                                                  |
| 依赖装配三处（`apps/web/package.json`、`pnpm-lock.yaml`、`next.config.ts`）                     | `392924e2`（锁文件由 `pnpm install --offline` 写入，**仅 3 行** link 条目） |

**独立审查判定 FAIL，三项问题的处置：**

| 级别   | 问题                                                                                                                                                                                                                                   | 处置                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **P0** | `model.ts` 的 `EvidenceAddressBinding` 写成 `evidence_snapshot_id?: string`，与根 `tsconfig.base.json` 的 `exactOptionalPropertyTypes: true` 冲突，`pnpm typecheck` 与 `pnpm build` **双双退出码 1**                                   | 改为 `?: string \| undefined`                                                              |
| **P1** | `validatePageAddress` 只检查 origin / pathname / `destination`，**查询参数一律不校验**——实测走私 `provider` / `model` / `evidence_id` / `evidence_snapshot_id` / `temperature` / 重复 `destination` 全部返回 200 并给出完整固定示例    | 加参数白名单（归因页合法的 9 个参数）并拒绝重复键                                          |
| **P1** | 15 条证据分属 `country` / `bridge` / `diagnostics` / `drilldown` **四个不同的** `evidence_snapshot_id`，而 `ManagementAnalysis.evidence_snapshot_id` 是**单值**（`query-contract.md` §10 定义为必填标量），种子载荷只含 `country` 一族 | 在 `ai-model.ts` 注释中如实标注覆盖缺口与处置方向，**未静默扩范围**改 `packages/contracts` |

P1 第二项的完整影响：逐条打开证据**不受影响**（`entries[].evidence_snapshot_id` 每条自带，审查实测 15/15 全部 200 命中）；但若后续切片按 `gate2-design.md` §4.2「页面恢复的六项校验」真从本页快照恢复，15 条引用中有 **14 条不可解析**。正确处置需把「本回答引用了哪些快照」提升为一等事实（按族分组携带多份种子载荷），要改 `packages/contracts` 与 `query-contract.md` §10，**超出 1b 写范围**。**该缺口留待后续切片处置；切片 1 未收口前不得声称页面恢复能力成立。**

**踩坑记录（供后续切片避免）**：`apps/web/tsconfig.json` 有 `"incremental": true`，工作区里的陈旧 `apps/web/tsconfig.tsbuildinfo` 会让 `pnpm typecheck`（`tsc -p`）**假绿**，而 `next build` 用 `cacheDir/.tsbuildinfo` 这一**另一条路径**所以一直真红。**凡验证类型或构建，必须先删这两处缓存再跑**，否则一条真实红会被误报成绿。

**五区块条件渲染是刻意取舍**：`apps/web/tests/gate1.spec.ts:405` 用**非精确**正则 `page.getByText(/相关性不等于因果/u)`，若无条件渲染限制标签，同一句中文会出现在两处，Playwright 严格模式将报 `resolved to 2 elements`。审查独立复核确认这是同时满足 AC1.1（既有断言不变）与 `query-contract.md` §10（强制标签不得缺失）的唯一解。

**2026-10-08 收口记录**：

- **定向复查：PASS**（全新上下文的只读 `independent_auditor`，固定点 `3acf291e`）。三项处置全部成立：
  P0 `model.ts:315` 已为 `?: string | undefined` 且与 `exactOptionalPropertyTypes` 相容；P1 参数白名单
  （`ai-model.ts:217-227`）的 9 个参数与归因页**实际消费**集合逐一相等、重复键由 `:249-256` 拒绝、
  拒绝返回 **400 + 受控中文**；P1 覆盖缺口在 `ai-model.ts:522-533` 如实标注、契约未被改动。
  AC1.3 / AC1.9 / AC1.10 / AC1.13 均成立，**未发现新的 P0/P1**。
  （口径说明：原 `independent_auditor` 的会话上下文不可跨会话复用，本轮改由**全新上下文的独立只读
  审查者**承担定向复查，独立性不降；此偏差如实记录。）
- **P2 已补齐**：`apps/web/tests/gate2-ai-respond.spec.ts` 新增「AC1.9（P2 回归）页面范围地址不得走私
  越界参数，也不得重复携带参数」——覆盖 `page_address` 内部携带 `provider` / `model` / `evidence_id` /
  `evidence_snapshot_id` / `temperature` 与重复 `destination` 六种走私（断言 400 + `INPUT_REJECTED` +
  受控中文），并加反向对照证明白名单内 9 个参数**不被误拒**。
- **本机真实库验收：全绿（2026-10-08）**。用户在本机终端执行 `pnpm install --frozen-lockfile`
  （466 包、1m51.9s、锁文件未变）后运行 `pnpm verify:gate1:isolated`，**退出码 0**：数据库集成四条腿
  `44/44`、`44/44`、`10/10`、`7/7`（零 fail、skipped 与声明一致）；隔离 PostgreSQL 18.4 上
  `0001—0003` → V1 → `0004—0010` → V2 校验/激活/幂等；`db:verify` / `db:verify-release` /
  `db:verify-plans`（6 条计划 `temp_written_blocks` 全 0）；生产构建；快照 `28/28`；Chromium 双视口基础
  `24 passed / 22 skipped`（**含新 P2 用例在 1440 与 1280 两档通过**）；Chromium 历史证据 `22/22`；
  **Firefox 核心冒烟 `3/3`**；并发 5 × 100 热查询 `p50 27.399ms / p95 49.877ms / p99 56.911ms`；
  隔离容器/卷/网络全部移除。**全程未出现 `3221226505`。**
- **仍未关闭（如实携带，不得表述为已关闭）**：P1 遗留的「15 条证据跨 4 个快照而契约
  `evidence_snapshot_id` 为单值」缺口仍在，**页面恢复能力在处置前不成立**。
  （~~`packages/ai` 覆盖率未知~~ **已于 2026-10-09 关闭**，见 §4.1 的覆盖率条目。）

## 4. 切片 2｜匿名标识、限流、费用与两级熔断

**目标**：在**仍不调用模型**的前提下把成本包围建成可验收的东西。全部用替身与故障注入验证。**授权门 A 已于 2026-10-08 开启（用户明示），可以开工；开工前须按门 A 的范围只新增 `@upstash/redis`，不得顺带引入其它依赖。**

**写范围**：`packages/ai/src/`（限流、费用、熔断、审计）、`apps/web/app/api/v1/ai/respond/route.ts`（接入失败关闭；**2026-10-08 更正**：本条原写 `apps/web/app/api/v1/ai/route.ts`，是笔误——切片 1b 实际交付的路径是 `.../ai/respond/route.ts`，见 §3 与 `1bab77c0`）、`pnpm-lock.yaml`。

**执行步骤**

1. 匿名标识：服务端用**每日轮换密钥**对 `HMAC(规范化 IP ‖ User-Agent 摘要)` 派生；**不得记录或持久化原始 IP 与完整 User-Agent**。
2. 限流：Redis 侧**原子**滑动窗口（单次脚本调用完成计数与判定），键 `rl:{scope}:{role}:{day}`，按角色分别计数。
3. 费用：调用前按角色与最大 token 上限**原子预留**，调用后按供应商返回用量**结算差额**；同一 `request_id` 重复结算不得重复计费。
4. 月预算换算：版本化美元价格 + 保守汇率 + **10% 安全余量** → 人民币（D-190 决策一）。
5. 两级熔断：**L1 = 5 分钟窗口内连续 5 次**瞬时故障；**L2 = 30 元/月**。均失败关闭；L1 窗口滑出后半开重试。
6. 超时与重试：**20 秒硬超时**；429/5xx **重试 1 次**，其余不重试。
7. 可观测性：按 D-138 白名单记录。

**验收标准**

| 编号   | 内容                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| AC2.1  | 匿名标识为**不可逆派生值**；日志与存储中搜不到原始 IP 与完整 User-Agent                                             |
| AC2.2  | 滑动窗口原子性：并发请求下计数不超发                                                                                |
| AC2.3  | **Upstash 不可用 / 超时 / 返回不确定状态 → 失败关闭**：不调用模型、页面显示固定示例、确定性分析不受影响（故障注入） |
| AC2.4  | 限流命中 → 不调用、回落固定示例                                                                                     |
| AC2.5  | `reserve`/`settle` **幂等**：同一 `request_id` 重复结算只计一次                                                     |
| AC2.6  | 月预算换算含 10% 余量；价格版本变更后**旧阈值被拒绝**、必须重新推导                                                 |
| AC2.7  | L1：第 5 次故障触发熔断、第 4 次不触发；窗口滑出后半开重试，成功即闭合                                              |
| AC2.8  | L2：达到 30 元阈值关闭**全部**角色；自然月切换或人工调预算版本后恢复                                                |
| AC2.9  | 20 秒硬超时生效；429/5xx 重试恰好 1 次；其余错误码不重试                                                            |
| AC2.10 | D-138 日志边界：断言日志字段**恰好**是白名单集合（多一个字段即失败）                                                |
| AC2.11 | 提供**当前月度累计用量的只读展示**（D-190 2026-10-04 补充②），且不改变熔断逻辑                                      |
| AC2.12 | 本切片结束时**仍无任何真实模型调用路径被激活**——用测试锁定                                                          |

---

### 4.1 切片 2 实施结果（2026-10-08；2026-10-09 补 AC2.11 展示面）

**状态：主体已提交 `21cef684`（CI 全绿）；AC2.11 的只读 CLI 为 2026-10-09 追加、随本轮提交。**
**两轮独立审查**（首轮 FAIL → 返工 → 定向复查 PASS，无新 P0/P1）；**AC2.11 追加部分另经一次定向复查 PASS**。
**浏览器产物已复核（2026-10-09，用户终端 `pnpm build` + 主 Agent 只读核验）**：`BUILD_ID` = `bq21jUwJM93ySJojS2UF_`；**客户端 `.next/static` 搜 `upstash`（大小写不敏感）零命中**；**正向对照**——服务端产物命中 `server/chunks/1bw4_@upstash_redis_nodejs_mjs_0c-sce4._.js`（被 `server/app/api/v1/ai/respond/route.js.nft.json` 引用），证明依赖仍在服务端正确使用、搜索方法有效；审计首轮实测的泄漏 chunk `1ot1pqlq3-sac.js` 已不存在。

**交付物**（均在授权写范围内）：

- 新增 `packages/ai/src/control-plane/`：`anonymous-id`、`redis-like`、`upstash-redis`、`server`（server-only 装配入口）、`rate-limit`、`pricing`、`budget-ledger`、`circuit-breaker`、`audit-log`、`control-plane`、`test-doubles` + 对应 9 个测试文件。
- 新增 `packages/ai/src/gateway/retry-policy.ts`（+测试）、`packages/ai/src/no-live-call.test.ts`。
- **2026-10-09 追加（AC2.11 展示面）**：新增 `packages/ai/src/read-monthly-usage.ts`（只读 CLI）+ 同名测试；`packages/ai/package.json` 新增 script `usage`（调用方式：`pnpm --filter @logiplan/ai run usage`）。**根 `package.json` 未改动**——它在 `scripts/neon-baseline.mjs` 的 `executionClosurePaths` 内、按第一窗口 T3 先例需单独批准，故未加根级别名。
- 修改 `packages/ai/src/index.ts`（导出）、`packages/ai/src/neutral-boundary.test.ts`（门 A 合规加固）、`packages/ai/package.json`（新增 `@upstash/redis@1.39.0` + `exports["./server"]`）、`apps/web/app/api/v1/ai/respond/route.ts`（惰性门控接缝，既有输出逐字不变）、`pnpm-lock.yaml`。

**门 A 合规**：唯一新增依赖 `@upstash/redis@1.39.0`，唯一传递依赖 `uncrypto@0.1.3`，无 D-182 排除项；未引入任何供应商 SDK。

**独立审查**：首轮 **FAIL**，两项 P1——① `@upstash/redis` 经 barrel 再导出被真实打进**浏览器包**（实测 `.next/static` 客户端 chunk 含 `UpstashError`），与「动态导入不进浏览器包」的自述矛盾；② L1 熔断每请求 `new L1CircuitBreaker()` 且 `recordTransientFailure`/`recordSuccess` **零调用点** → AC2.7 在装配路径上恒不生效。返工后**定向复查 PASS**：改用 server-only 入口 `@logiplan/ai/server` + 静态可达性回归断言；控制面改为进程级单例并新增装配级 AC2.7 测试。另修 P2 两条（时钟移入 `try`、不落盘如实注明）。

**CI（2026-10-09）**：run `37867164623`（`21cef684`，push）**全绿**——`Gate 1 deterministic validation`（含 ubuntu 上的 isolated Gate 1 validation，含 `postgres:18.4` 腿与 Firefox 腿）、`Cross-platform checks`（ubuntu / macOS / Windows 三矩阵）、`CodeQL` 全 success；`Pull request dependency review` 按设计 skipped。这是切片 2 提交后的权威 CI 证据。**AC2.11 追加提交 `675290a8` 的 CI run `37868916338` 同样全绿**（同 5 个 job，`Pull request dependency review` 按设计 skipped）。

**AC 逐条**：**AC2.1—AC2.12 全部满足**（各有测试）。其中 **AC2.11 于 2026-10-09 补齐**——展示面 = **只读 CLI**（`packages/ai/src/read-monthly-usage.ts`）：只读性由替身的**调用序列断言**锁死（`budgetRead` +1，`budgetReserve` / `budgetSettle` / `slidingWindow` 均 0），输出恰为 `MonthlyUsage` 的五个字段（`month` / `used_cny` / `cap_cny` / `price_version` / `fx_version`），**未**新增公开 HTTP 路由（避免在公开演示站暴露花费），**未**改动熔断逻辑。用户 2026-10-08 曾决定顺延到切片 3，2026-10-09 改为现在补齐。

**未执行（不得表述为通过）**：

- ~~浏览器产物复核~~ **已于 2026-10-09 完成**：用户终端 `pnpm build` 成功，主 Agent 只读核验——客户端 `.next/static` 搜 `upstash` **零命中**，服务端产物**有命中**（正向对照，证明搜索有效），旧泄漏 chunk 已不存在。本会话内 `pnpm build` 仍会被 `node-safe-delete-shim` 拦截，项目禁止用 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 绕过（未使用）。
- 真实 Upstash 的 Lua 原子性与 `eval` 运行时行为（无凭据/实例，替身只验接口形态）；**AC2.11 只读 CLI 的「真实 Redis 成功路径」同样未实跑**（本机无 Upstash 凭据）——已验证的是无凭据时的**受控失败路径**（退出码 1、固定中文文案、**无凭据回显**，另以伪造 token/url/密钥实测确认不泄漏）。
- ~~`packages/ai` 覆盖率~~ **已于 2026-10-09 关闭**（经用户批准扩大写范围）：`vitest.config.ts` 的
  `coverage.include` 新增 `packages/ai/src/**/*.ts`，并新增阈值组（`lines 85` / `statements 83` /
  `functions 75` / `branches 78`）。实测全包 **89.87% lines / 86.81% statements / 78.49% functions /
  81.49% branches**（568/632、625/720、146/186、273/335），`pnpm test:coverage` 退出码 0。
  **阈值确定性依据**：`packages/ai` 内**无环境门控跳过**（全仓 11 条 skip 全在
  `packages/db/src/evidence-snapshot.test.ts`，由 `SNAPSHOT_TEST_*` 门控），且 CI 的
  `pnpm test:coverage` 跑在**单一 `ubuntu-latest` job**（`.github/workflows/gate1.yml:50`，非跨平台矩阵）。
  **主要拖累项（如实记录）**：`upstash-redis.ts` 仅 **20% statements / 0% branches / 5% functions**
  ——它的 Lua/`eval` 路径需要真实 Upstash 实例才能执行；**门 C（首次真实付费调用）前补做真实原子性
  验证后应上调该阈值**。`vitest.config.ts` **不在** `scripts/neon-baseline.mjs` 的
  `executionClosurePaths` 内，故本次改动**不触发工具 SHA 重锚定**。
- Playwright / axe 浏览器验收；`verify:gate1:isolated`、`test:db-integration`（会话内 `spawnSync`/`execSync` 恒 `EBUSY`）。

**遗留 P2（记录为后续任务，未在本轮修复）**：

1. **单例缓存键未含 secret**（`control-plane/server.ts:99-102`）：同 Redis 不同 secret 会复用首个运行时 → 同进程内密钥轮换后可能用到旧 secret。今日生产为单密钥单环境，无实际影响；切片 3 或密钥轮换前应把 `secret` 并入键。
2. **进程级缓存无上限/不淘汰**（`server.ts:40,42`）。
3. **可达性断言不跟随动态相对 `import()`**（`no-live-call.test.ts:121`）——当前无此边，断言标题已限定「静态可达性」，属如实。
4. `audit-log.ts` 在切片 2 的 sink 为 `noopAuditSink`（**不落盘**），真实 sink 由切片 3 注入。
5. 路由取 `x-forwarded-for` 的**首个**值（`respond/route.ts:62`）；Vercel 的 XFF 语义本机不可验证，待切片 3 前确认。
6. **测试计数**：以实测为准——切片 2 主体新增约 **70** 条（owner 曾自报 72），AC2.11 的 CLI 追加 +4；**当前全量 `309 passed / 11 skipped (320)`**。
7. **AC2.11 CLI 的 `ok:false` 分支只覆盖「未配置」**：读取期异常会**抛出**（CLI 顶层 `.catch` 已兜住并输出同一固定文案），类型契约与实现略有落差——若日后被程序化复用，调用方需自行处理 throw。
8. **AC2.11 的「读不改熔断」断言偏窄**（`read-monthly-usage.test.ts:55,75`）：能抓到 `recordSuccess`（会把 open 翻回 closed），抓不到 `recordTransientFailure`（open 仍 open）或 `evaluateControlPlane`；只读性的**主要**证据是调用序列增量断言（`:69-72`），已足够。

**L1 状态的存放形态（已知局限，如实记录）**：目前为**进程级单例**，`control-plane/server.ts:32-36` 已注明——在 Vercel serverless 下仅单热实例内有效、跨实例不共享；切片 3 迁至 Redis。

---

## 5. 切片 3｜供应商适配器与网关（首次真实调用）

**授权门 B、C 均未开启前不得开工。**

**写范围**：`packages/ai-provider-openai/`（新建包）、`packages/ai/src/`（网关编排、输出三检）、`packages/contracts/src/`（输出模式版本）、`pnpm-lock.yaml`。

**执行步骤**

1. 适配器：能力声明（结构化输出 / 推理控制 / 留存开关 / 安全标识 / 审核）、标准化错误映射、成本估算（含价格版本）。
2. **能力缺失即失败关闭**——不得静默降级为自由文本。
3. 网关编排：角色路由（配置在**受版本控制的配置文件**中，密钥走环境变量，D-190 决策二）、确定性证据注入。
4. 输出三检：公共 Zod 模式校验 → 证据白名单校验 → **数值回指校验**（每个数值必须回指**同一次**确定性结果）。任一不过**整体丢弃**。
5. 中文输出与 `limitations` 标签生成。

**验收标准**

| 编号   | 内容                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC3.1  | 适配器契约测试全绿；能力声明为 `false` 且角色需要它时返回标准化错误（逐个能力项）                                                                                            |
| AC3.2  | 全部 `GatewayErrorCode` 都有转换路径（穷尽性测试）                                                                                                                           |
| AC3.3  | **供应商中立**：脚本化断言 `apps/web`、`packages/ai`、`packages/db`、`packages/domain`、`packages/contracts` **未导入任何供应商 SDK**、未出现供应商专有响应结构；该断言进 CI |
| AC3.4  | 浏览器**不能**提交供应商名 / 模型名 / 供应商参数（服务端拒绝）                                                                                                               |
| AC3.5  | 三类越界各自**必须失败并回落**：额外数字、未知证据、范围不一致                                                                                                               |
| AC3.6  | 数值回指要求**同一次**确定性结果——跨结果集引用同一数字必须失败                                                                                                               |
| AC3.7  | 失败时**整体丢弃**，不得裁剪 / 修补 / 部分展示                                                                                                                               |
| AC3.8  | 未通过三检时**不得**标为 `LIVE_GENERATED`                                                                                                                                    |
| AC3.9  | 审计元数据完整：供应商、模型、适配器版本、提示词版本、输出模式版本、价格版本                                                                                                 |
| AC3.10 | 每次真实调用被结算；**开发、排错与评估调用同池计入 30 元月度上限**（D-190 2026-10-04 补充）；达到阈值 L2 生效，**不得为实施期绕过 L2**                                       |
| AC3.11 | 完整 L2 验证矩阵 + 覆盖率 + Playwright                                                                                                                                       |

---

## 6. 切片 4｜20 题评估与归档

**写范围**：`packages/ai/src/evaluation/`（或 `scripts/` 下评估入口）、`data/generated/ai-evaluation-baseline.json` 的版本标注对齐、`docs/ai-evaluation-baseline.md` 的记录追加。

**执行步骤**

1. 脚本读评估集，对 E01—E20 逐题发起调用（走真实网关路径）。
2. 每题执行输出三检，再比对 `required_numbers`（**4 位小数精确一致，无容差**）。
3. **区分 `LIVE_GENERATED` / `FIXED_EXAMPLE`**；固定示例答案计该题**不通过**；报告真实生成题数。
4. E19、E20 单独判定并**必须全部通过**。
5. 语义项人工复核：结论、失败原因、以及「是否把相关性写成确定因果」。
6. 记录按 `gate2-design.md` §5.3 进仓库正式文档。

**验收标准**

| 编号  | 内容                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC4.1 | 完整 20 题，门槛 **≥18/20**                                                                                                                                   |
| AC4.2 | **E19、E20 必须全部通过**（任一失败即整体不通过）                                                                                                             |
| AC4.3 | `required_numbers` **精确一致**（4 位小数，不容差）                                                                                                           |
| AC4.4 | **真实生成题数 = 20**；若因 L1 熔断 / 限流 / 预算导致回落固定示例，该题计不通过，且真实生成题数不足时**不得判定评估通过**（D-190 决策三关键约束，需专门测试） |
| AC4.5 | 出现编造数字、虚假证据、或把相关性写成确定因果 → **整体失败**                                                                                                 |
| AC4.6 | 脚本只做机械判定，**语义判断留给人工**并记录结论人                                                                                                            |
| AC4.7 | 评估集数据版本标注已从 `LOGIPLAN_2026_DEMO_V1` 对齐到 `LOGIPLAN_2026_DEMO_V2`（数字基准已核实有效）                                                           |

---

## 7. 阶段闸门（主 Agent 活动，非切片）

按 `docs/multi-agent-workflow.md` §8「阶段闸门、合并或部署前」，在 L2 矩阵基础上追加：**覆盖率**、**完整 Playwright**、路线图规定的**性能与可访问性**检查，以及 CI 三平台矩阵与 ubuntu 的 `gate1` job。

## 8. 全局不变量（每个切片都必须成立）

1. 闸门一的页面、数字、证据、性能、安全验收标准**全部不变**，任何失败路径下都不放宽。
2. `answer_type` 必须如实标注，**不得把固定示例伪装成真实生成结果**。
3. D-182 技术排除项全部保持：不得引入 ORM、查询构建器、GraphQL、OpenAPI 代码生成、消息队列、后台任务框架、全局状态库、客户端查询缓存库、第三方样式/组件/图表系统、微服务、Python 服务，以及 **Dify / LangChain 或任何通用 Agents 框架**。新增依赖仅限 OpenAI SDK（供应商包内）与 Upstash Redis 客户端（中立层）。
4. `packages/ai` 不得导入供应商 SDK；`packages/ai-provider-*` 不得含业务规则。
5. 供应商 / 模型 / 适配器 / 提示词 / 输出模式 / 价格版本任一变化，须重跑完整 20 题，未通过不得激活新配置。
6. 每个切片完成后必须由 `independent_auditor` 独立审查（L2 强制，`multi-agent-workflow.md` §6）。

## 9. 风险与暂停条件

| 风险                                | 处置                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------ |
| 切片 3 首次真实调用产生非预期费用   | 门 C 单独批准；切片 2 的 `reserve`/`settle` 幂等与 L2 熔断必须先通过验收 |
| 供应商 SDK 把专有类型泄漏进业务契约 | AC3.3 的全仓检索断言进 CI，gate 失败即阻断                               |
| 评估集因熔断回落而虚假全绿          | AC4.4 专门测试锁死                                                       |
| 新增 workspace 包改变执行闭包       | 预期结果；工具 SHA 只在真有远程写时锚定                                  |

**暂停条件**（命中即停，一次只问一个问题并给推荐答案）：

1. 切片 3 实际费用超出 30 元月度池。
2. 输出三检出现无法判定「相关性 vs 因果」的灰色地带。
3. 需要放宽闸门一的任何数字、证据或页面验收标准。
4. 需要修改 `pnpm-lock.yaml` 之外的冻结依赖组合。
5. 需要执行远程写入、部署或公开发布。
