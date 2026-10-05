# LogiPlan 当前工作计划（滚动文档）

> **本文件是滚动文档**：每轮**覆盖更新**，只反映**当前**要做的计划，**不累积历史**。
> 历史脉络见 `docs/handoff-*.md` 与 `docs/development-roadmap.md` §0。
>
> **与 `AGENTS.md` 的偏差（已由用户明确指示）**：`AGENTS.md` 要求「不在仓库中保存逐次聊天记录或临时工作日志」。
> 用户于 2026-09-25 明确选择把计划类文档以**单一滚动文档**的形式入库（形式「乙」），取代此前散落在
> `%TEMP%` 的周计划与日计划。**`%TEMP%` 中的周计划与日计划自本文件起不再单独维护。**
> 如需恢复原约定，删除本文件即可。

最后更新：2026-10-05（面向 10-05 之后的窗口；本文件内容已实际覆盖 2026-09-27 至 2026-10-05 的事件——
本轮完成 `pg` 并发修复、闸门二立项（D-190）与切片 1a，见 §1 与 §9）

---

## 1. 当前状态（已核实）

- **阶段**：**闸门二实施进行中**。闸门一代码侧验收全部通过并持续在 CI 出证；闸门二切片 **1a 已完成**，
  切片 1b 未开工。稳定性权威证据为 CI `ubuntu-latest`（见 D-188）。
