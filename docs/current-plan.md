# LogiPlan 当前工作计划（滚动文档）

> **本文件是滚动文档**：每轮**覆盖更新**，只反映**当前**要做的计划，**不累积历史**。
> 历史脉络见 `docs/handoff-*.md` 与 `docs/development-roadmap.md` §0。
>
> **与 `AGENTS.md` 的偏差（已由用户明确指示）**：`AGENTS.md` 要求「不在仓库中保存逐次聊天记录或临时工作日志」。
> 用户于 2026-09-25 明确选择把计划类文档以**单一滚动文档**的形式入库（形式「乙」），取代此前散落在
> `%TEMP%` 的周计划与日计划。**`%TEMP%` 中的周计划与日计划自本文件起不再单独维护。**
> 如需恢复原约定，删除本文件即可。

最后更新：2026-09-25（面向 09-26 起的窗口）

---

## 1. 当前状态（已核实）

- **阶段**：第三阶段「第一闸门」。**代码侧验收全部通过**；稳定性权威证据为 CI（**连续 14 次全绿**，见 D-188）。
- **分支**：`codex/gate1-delivery-baseline`，HEAD 与 `origin` 完全同步；工作区恰 **11 项用户资产**。
- **PR**：`jett3775/LogiPlan#1`，base `main`，OPEN；本分支领先 `origin/main` **34 个提交**。
- **已完成**：第一窗口 **T1—T8** 全部有结论；第二窗口第一段（只读准备）**P1—P6 全部完成**。
- **远端部署**：Production **仅 1 次**，停留在 2026-09-10 的 `a63a43c`（= `origin/main` tip）；
  Vercel 项目已存在且 Git 集成连通，每次推送自动生成 Preview。

---

## 2. 当前计划：E 段（公开测试环境发布）

> **状态：已就绪，待启动。** 用户于 2026-09-25 指示「其余都先不推进」，故本段暂停。
> 下表是启动时的执行顺序（已修正原 E1—E5 的编号与依赖错位——激活的前置是「部署已取得部署标识」，
> 因此**部署必须先于激活**）。

| 步      | 内容                                                                                                                                                | 谁做                                    | 验收标准                                                                                                                                                           | 难度 | 思考强度 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------- |
| **E2a** | Vercel 六项核对：Team `logi-plan` / Project `logi-plan-web` / Root Directory `apps/web` / Framework Next.js / Node.js 24.x / Function Region `sin1` | 你（Vercel UI）                         | 六项逐项确认；**区域必须看部署摘要或 `x-vercel-id`，不能只看设置页**（`vercel.json` 已写 `regions: ["sin1"]`，设置页显示的是项目默认值；若显示 `iad1` 说明未生效） | 低   | `medium` |
| **E2b** | 环境变量**配置**（**实测当前为空，需从零创建**）：Production **只**加池化 `DATABASE_URL`，角色必须 `app_reader`；Preview / Development **不**加     | 你（Vercel UI）                         | Production 下只有一个数据库变量；**构建成功即自证角色正确**（角色不对会直接构建失败）；池化端点需人工看值                                                          | 中   | `medium` |
| **E2c** | 关闭 **Settings → Environments → Production → Branch Tracking → 「Auto-assign Custom Production Domains」**                                         | 你（Vercel UI）                         | 开关已关闭；此后推送 `main` 只产生 `Staged` 部署、不对外服务（见 D-189）                                                                                           | 低   | `medium` |
| **E3**  | 部署：合并 PR（或推送 `main`）→ 产生 **`Staged`** 生产部署                                                                                          | 你 / 我                                 | 出现 `Staged` 状态的生产部署，`ref` = 已通过检查的提交 SHA                                                                                                         | 中   | `medium` |
| **E3b** | **人工 Promote** 该 `Staged` 部署 → `Current`                                                                                                       | 你（Vercel UI）                         | 部署变为 `Current` 并服务生产域名；**promote 不重建**，验证过的构建即上线构建                                                                                      | 低   | `medium` |
| **E1**  | 原子激活：`pnpm db:activate-release -- LOGIPLAN_2026_DEMO_V2`                                                                                       | 你（终端，需 `PUBLISHER_DATABASE_URL`） | 活动发布切换为 `LOGIPLAN_2026_DEMO_V2`；`db:verify-plans` 通过                                                                                                     | 高   | `high`   |
| **E4**  | 激活后复验：`pnpm db:verify-plans`、`/api/health/ready`、核心 9 题、页面冒烟、性能                                                                  | 你 / 我                                 | 核心 9 题通过；热请求 **P95 ≤ 1 s**；`temp_written_blocks` 全 0                                                                                                    | 中   | `high`   |
| **E5**  | 回切路径确认（D-155）                                                                                                                               | 我                                      | 回切路径已确认并写入文档；首次无旧发布时复验失败必须停止公开流量并修复，**不得伪造可回切版本**                                                                     | 中   | `medium` |