- **main**：现为 **`80478e9b`**，与 `origin/main` 同步，工作区干净。CI run **`37252266748`**（head `80478e9b`）
  **全绿**：6 个 job 中 5 个 success（`Gate 1 deterministic validation`、`Cross-platform checks` 的
  ubuntu/macos/**windows** 三矩阵、`CodeQL`），`Pull request dependency review` 按设计 skipped。
  本窗口（10-05 前）推送的关键提交：`7e089efb`（`pg` 串行化）、`54dce871`（`QueryTarget` + brand）、
  `571d9f84`（切片 1a）、`80478e9b`（Windows 分隔符修复）。
- **远端部署**：生产域名 `logi-plan-web.vercel.app` 服务 **`136a2d6`**（2026-09-27 E3b Promote 的构建）。
  ⚠️ **本窗口尚未把切片 1a 的新提交 Promote 到生产**——推送 `main` 只产生 `Staged` 部署，
  须人工 Promote 才对外服务（见 D-189）。**是否 Promote 待用户决定**：切片 1a 不含页面与路由改动
  （`apps/**` 零 diff），生产行为与 `136a2d6` 一致，故不 Promote 亦无功能损失。
- **数据侧**：`LOGIPLAN_2026_DEMO_V2` 已激活（`status = ACTIVE`），固定证据 9 条已物化；
  `db:verify-plans` 通过（6 条计划 `temp_written_blocks` 全 0）。
- **闸门二进展**：**D-190** 已冻结 `gate2-design.md` §11 的五个待确认点（两级熔断参数、角色配置存放、
  20 题评估形态、会话快照容量、评估集版本对齐）。**切片 1a** 新增 `packages/ai`（14 源码 + 9 测试文件）
  与 `packages/contracts` 的 AI 输出 Zod 契约（纯追加 90 行）；`pnpm test` 24 文件 / **235 passed / 11 skipped (246)**；
  经独立审查（首轮 FAIL → 返工 → 复查 PASS → 4 项收口）。详见 `docs/gate2-implementation-plan.md` 与
  `docs/handoff-2026-10-05.md`。
- **E 段已收口（2026-09-27）**：E3b 已 Promote；E4 四项由用户在生产域名复验通过
  （`/api/health/ready` = `ready`、首页九块均有数字与证据侧栏、核心 9 题正常、热请求 P95 达标）。
  E5 见 runbook §12。

---

## 2. 当前计划：E 段（公开测试环境发布）

> **状态：已完成（2026-09-27）。** E2a / E2b / E2c、E3、E1、E3b、E4、E5 全部收口：生产域名已服务新构建，
> 站点四项复验通过。执行实录见 `docs/neon-vercel-baseline-runbook.md` §11.4，回切路径见同文件 §12。
> 下表保留为执行顺序的权威记录（已修正原 E1—E5 的编号与依赖错位——激活的前置是「部署已取得部署标识」，
> 因此**部署必须先于激活**）。

| 步      | 内容                                                                                                                                                | 谁做                                                  | 验收标准                                                                                                                                                           | 难度 | 思考强度 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------- |
| **E2a** | Vercel 六项核对：Team `logi-plan` / Project `logi-plan-web` / Root Directory `apps/web` / Framework Next.js / Node.js 24.x / Function Region `sin1` | 你（Vercel UI）                                       | 六项逐项确认；**区域必须看部署摘要或 `x-vercel-id`，不能只看设置页**（`vercel.json` 已写 `regions: ["sin1"]`，设置页显示的是项目默认值；若显示 `iad1` 说明未生效） | 低   | `medium` |
| **E2b** | 环境变量**配置**（**实测当前为空，需从零创建**）：Production **只**加池化 `DATABASE_URL`，角色必须 `app_reader`；Preview / Development **不**加     | 你（Vercel UI）                                       | Production 下只有一个数据库变量；**构建成功即自证角色正确**（角色不对会直接构建失败）；池化端点需人工看值                                                          | 中   | `medium` |
| **E2c** | 关闭 **Settings → Environments → Production → Branch Tracking → 「Auto-assign Custom Production Domains」**                                         | 你（Vercel UI）                                       | 开关已关闭；此后推送 `main` 只产生 `Staged` 部署、不对外服务（见 D-189）                                                                                           | 低   | `medium` |
| **E3**  | 部署：合并 PR（或推送 `main`）→ 产生 **`Staged`** 生产部署                                                                                          | 你 / 我                                               | 出现 `Staged` 状态的生产部署，`ref` = 已通过检查的提交 SHA                                                                                                         | 中   | `medium` |
| **E3b** | **人工 Promote** 该 `Staged` 部署 → `Current`                                                                                                       | 你（Vercel UI）                                       | 部署变为 `Current` 并服务生产域名；**promote 不重建**，验证过的构建即上线构建                                                                                      | 低   | `medium` |
| **E1**  | 原子激活：`pnpm db:activate-release LOGIPLAN_2026_DEMO_V2`（**不带 `--`**，pnpm 10.x 会把它当参数传下去）                                           | 你（终端，需 `PUBLISHER_DATABASE_URL`，**直连**端点） | 活动发布切换为 `LOGIPLAN_2026_DEMO_V2`；`db:verify-plans` 通过                                                                                                     | 高   | `high`   |
| **E4**  | 激活后复验：`pnpm db:verify-plans`、`/api/health/ready`、核心 9 题、页面冒烟、性能                                                                  | 你 / 我                                               | 核心 9 题通过；热请求 **P95 ≤ 1 s**；`temp_written_blocks` 全 0                                                                                                    | 中   | `high`   |
| **E5**  | 回切路径确认（D-155）                                                                                                                               | 我                                                    | 回切路径已确认并写入文档；首次无旧发布时复验失败必须停止公开流量并修复，**不得伪造可回切版本**                                                                     | 中   | `medium` |

**前置已就绪**：迁移 `0001`—`0010` 与 V2 候选校验已于 2026-09-22 完成，且候选资产自 `0229755`
以来逐字节未变、四项校验和一致（见 runbook §1.1）。**本次预计只需部署应用。**

**关键提醒**：`readWebRuntimeDatabaseUrl()` 会校验 `DATABASE_URL` 的角色必须是 `app_reader`——
**角色不对时 Production 构建会直接失败**（以前是静默通过）。反过来，**构建成功即证明角色正确**。

**执行进度（2026-09-27）**

| 步      | 状态            | 依据                                                                                                             |
| ------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| **E2a** | ✅ 完成         | 用户在 Vercel UI 核对                                                                                            |
| **E2b** | ✅ 完成         | 反证：新构建 `/api/health/ready` 返回「数据库或活动正式版本不可用」，走到该分支即证明变量存在且角色校验通过      |
| **E2c** | ✅ 完成且已生效 | 生产域名仍服务旧构建 `a63a43c`，`16b1df8` 的生产部署停留在 `Staged`                                              |
| **E3**  | ✅ 完成         | main 快进到 `16b1df8`，PR #1 自动 MERGED，5 项检查全绿；随后追加纯文档提交 `136a2d6`                             |
| **E3b** | ✅ 完成         | 你已 Promote `136a2d6`（该 SHA 应用产物与 `16b1df8` 相同），且经 §2.1 E2c 的可靠判据确认域名内容已切换           |
| **E1**  | ✅ 完成并核实   | 活动发布 = `LOGIPLAN_2026_DEMO_V2`（`status = ACTIVE`），9 条固定证据物化                                        |
| **E4**  | ✅ 完成         | `db:verify-plans` 通过（6 条计划 `temp_written_blocks` 全 0）；`ready`、核心 9 题、页面与 P95 四项由用户复验通过 |
| **E5**  | ✅ 完成         | runbook §12                                                                                                      |

**重要更正（2026-09-27）**：曾因把 **Staged 部署专属 URL** 上的内容当作生产域名内容，误判 E2c 失效。
**唯一判据是生产域名本身服务的内容，或面板上的 `Staged` / `Current` 标签**——Staged 部署的详情页也会列出生产域名。
详见 runbook §11.4 的陷阱 1。

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

**Type 选 `Secret`**（不要选 `Config`）：这个值里含 `app_reader` 的密码，官方文档对 Secret 的说明就是
「write-only after saving. **Use them for passwords, API keys, and tokens.**」，而 Config 是
「for non-sensitive configuration」。因此**必须在保存前**在 Value 框里逐项核对（对话框本身是明文显示）。

`Secret` 的三条后果（均已查证官方文档）：

1. **保存后值不可读回**；「You cannot convert a saved Secret to Config in place」——若日后想改成可读，
   必须**删除后重建**，不能原地转换。
2. **值可以编辑（轮换），但键名不可编辑**：「You cannot edit the key of a Secret after it is saved.」
3. **构建时仍然可用**：文档的「Build log redaction」一节写明「During builds, if a Secret environment
   variable value is 32 characters or longer and appears in build logs, Vercel replaces the value with
   `[REDACTED]`」——即 Secret 在构建阶段是存在的（否则无从脱敏）。**因此
   「Production 构建成功即自证角色正确」这一判据成立**，构建时会真的执行
   `readWebRuntimeDatabaseUrl()` 的角色校验。

（另：若团队启用了可选的「Separate Production Secret Values」策略，同一个 Secret 键在 Production 与
其他环境必须用不同值。本项目只在 Production 设该变量、Preview/Development 留空，**不冲突**。）

**已核实的取值**（`docs/neon-permission-baseline-plan.md:90` 与 runbook §0.2/§2 记录，2026-09-22 只读核对
**对着远端确认过**，非猜测）：

| 片段           | 值                                                                |
| -------------- | ----------------------------------------------------------------- |
| 角色（用户名） | `app_reader`                                                      |
| 库名           | **`neondb`**                                                      |
| endpoint ID    | `ep-empty-shape-b35qu1jv`                                         |
| 计算段         | `c-4`（**2026-09-27 实测补充**；缺它会认证失败）                  |
| 区域           | `aws-ap-southeast-1`                                              |
| 主机名         | `ep-empty-shape-b35qu1jv-pooler.c-4.ap-southeast-1.aws.neon.tech` |
| 密码           | `NEON_APP_READER_PASSWORD`（你 09-22 设的值）                     |
| 查询串         | `?sslmode=require`                                                |

**主机名的推导（四步；前三步有仓库证据，第四步为 2026-09-27 只读实测）**：

1. endpoint ID = `ep-empty-shape-b35qu1jv`（runbook §2、`docs/neon-permission-baseline-plan.md:90`）。
2. **主机名里的区域标签是 `ap-southeast-1`，不是 Neon 的区域标识符 `aws-ap-southeast-1`** ——
   `scripts/neon-permission-audit.test.mjs:45` 的夹具直接用了我们这台的 endpoint ID。
3. 池化主机 = `<endpoint-id>-pooler.<后缀>` —— `scripts/neon-baseline.mjs` 的 `roleHostFromAdmin`
   取 endpoint ID **之后的整段后缀**，因此**只要管理连接串正确，它会自动导出正确的池化主机**；
   `scripts/neon-baseline.test.mjs:763` 的夹具印证。
4. **endpoint ID 与区域段之间还有一段计算标识，本机为 `c-4`。** 2026-09-27 实测：管理连接串的主机是
   `ep-empty-shape-b35qu1jv.c-4.ap-southeast-1.aws.neon.tech`，其 TLS 证书 altname 为
   `*.c-4.ap-southeast-1.aws.neon.tech`；**漏掉 `c-4` 的两个主机（直连与池化）均以 `28P01`
   认证失败**，说明它们不是同一计算实例。故早期文档中不带 `c-4` 的写法是错的。
   证据见 `docs/neon-vercel-baseline-runbook.md` 第 1.2 节。

**完整值**（唯一需要你填的是密码；仓库与磁盘上**都没有**这个值，且**不应**写进任何文档或聊天）：

```
postgresql://app_reader:<你的 NEON_APP_READER_PASSWORD>@ep-empty-shape-b35qu1jv-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

> **保存前在 Value 框里核对五点**：用户名 `app_reader`、主机含 `-pooler`、主机含计算段 `c-4`、
> 库名 `neondb`、后缀 `c-4.ap-southeast-1.aws.neon.tech`。**若 Neon 控制台给出的字符串与上式
> 任何一处不同，以控制台为准**——控制台是权威来源，上式已由 2026-09-27 只读实测确认可连通。
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
须**人工 Promote** 才变 `Current`（见 D-189）。官方 staging 指南原文：
「When you push to your production branch, Vercel creates a production deployment but does not assign it to your domains.」

**状态：已完成并已实测生效（2026-09-27）**——推送 main 后 `16b1df8` 的生产部署停在 `Staged`，
生产域名仍服务旧构建 `a63a43c`。

**判据（下次合并后验证，务必按此处判定）**：只有两条可靠判据——

1. **生产域名本身服务的内容**：旧构建首页为「LogiPlan 正式工程 / 兼容性骨架状态：已就绪 / 0.1 + 0.2 = 0.3」；
   新构建为仪表盘工作台。域名内容变了才是没生效。
2. Vercel 面板上的 **`Staged`** / **`Current`** 标签。

**⚠️ 两个伪判据（2026-09-27 曾因此误判，不要再犯）**：

- **「详情页 Domains 里列了 `logi-plan-web.vercel.app`」不算已绑域名**——Staged 部署的详情页同样会列出生产域名。
- **Staged 部署有自己的专属 URL**（形如 `https://logi-plan-<hash>-logi-plan.vercel.app`），在它上面看到的内容
  **不是**生产域名的内容；把两者混同会得出相反结论。

**注意**：官方文档未记载该开关是否有 plan 限制，请在 UI 确认 Hobby 下可用。若找不到该开关，退路是给
`apps/web/vercel.json` 加 `github.autoAlias: false`（需单独批准代码改动），代价是 promote 时**会重建**。

---

## 3. 闸门二当前计划（实施阶段）

**权威依据**：`docs/gate2-implementation-plan.md`（切片划分、执行步骤、验收标准）。
参数已由 **D-190** 冻结，`docs/gate2-design.md` §11 的五个待确认点全部关闭。

| 切片   | 内容                                                                                                 | 状态                                                                                        | 授权门             |
| ------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| **1a** | `packages/contracts` AI 输出契约；`packages/ai` 中立类型、固定示例出口、证据快照与六项校验、LRU/容量 | ✅ **已完成并推送**（`571d9f84` + `3744ef06` + `8754165f` + `80478e9b`），两轮独立审查 PASS | 已获授权           |
| **1b** | `POST /api/v1/ai/respond` 路由、服务端越界拒绝、五区块 UI、中文映射与可访问性                        | ⏳ **下一切片**                                                                             | 沿用 1a            |
| 2      | 匿名标识、限流、费用与两级熔断（仍零真实调用）                                                       | ⏳ 未开工                                                                                   | **门 A 未开启**    |
| 3      | 供应商适配器 + 网关 + 输出三检（**首次真实付费调用**）                                               | ⏳ 未开工                                                                                   | **门 B、C 未开启** |
| 4      | 20 题评估脚本 + 人工归档                                                                             | ⏳ 未开工                                                                                   | 依赖切片 3         |
| 闸门   | 阶段闸门（覆盖率、完整 Playwright、性能与可访问性、三平台 CI）                                       | ⏳ 未开始                                                                                   | 主 Agent 活动      |

**排序原则**：先建安全与成本包围，再放进真实模型调用。切片 1、2 全程零成本、零外部服务依赖。

**切片 1b 的三条易漏交接要点**（来自 1a 的独立审查，务必遵守）：

1. 固定示例的 15 个证据 ID **全部可在英国归因页解析**；页面只检索 `country`/`bridge`/`diagnostics`/`drilldown` 四族。
2. E08/E09 的三个数字在 `limitations` 中作为**不可点开的口径说明**呈现，**不得渲染为证据链接**。
3. 固定示例的 `evidence_snapshot_id: "SNAPSHOT_GB_2026_08_V1"` 是**编造占位值**，
   1b **必须绑真实服务端快照 ID**；`attribution-workspace.tsx:542` 要求证据对象带该字段才打开面板。

**已知缺口**：`packages/ai` **不在 `vitest.config.ts` 的 `coverage.include` 内**（该文件在切片 1a 禁改），
其覆盖率**未知**——既不能称高也不能称低。99 项测试提供实质保护但无覆盖率门。
须在有该文件写权限的切片或阶段闸门补齐。

---

## 4. 暂缓项（用户 2026-09-25 指示「先不推进」）

| 项                       | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1 闸门二只读设计**    | ✅ **已完成（2026-09-28）**：产出 `docs/gate2-design.md`——`ModelGateway` 供应商中立边界与适配器契约、D-180 适配器参数、匿名限流与两级熔断、不可变证据快照与三检、20 题评估集与重跑触发条件、角色路由、失败关闭矩阵、验收矩阵、D-182 排除项自查。**未写生产代码**，未引入 D-182 排除项。**2026-10-04：设计文档 §11「实施前需确认的点」五项已全部关闭并冻结于 `docs/decisions.md` D-190**（L1 = 5 次 / 5 分钟、L2 = 30 元人民币；角色配置受版本控制、密钥仍走环境变量；评估为脚本自动 + 人工复核归档；评估集 V2 对齐已核实数字基准有效；快照每标签页 20 份 LRU、单份 2 MB）。D-190 另含一条实施约束：评估脚本必须区分 `LIVE_GENERATED` 与 `FIXED_EXAMPLE`，固定示例的答对应计该题不通过，真实生成题数不足时不得判定评估通过。闸门二**实施尚未立项**，且 D-190 不授权任何真实付费调用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **S2 `pg` 并发告警归因** | ✅ **已完成（2026-09-28）**：结论见 `docs/pg-concurrency-deprecation.md`——触发条件已源码级确认（同一 `Client` 上并发提交查询），触发点为 `query-service.ts:257/1111/1251` 经 Web 的 `pool.connect()` 分支与三个 CLI 脚本；判定**需先修但不阻塞当前计划**（`pg` 尚无 9.x）。真实库端到端复现未完成（沙箱无 PG/Docker），已如实记录。**2026-10-02 修复已落地并验证**：归因已在真实 `postgres:18.4` 上复核——告警的判定对象是**单个 `Client` 的 `_queryQueue`**，故三处并发 `pool.query()` **不是**告警源（`Pool.query` 每次取独占 client）；真实触发源是 V1.1 单连接事务路径与发布物化路径。已新增模块私有 `serializeQueries` 并**只在两个单连接判定点注入**，V1.0 纯 Pool 路径与三处 `Promise.all` 保持不变；新增 6 个回归测试（`pnpm test` 15 文件 128 passed / 11 skipped / 139）。完整 Gate 1 以 `--trace-deprecation` 跑完全程零告警（含 E1 激活物化步骤），唯一失败仍是已收口的 `Firefox 核心冒烟` 本地环境限制。落地与验证记录见 `docs/pg-concurrency-deprecation.md` §8。**2026-10-04 补充**：串行化实现已重构为唯一工厂 `createQueryTarget(source, concurrency)`（`"single"` 分支承担串行化，`"pool"` 分支不做包装；独立函数 `serializeQueries` 不再存在），三处并发 `Promise.all` 仍逐字未改；并发判定点改收带模块私有 nominal brand 的 `QueryTarget`，裸 `Client` 与手写 `{ db, concurrency }` 字面量在编译期均被拒绝，§5 第 8 条那条「类型层面区分尚未闭合」的遗留**已更新为已实质闭合**（残余边界见 §5 与 `docs/pg-concurrency-deprecation.md` §8.6）。`pnpm test` 现为 15 文件 136 passed / 11 skipped / 147；真实库 `verify:gate1:isolated` 复验**进行中、尚未验证** |

> **2026-09-27 实测补充**：该并发告警在 E1 激活时**真实出现**（`activate-release` 运行日志中的
> `DeprecationWarning: Calling client.query() when the client is already executing a query`），
> 因此 S2 不再是纯理论问题，其触发面覆盖到发布/激活入口。
> **已于 2026-09-28 归因收口**：触发条件是**同一 `Client` 上并发提交查询**（源码 predicate + 静态路径 + 该日志三方一致），
> 结论与处置建议见 `docs/pg-concurrency-deprecation.md`。
>
> **2026-10-02 追加**：上条**归因与修复均已落地并验证**，且 `docs/development-roadmap.md` §0 遗留项 5 曾把候选来源
> 误记为三处并发 `pool.query()` 配合 `max: 2`——该说法**已被证伪并以 dated 注记修正**（原文保留）。
> **`pg@9` 仍未发布**（npm 最新 `8.23.0`），D-183 兼容性闸门**当前仍无可执行对象**；闸门入口条件中
> 「不得在同一 client 上并发提交」的回归防线已由 6 个测试就位。详见 `docs/pg-concurrency-deprecation.md` §8
> 与 `docs/development-roadmap.md` §0 遗留项 5 的 2026-10-02 注记。

---

## 5. 已定决策（无需再回答）

- **D-190**：冻结闸门二实施前的四项参数与配置形态——L1 = 5 分钟内连续 5 次、L2 = 月度 30 元；
  角色配置受版本控制（密钥仍走环境变量）；20 题评估为脚本自动 + 人工复核归档；
  会话快照每标签页 20 份 LRU、单份 2 MB。**调试与评估调用同池计费，不分池。**
  **D-190 不授权任何真实付费调用**，也不代表闸门二实施已立项。✓
- **D-189**：发布门采用 **Vercel 原生 staged production**，不再自建 GitHub Actions 工作流。✓
- **切片 1 的 `pnpm-lock.yaml` 改动已授权**（2026-10-04 用户明示）：新增 workspace 包必然修改锁文件
  `importers` 段，该文件在执行闭包内。✓
- **`AGENTS.md` 与 `multi-agent-workflow.md` §2.6 的模型降级口径已生效**（`be527ba7`）：
  首选模型不可用时可改为不显式指定、用当前可用模型继续，但必须记录偏差，
  且不降低分级、验证与独立审查的任何要求。✓
- **计划类文档以单一滚动文档入库**（形式乙）→ **本文件**。✓

---

## 6. 仍待你决策 / 待授权

1. **E 段已全部完成**（E2a / E2b / E2c / E3 / E3b / E1 / E4 / E5，2026-09-27）。
2. **凭据轮换：已完成并验证（2026-09-28）**。四个角色（`app_reader` / `neondb_owner` / `schema_migrator` /
   `data_publisher`）全部轮换；原始值与首次重设值共 7 个凭据经只读探测全部报 `28P01`；最终值由 Neon Console
   的 **Reset password** 生成、只在弹窗显示一次，全程未进入对话。执行记录与两条操作教训见
   `docs/neon-vercel-baseline-runbook.md` §13（关键教训：**回显不能当验证，必须用独立探测**；优先用 Reset 按钮）。
3. **（已挂起）`3221226505` 根因消除**：取证步骤与 LocalDumps 配置已写入 `docs/windows-crash-evidence.md`
   （先做只读的事件日志 / WER 报告排查，必要时再启用按映像名的崩溃转储采集）。**需在 Windows 本机执行**；
   注册表改动属机器级配置，须明确批准。**2026-09-28 挂起**：用户开发机已切换为 macOS 且不再持有 Windows 机器，
   该流程（WER / LocalDumps）无对应机制，故本轮不执行；**不新增决策、D-188 正文不改**，待重新拥有 Windows
   机器时按原步骤恢复执行（届时把取证文档状态改回「待执行」）。D-188 的现状（CI 为权威证据 + 本地记录为
   已接受环境限制）在未取得 Faulting module 结论前**维持不变**；注意其中「本地 Windows」指的是当时的环境，
   现在已不存在，属历史记录而非当前事实。
4. **（已执行）把 `scripts/verify-gate1-isolated.test.mjs` 纳入 `executionClosurePaths`**：闭包由 **26 条增至 27 条**，
   并在 `scripts/neon-baseline.test.mjs` 的覆盖断言中同步登记。本地验证：3 个测试文件 61 项（58 通过、0 失败、
   3 项 Docker 条件跳过），`pnpm lint` 与 prettier 均通过。**副作用**：闭包变化使既有工具 SHA 对应的执行闭包失效，
   下一次 `neon-baseline --write` 前须重新锚定并批准工具 SHA（runbook §11.2 第 3 点）。
   **2026-10-02 复算实测**：执行闭包 `executionClosurePaths` 长度 = **27**（与上条一致）；候选
   `0229755a097dff94c8de67954b36ab4f9412c0f5` 现已落后 **77 个提交**（实测
   `git rev-list --count 0229755a…..HEAD` = 77；`docs/development-roadmap.md` §0 遗留项 8 当时记录的 22 为
   2026-09-25 实测值）。**该值随分支推进单调增加，进入写入模式前须以当时实测为准**。硬前置不变：
   `neon-baseline --write` 前必须重新锚定并独立批准工具 SHA。**本次未提交改动、未生成新工具 SHA、未申请批准**。
   **2026-10-05 复算实测**：候选 `0229755a…` 现已落后 **94 个提交**（实测
   `git rev-list --count 0229755a…..HEAD` = 94；上条记录的 77 为 2026-10-02 实测值）。
   执行闭包仍为 **27 条**，但**闭包内容已因闸门二切片 1a 再次变化**——新增 `packages/ai`
   workspace 包使 `pnpm-lock.yaml` 的 `importers` 段由 5 条增至 6 条（该文件在闭包内，
   已获用户授权的必然改动）。旧工具 SHA `e03d192…` 相对当前闭包有 7 条路径、21 文件漂移，确认失效。
   **锚定仍必须推迟**：按 runbook §1.1，工具 SHA 须取 `--write` 执行当时的 HEAD，
   任何后续提交都会使其失效；而当前**无任何待执行的 `--write`**（见 §7），
   现在锚定等于制造一个立即失效的锚点。
5. **（已收口）Dependabot 失败运行排查**：`npm_and_yarn in /. - Update #1593405539`（2026-09-27T15:36:30Z，failure）
   根因已定位——Dependabot 升级 `react-dom` 到 `19.3.0` 时，因 `.npmrc` 的 `strict-peer-dependencies=true`
   报 `ERR_PNPM_PEER_DEP_ISSUES`（`react` 仍 19.2.8、`@types/react` 仍 19.2.18），属**预期摩擦而非故障**。
   建议在 `dependabot.yml` 用 `groups` 把 react 家族编组；**不得**放宽 `strict-peer-dependencies`。
   另附当前 10 个开放 Dependabot PR 的分类（4 个改工作流 action SHA、4 个触碰冻结依赖组合、1 个常规补丁），
   结论是**一个都不应顺手合并**。详见 `docs/neon-vercel-baseline-runbook.md` §10.1.1—§10.1.2。
   **（2026-10-04 已实施）** `groups` 编组已加入 `.github/dependabot.yml`：把 `react`、`react-dom`、
   `@types/react`、`@types/react-dom` 四个包编为 `react-family` 一组，`update-types` 取 `minor` 与 `patch`，
   并在文件内注明该摩擦属预期而非故障、**不得**以放宽 `strict-peer-dependencies` 消除。实测确认该编组
   仍有必要：当前 react 家族为 `react@19.2.8` / `react-dom@19.2.8` / `@types/react@19.2.18` /
   `@types/react-dom@19.2.4`，而开放的 **PR #9 只改 `react` 与 `@types/react`**（`apps/web/package.json`
   仅 +2/−2），单独合并会留下 `react@19.3.0` 配 `react-dom@19.2.8` 的错配，在
   `strict-peer-dependencies=true` 下直接失败。`.github/` **不在 `executionClosurePaths` 内**，本改动
   不改变执行闭包、未触碰 `pnpm-lock.yaml`。既有 10 个开放 PR 的合并判断不变（一个都不应顺手合并；其中
   #2、#3、#6 为 action 主版本跳跃，风险更高）。
6. **（待验证）macOS / Windows 双环境保障（2026-09-28 轮次）**。需求由你提出：两套系统都要能开发与使用。
   已交付三项：① CI 新增 `cross-platform` job（`ubuntu-latest` / `macos-latest` / `windows-latest`，
   跑 `format:check + lint + typecheck + test` 与 `scripts/` 下的三个测试文件）——**不参与 Gate 1 稳定性判定**，
   稳定性权威证据仍是 ubuntu 的 `gate1` job（D-188 不变）；② 新增平台中立包装器 `scripts/run-gate1.mjs`
   （`--target/--repeat/--timeline` → 既有环境变量，两端同一条命令）；③ 新增 `.editorconfig`。
   审计结论：代码层**原本就是跨平台设计**（`taskkill` / `detached` / `NUL` 与 `/dev/null` / Docker 候选探测
   均有 win32 分支，全部 npm 脚本为 Node 而非 POSIX shell），真正缺口是**这些 win32 分支从未被机器验证过**——
   `scripts/` 下的测试此前不在 vitest 收集范围内、也不在任何一个 CI job 中执行，本次由矩阵首次覆盖。
   **刻意未改 `package.json`**：它在 `executionClosurePaths` 内，加 npm 脚本别名会让闭包再变一次、
   又要重新锚定工具 SHA，故包装器只以 `node scripts/run-gate1.mjs` 调用。
   **验证状态**：本机（Linux）已验证 prettier / lint / typecheck / 单元测试与包装器行为；
   三个平台的机器验证以 CI 结果为准，**未通过前该项不算完成**。
   **2026-09-28 补充**：矩阵首次运行即在 `windows-latest` 抓到真实缺陷——`actions/checkout` 继承
   `core.autocrlf=true` 使工作区为 CRLF，`pnpm format:check` 对 123 个文件报错；已由 `.gitattributes`
   的 `* text=auto eol=lf` 修复，随后四个 job 全绿（Windows 上 `scripts/` 测试 61 项 / 59 通过 / 0 失败）。
   用户当前**仅有 macOS 机器**，Windows 侧兼容性自此**只由 CI 保证**（矩阵里已有该 runner），无需本机 Windows。
   **（已执行，2026-09-28）macOS 本机基线**：用户在新 Mac 上执行 `node scripts/verify-local-baseline.mjs`，
   **五项检查全通过**——平台 `darwin arm64`、Node `24.15.0`、pnpm `10.34.5`（正好是 `.nvmrc` 与
   `packageManager` 指定值）；脚本测试 `61 / 58 / 0 / 3`、单元测试 `122 / 11 / 133`，
   与 CI `ubuntu-latest` 及沙箱 Linux **逐项一致**。据此 `docs/development-roadmap.md` §0 已加注：
   本地环境换为 macOS、D-188 三条决策不变、Windows 记录转历史。
   剩余可选：完整 Gate 1（`pnpm verify:gate1:isolated`，需 Docker Desktop）——**已在 2026-09-30 执行**：
   除 `Firefox 核心冒烟`（该版本 macOS 的环境限制，见 §5.7）外全部通过。因此**不提请**把 D-188 的
   「本地环境」一栏改写为「本地基线通过」——本地仍有腿不可运行，该栏**维持原措辞**；事实更新以
   `docs/development-roadmap.md` §0 的 2026-09-30 注记为准（平台区分，不改 D-188 正文）。
7. **（已收口，2026-09-30）macOS 上 `Firefox 核心冒烟` 挂起（首台 macOS 机器实测）**。同日 macOS 首次完整 Gate 1
   已推进至浏览器阶段，此前全部阶段通过（数据库集成四条腿、迁移/发布/激活/校验、生产构建、快照 `28/28`、
   Chromium 双视口基础 `10 passed / 22 skipped`、Chromium 历史证据 `22/22`）；**唯一失败**是 Firefox 冒烟：
   首条用例 `0ms` 失败且无用例输出，随后 Playwright 挂起，被步骤超时 `240s` 终止（`timedOut` 分支），
   Playwright 的失败详情未及打印（编排 `stdio: inherit`，无缓冲可补）。
   已排除：权限位问题（同日已修复）、Docker/镜像、`.env` 缺失。**2026-09-30 续：根因区间已收窄**——
   最小判据（`firefox.launch()`，无需数据库/服务）复现为 `browserType.launch: Timeout 180000ms exceeded`，
   日志显示 `sandbox_extension_issue_file_to_process failed for …/plugin-container.app: 1 (Operation not permitted)`：
   Firefox 主进程能起，但**内容进程的沙箱扩展签发被拒**，Juggler 管道未建立。同机 Chromium 两轮全过 ⇒
   非系统范围策略问题，指向该 Firefox 构建在本机的签名/沙箱条件。
   同次发现的 `4173 已占用` 是该失败的**后果**（挂起被强杀时 Playwright 自起的 webServer 未被清理），
   属次生现象、需先清理以免掩盖真因。**待判据**：`xattr -l`（`com.apple.quarantine`）、
   `codesign -v --deep`（嵌套 app 签名是否有效）、`spctl -a -vv`、`sw_vers`；
   修复尝试：`pnpm exec playwright install --force firefox` 后重跑最小判据。
   **边界**：不得用浏览器启动参数类开关（如关闭内容进程沙箱）绕过——属 §7 明确不做项，需单独批准。
   **2026-09-30 取证结果（Firefox 仍无法启动）**：4173 上的残留进程为**孤儿**（`PPID 1`、已存活 12h30m、
   `SIGTERM` 无效，需 `kill -9`），故那次定向重跑 0.6s 报 `already used` **未跑到浏览器**、不可作现场；
   `codesign -v --deep` 显示该构建 **ad-hoc 签名**（`Signature=adhoc`、`Sealed Resources=none`、
   `Nightly.app: code has no resources but signature indicates they must be present`）；
   `sw_vers` = macOS **27.0 / 26A428（预发布）**；`--force` 重装无效 ⇒ 判定为**该 Firefox 构建与本版 macOS
   的组合不兼容**，非仓库缺陷。**升级路径已现成**：上游 1.63.0 的 Firefox 为 156.0（firefox-1553），
   而仓库内已有 Dependabot **PR #8**（1.62.1 → 1.63.0）；但该升级会改 `pnpm-lock.yaml`（闭包内）⇒
   需重新锚定工具 SHA + 全量重跑验证，**须先批准**。备选收口：把 macOS 本地 Firefox 腿记为环境限制
   （与 D-188 对 Windows 的处置同构但**平台不同，不得合并**），稳定性权威证据仍为 CI（ubuntu 上 Firefox 腿真跑）。
   **2026-09-30 判定完成（对照探针，run `36739876157`）**：同一构建、同一 ad-hoc 签名，在 GitHub 的
   **macOS 26.6.2** runner 上 Firefox 153 **正常启动**（`PROBE_A=OK firefox 153.0`）、上游 1.63.0 的
   Firefox 155 亦正常（`PROBE_B=OK firefox 155.0`），而在用户的 **macOS 27.0 / 26A428 预发布版**上失败
   ⇒ **变量是操作系统版本**，非构建损坏、非签名缺失。**升级路径因此失去依据**（构建本身没问题）；
   `1.63.0` 的 Firefox 实测版本号亦更正为 **155.0**（第 323 行原写的 156.0/firefox-1553 取自上游 `main`
   分支未发布的 `browsers.json`，与已发布的 1.63.0 不符）。**建议收口口径（待你批准）**：把 macOS 本机 Firefox 腿
   记为本地环境限制，CI 仍为权威证据；待 macOS 27 转正式版或上游更新后再复核。
   **未获批准前不改任何结论记录。**
   **2026-09-30 收口完成（用户已批准，不新增决策条目）**：本项由 **open 转已收口**，落地口径如下——
   ① macOS 本机 `Firefox 核心冒烟` 记为**本地环境限制**（成因：macOS **27.0 / 26A428 预发布版**；
   同构建、同 ad-hoc 签名在 CI 的 macOS **26.6.2** runner 上正常启动，故非仓库缺陷、非构建缺陷）；
   ② 稳定性权威证据**仍为 CI**（ubuntu 的 `gate1` job 真跑 Firefox 腿，另有本轮 macOS runner 对照）；
   ③ 与 D-188 的 Windows 限制**平台不同、不得合并**，且**不改写 D-188 正文、不新增决策条目**；
   ④ **复核触发条件**：macOS 27 转正式版，或上游 Playwright / Firefox 构建更新；
   ⑤ **本机不再重复尝试**：不升级依赖（无依据）、不再跑最小判据与定向复跑、不使用关闭内容进程沙箱的启动开关。
   本机 macOS 的其余证据保持不变：完整 Gate 1 除 Firefox 腿外全部通过（详见 `docs/neon-vercel-baseline-runbook.md` §0.3）。
8. **（已修复并已验证，2026-10-02）`pg` 单 client 并发弃用告警**。S2 归因已在真实 `postgres:18.4` 上复核并修正：
   告警判定对象是**单个 `Client` 的 `_queryQueue`**，故 `query-service.ts:257` / `:1111` / `:1251` 三处并发
   `pool.query()` 与 `packages/db/src/index.ts:4` 的 `max: 2` **不是**告警源（`Pool.query` 每次取独占 client 后
   立即 release，结构上不可能触发）；真实触发源是 V1.1 单连接事务路径（`runDeterministicQuery` 的 `pool.connect()`
   分支）与发布物化路径（`materializeEvidenceSnapshots`）。**已落地**：新增模块私有 `serializeQueries`（**2026-10-04 更新**：该函数已并入唯一工厂 `createQueryTarget(source, concurrency)` 的 `"single"` 分支，不再作为独立函数存在，要点逐条迁入工厂注释、语义未变），**只在
   这两个单连接判定点注入**；V1.0 纯 Pool 分支与三处 `Promise.all` **刻意保持不变**（保留池级并发）；错误以同一
   对象抛出、不吞错；新增 6 个回归测试（`pnpm test` 15 文件 128 passed / 11 skipped / 139，基线 122 / 11 / 133）。
   **验证**：真实 `postgres:18.4` + `NODE_OPTIONS=--trace-deprecation` 的完整 `pnpm verify:gate1:isolated` 全程零告警，
   含 2026-09-27 告警真实出现的激活物化步骤；唯一失败仍是 §5.7 已收口的 `Firefox 核心冒烟` 本地环境限制，
   非本次回归。**边界未变**：`pg@9` 未发布（最新 `8.23.0`），D-183 闸门仍无可执行对象；闸门入口条件中的
   「不得在同一 client 上并发提交」回归防线已就位。落地记录见 `docs/pg-concurrency-deprecation.md` §8。
   **遗留（2026-10-04 更新：已实质闭合，仅余一层由行为测试兜底）**：类型层面区分「可并发的池」与「必须串行的
   单连接」**已闭合**——新增唯一工厂 `createQueryTarget(source, concurrency)` 与带**模块私有 `unique symbol` nominal
   brand** 的 `QueryTarget`，带 brand 的对象只能由该工厂构造，故裸 `Client`、`Pick<Client, "query">`、包装对象与
   **手写字面量 `{ db, concurrency }`** 在编译期均被拒绝（后者缺 `[queryTargetBrand]`）⇒ **无法伪造**一个「自称已
   串行化但实际未串行化」的并发目标；原文「该项须在 `pg@9` 升级动作前正式处置」随之失效。**残余边界（如实记录，
   不得宣称已闭合）**：类型系统只证明「对象出自本工厂」，**不证明 `concurrency` 实参传对了**——对单连接误传
   `concurrency: "pool"` 时类型仍然成立但不会串行化；该层由**既有行为测试（单连接在飞计数探测）兜底，不是类型系统
   解决的**。证据：三轮独立审查最终判 **PASS**（含 20+ 组仓库外副本变异实验）；`pnpm test` 15 文件
   **136 passed / 11 skipped / 147**（基线 122 / 11 / 133）；`query-service.ts` 覆盖率 **93.76 / 85.02 / 94.23 /
   94.13**（`pg` 修复前 93.68 / 84.94 / 94.23 / 94.06，三项均未下降）；`pnpm typecheck`（4 个 workspace）/
   `pnpm lint` / `pnpm format:check` / `pnpm build` 退出码 0；回归测试累计 8 个，且**既有 6 个串行化用例一行未改
   仍通过**（`git diff` 删除行数 0）⇒ 重构行为等价。**（2026-10-04 更新：上条「进行中、未验证」已作废，本轮端到端证据已取得）**
   本机 `pnpm verify:gate1:isolated`（真实 `postgres:18.4` + `--trace-deprecation`）走完全部 18 阶段、**全程零
   `DeprecationWarning` 零 `already executing a query`**，含激活物化步骤；6 条核心查询计划 `temp_written_blocks` 全 0；
   快照集成 28/28；Chromium 基础 10 passed / 22 skipped、历史证据 22/22；唯一失败仍是已收口的 `Firefox 核心冒烟`
   本地环境限制（`0ms` 签名逐字一致），运行后残留进程已清理。**CI 权威证据**：run **`37167407079`**（head = `6a9f72d8`）
   **全绿**，`Gate 1 deterministic validation`（ubuntu-latest）success 且 `Run isolated Gate 1 validation` 步骤 success
   ⇒ **Firefox 腿在 ubuntu 上真跑并通过**（本机跑不了该腿）；`Cross-platform checks` 三平台矩阵与 `CodeQL` 全部 success。
   上述 2026-10-02 / 2026-10-03 的验证与 CI 证据继续有效，但对应
   提交 `7e089efb` 的形态。完整记录见 `docs/pg-concurrency-deprecation.md` §8.2、§8.3、§8.6。
   **维护提示**：不要再去改那三处 `Promise.all`（既无收益，又会摧毁池级并发）。
   **权威证据（2026-10-03）**：改动已提交（`7e089efb` / `6c828dc9` / `94f1caf7`）并推送 `main`（`b3a62b4c..94f1caf7`）。
   CI run **`37088307553`**（head = `94f1caf7`）**全绿**：`Gate 1 deterministic validation`（ubuntu-latest，含完整
   `pnpm verify:gate1:isolated`，**Firefox 核心冒烟腿真跑并通过**——本机 macOS 27.0 跑不了该腿）3m55s success、
   `Cross-platform checks` 三平台矩阵 job 全部 success、`CodeQL` success、PR 依赖审查按设计 skipped。
   按 **D-188**，CI 为稳定性权威证据来源；上条本机记录与之**分别记录、不得合并**。

---

## 7. 明确不做（沿用既有授权边界）

- Neon 远程写（**除已执行的 E1 原子激活**）、Vercel 部署配置之外的其他远程写。
- **在未确认 `Staged` 标签之前合并 `main`**：E2c 已实测生效，推 main 只产生 Staged 部署；但仍须按
  §2.1 E2c 的两条可靠判据逐次确认，不得凭域名列表或专属 URL 判定（见 runbook §11.4 陷阱 1）。
- 强追本地「连续 5/5」（D-188 已把本地 Windows 记为已接受的环境限制）。
- 任何浏览器启动参数类改动。
- 放宽闸门一的任何数字、证据或页面验收标准。

---

## 8. 暂停条件（命中即停下提问，一次一个问题并给推荐答案）

1. E3 产生的是 `Current` 而非 `Staged` 部署（说明 E2c 未生效，须先查开关）。**判定只能用两条可靠判据**：
   生产域名本身服务的内容，或面板上的 `Staged` / `Current` 标签。**不得**用「详情页 Domains 列了生产域名」
   或「专属 URL 上的内容」判定——2026-09-27 已因此误判一次。
2. E1 激活后复验失败，且回切路径无法确认（回切路径见 runbook §12）。
3. 发布过程中出现「提交结果未知」——按 runbook §6，**只能记录为结果未知，不得宣称回滚**，
   须先用只读状态查询确认。
4. 需要放宽闸门一的任何数字、证据或页面验收标准。
5. 需要执行破坏性数据库操作（`main` 上禁止破坏性删改数据库对象）。

---

## 9. 参考

- 权威资料顺序：`AGENTS.md` → `CONTEXT.md` → `docs/development-roadmap.md` → `docs/decisions.md`
  → `docs/query-contract.md` → `docs/multi-agent-workflow.md`。
- 本窗口详细交接：`docs/handoff-2026-09-26.md`。
- 部署轨道全部细节：`docs/neon-vercel-baseline-runbook.md`（§1.1 冻结锚点、§5.1 环境变量分层、
  §7 部署前清单、§8 平台配额、§9 Neon 隔离性、§10 GitHub 安全治理与发布门、§11 部署现状与 E 段前置）。