**前置已就绪**：迁移 `0001`—`0010` 与 V2 候选校验已于 2026-09-22 完成，且候选资产自 `0229755`
以来逐字节未变、四项校验和一致（见 runbook §1.1）。**本次预计只需部署应用。**

**关键提醒**：`readWebRuntimeDatabaseUrl()` 会校验 `DATABASE_URL` 的角色必须是 `app_reader`——
**角色不对时 Production 构建会直接失败**（以前是静默通过）。反过来，**构建成功即证明角色正确**。

---

### 2.1 E2 操作指引（Vercel UI，逐项）

**入口**：`https://vercel.com/logi-plan/logi-plan-web/settings`

先用左侧边栏顶部的 **scope 切换器**确认当前 scope 是 **`logi-plan`**；页面包屑应显示 `logi-plan / logi-plan-web`。
三处设置都在同一个 Settings 里，**一次进去可全部过掉**。

#### E2a 六项核对

| #   | 项               | 页面                                            | 期望值                         |
| --- | ---------------- | ----------------------------------------------- | ------------------------------ |
| 1   | Team             | 侧栏 scope 切换器 / 页面包屑                    | `logi-plan`                    |
| 2   | Project          | 页面包屑第二段                                  | `logi-plan-web`                |
| 3   | Root Directory   | Settings → **General**                          | `apps/web`（不是空、不是 `/`） |
| 4   | Framework Preset | Settings → **General**                          | `Next.js`                      |
| 5   | Node.js Version  | Settings → **General**                          | **`24.x`**                     |
| 6   | Function Region  | Settings → **Functions** → **Function Regions** | `sin1`                         |

> 部分 UI 版本把第 3—5 项放在独立的 **Build and Deployment** 页；若 General 里找不到，去那里看。

**Node.js Version 是自校验的**：根 `package.json` 冻结 `engines.node = ">=24.15.0 <25"`，且 `.npmrc` 有
**`engine-strict=true`**。若生效版本低于 24.15.0，**`pnpm install` 会直接失败**——所以**构建成功即证明版本合格**，
不需要额外比对。

**Function Region 不要只看设置页（重要）**：`apps/web/vercel.json` 已写 `regions: ["sin1"]`，因此设置页显示的是
**项目默认值**，未必是实际生效值（Vercel 新项目默认 `iad1` 华盛顿）。

- **权威核对方式**：Deployments → 点开任意部署 → **Resources / Deployment Summary**，看实际 default region；
  或 `curl -I https://<部署地址>/api/health/live` 读响应头 **`x-vercel-id`**（首段即区域代码，形如 `sin1::…`）。
- **判据**：显示 `sin1` ✓；显示 `iad1` 说明 `vercel.json` 未生效，需排查。
- Hobby 计划只允许**单一**区域，所以 `sin1` 这一个值本来就合规。

#### E2b 环境变量**配置**（不是核对——实测当前为空）

**页面**：Settings → **Environment Variables**。**2026-09-25 实测该页为「No Environment Variables Added」**，
即这些变量**从未被创建过**，因此本步是**从零创建**，不是核对既有配置。

> 先确认 **「Shared」标签页**也是空的——团队级共享变量不会显示在默认的「Project」标签下。

**要做的**：只加**一个**变量。

| 变量名         | 环境                  | 值                                     |
| -------------- | --------------------- | -------------------------------------- |
| `DATABASE_URL` | **仅勾选 Production** | Neon **池化**连接串，角色 `app_reader` |

值的形态：`postgresql://app_reader:<密码>@<endpoint-id>-pooler.<region>.aws.neon.tech/<库名>?sslmode=require`
—— 在 **Neon 控制台**该分支的 Connection Details 里，打开 **Pooled connection** 开关、角色选 `app_reader` 后复制。

**Type 选 `Secret`**（不要选 `Config`）：这个值里含 `app_reader` 的密码，属于 UI 说明的
「passwords, API keys, and tokens」。代价是保存后**无法再读回**，因此**必须在保存前**在 Value 框里逐项核对
（对话框本身是明文显示，保存后才不可读）。

**已核实的取值**（`docs/neon-permission-baseline-plan.md:90` 与 runbook §0.2/§2 记录，2026-09-22 只读核对
**对着远端确认过**，非猜测）：

| 片段           | 值                                                                   |
| -------------- | -------------------------------------------------------------------- |
| 角色（用户名） | `app_reader`                                                         |
| 库名           | **`neondb`**                                                         |
| endpoint ID    | `ep-empty-shape-b35qu1jv`                                            |
| 区域           | `aws-ap-southeast-1`                                                 |
| 主机名         | 应为 `<endpoint-id>-pooler.<区域>.aws.neon.tech` —— **含 `-pooler`** |
| 密码           | `NEON_APP_READER_PASSWORD`（你 09-22 设的值）                        |
| 查询串         | `?sslmode=require`                                                   |

> **不要手打主机名**——从 Neon 控制台复制，再逐项核对上表。Neon 的主机名格式可能含额外的计算段
> （形如 `ep-…-pooler.c-2.<区域>.aws.neon.tech`），**以控制台实际输出为准**。
> 核对要点：用户名是 `app_reader`、主机含 `-pooler`、库名是 `neondb`、endpoint ID 是 `ep-empty-shape-b35qu1jv`。
>
> **保存后若发现填错**：`Secret` 不能读回，但可以**覆盖**该变量的值重新保存。
> 密码即 `NEON_APP_READER_PASSWORD`，**直接填进 Vercel，不要发给我**。

**不要添加**（任何环境下）：`MIGRATION_DATABASE_URL`、`PUBLISHER_DATABASE_URL`、
`NEON_SCHEMA_MIGRATOR_PASSWORD`、`NEON_DATA_PUBLISHER_PASSWORD`、`NEON_APP_READER_PASSWORD`、
`LOGIPLAN_SCHEMA_MIGRATOR_PASSWORD`、`LOGIPLAN_DATA_PUBLISHER_PASSWORD`、
`LOGIPLAN_APP_READER_PASSWORD`、`POSTGRES_SUPERUSER_PASSWORD`。

**Preview / Development 保持不勾选**——这正好满足冻结要求里「隔离环境缺失时关闭预览数据访问、不得回退到
公开测试库」的 fail-closed 行为。

**自证与不自证**：

- **角色是自证的**：角色不对时 `readWebRuntimeDatabaseUrl()` 会让 **Production 构建直接失败**，
  错误信息含「用户名必须是 app_reader」。**构建成功 ⇒ 角色正确**，不必抠掩码值。
- **池化不自证**（未做该校验，因为本地与 CI 用非池化的本地 PostgreSQL），需人工看值或去 Neon 控制台确认。

**期望管理（重要）**：**只加 `DATABASE_URL` 不会让应用显示出数据。** 当前活动发布仍为 `null`
（V2 只到 `VALIDATED`），在 **E1 激活**之前，`/api/health/ready` 会返回 503「数据库或活动正式版本不可用」。
这是**预期且正确**的，不是故障。

**页底部**：「Enable access to System Environment Variables」**无需为我们的代码开启**——`apps/web` 的
`app/` 与 `next.config.ts` 都不引用任何 `VERCEL_*` 变量。

#### E2c 关闭自动发布

**页面**：Settings → **Environments** → 选中 **Production** → **Branch Tracking** →
关闭 **「Auto-assign Custom Production Domains」**

**期望结果**：此后推送到 `main` 只产生 **`Staged`** 状态的 Production 部署——**不绑定域名、不对外服务**，
须**人工 Promote** 才变 `Current`（见 D-189）。

**判据（下次合并后验证）**：Deployments 里出现一条 `Production` / `Staged` 记录，且生产域名
`logi-plan-web.vercel.app` **仍在服务旧版本**。若它直接变成 `Current`，说明开关没生效。

**注意**：官方文档未记载该开关是否有 plan 限制，请在 UI 确认 Hobby 下可用。若找不到该开关，退路是给
`apps/web/vercel.json` 加 `github.autoAlias: false`（需单独批准代码改动），代价是 promote 时**会重建**。

---

## 3. 暂缓项（用户 2026-09-25 指示「先不推进」）

| 项                       | 说明                                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E 段**                 | 见 §2，已就绪但暂停                                                                                                                                                                                                                                 |
| **S1 闸门二只读设计**    | 产出设计文档：`ModelGateway` 供应商中立边界、OpenAI 适配器参数（D-180）、匿名限流与两级熔断（D-181）、不可变证据快照、20 题评估集重跑条件。**不写生产代码**，不引入 D-182 排除项                                                                    |
| **S2 `pg` 并发告警归因** | 判定「Calling client.query() when the client is already executing a query」是否为 D-183 下 `pg@9` 升级的阻塞项。候选来源 `packages/db/src/query-service.ts` 的三处并发 `pool.query()`（`:257` 2 条、`:1111` 6 条、`:1251` 3 条）配合池上限 `max: 2` |

---

## 4. 已定决策（无需再回答）

- **D-189**：发布门采用 **Vercel 原生 staged production**，不再自建 GitHub Actions 工作流。✓
- **计划类文档以单一滚动文档入库**（形式乙）→ **本文件**。✓

---

## 5. 仍待你决策 / 待授权

1. **在 Vercel UI 执行 E2a / E2b / E2c**（三处都在项目 Settings 里，一次进去可全部过掉）。
2. **（可选）`3221226505` 根因消除**：需批准启用崩溃转储采集（例如为 Playwright 的浏览器进程配置
   `LocalDumps`）。D-188 已明确其根因**未关闭**；不批准则维持「CI 为权威证据 + 本地环境限制」的现状。
3. **（可选）把 `scripts/verify-gate1-isolated.test.mjs` 纳入 `executionClosurePaths`**：
   P1 核查发现它在 `pnpm lint` 清单内但**不在执行闭包内**（闭包 26 条）。两者职责不同、不要求相等，
   但若希望工具 SHA 保护覆盖该回归测试，需单独决定。

---

## 6. 明确不做（沿用既有授权边界）

- Neon 远程写（**除 E1 的原子激活**）、Vercel 部署配置之外的其他远程写。
- **在 E2c 完成之前合并 `main`**（那会触发未经人工批准的自动发布）。
- 强追本地「连续 5/5」（D-188 已把本地 Windows 记为已接受的环境限制）。
- 任何浏览器启动参数类改动。
- 放宽闸门一的任何数字、证据或页面验收标准。

---

## 7. 暂停条件（命中即停下提问，一次一个问题并给推荐答案）

1. E3 产生的是 `Current` 而非 `Staged` 部署（说明 E2c 未生效，须先查开关）。
2. E1 激活后复验失败，且回切路径无法确认。
3. 发布过程中出现「提交结果未知」——按 runbook §6，**只能记录为结果未知，不得宣称回滚**，
   须先用只读状态查询确认。
4. 需要放宽闸门一的任何数字、证据或页面验收标准。
5. 需要执行破坏性数据库操作（`main` 上禁止破坏性删改数据库对象）。

---

## 8. 参考

- 权威资料顺序：`AGENTS.md` → `CONTEXT.md` → `docs/development-roadmap.md` → `docs/decisions.md`
  → `docs/query-contract.md` → `docs/multi-agent-workflow.md`。
- 本窗口详细交接：`docs/handoff-2026-09-26.md`。
- 部署轨道全部细节：`docs/neon-vercel-baseline-runbook.md`（§1.1 冻结锚点、§5.1 环境变量分层、
  §7 部署前清单、§8 平台配额、§9 Neon 隔离性、§10 GitHub 安全治理与发布门、§11 部署现状与 E 段前置）。
