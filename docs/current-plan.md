# LogiPlan 当前工作计划（滚动文档）

> **本文件是滚动文档**：每轮**覆盖更新**，只反映**当前**要做的计划，**不累积历史**。
> 历史脉络见 `docs/handoff-*.md` 与 `docs/development-roadmap.md` §0。
>
> **与 `AGENTS.md` 的偏差（已由用户明确指示）**：`AGENTS.md` 要求「不在仓库中保存逐次聊天记录或临时工作日志」。
> 用户于 2026-09-25 明确选择把计划类文档以**单一滚动文档**的形式入库（形式「乙」），取代此前散落在
> `%TEMP%` 的周计划与日计划。**`%TEMP%` 中的周计划与日计划自本文件起不再单独维护。**
> 如需恢复原约定，删除本文件即可。

最后更新：2026-09-27（面向 09-27 之后的窗口）

---

## 1. 当前状态（已核实）

- **阶段**：第三阶段「第一闸门」。**代码侧验收全部通过**；稳定性权威证据为 CI（见 D-188）。
- **main**：现为 **`136a2d6`**（2026-09-27：先由 `a63a43c` 快进到 `16b1df8`，再在其上追加一个纯文档提交）。
  PR `jett3775/LogiPlan#1` 已被 GitHub 自动标记 **MERGED**。两个 SHA 在 `main` 上均有 CI **success** 记录
  （`16b1df8` 3m57s、`136a2d6` 4m6s，均含 isolated Gate 1 validation）。工作分支 `codex/gate1-delivery-baseline` 与 main 同步。
- **已完成**：第一窗口 **T1—T8** 全部有结论；第二窗口第一段（只读准备）**P1—P6 全部完成**；
  **E2a / E2b / E2c、E3、E1 已完成**（详见 runbook §11.4）。
- **远端部署**：生产域名 `logi-plan-web.vercel.app` 当前服务 **`136a2d6`**（E3b 已 Promote；该 SHA 的应用产物与
  `16b1df8` 相同）。E2c 已实测生效：推送到 `main` 只产生 **`Staged`** 部署，须人工 Promote 才对外服务（见 D-189）。
- **数据侧**：`LOGIPLAN_2026_DEMO_V2` 已激活（`status = ACTIVE`，`activated_at = 2026-09-27T15:57:08Z`），
  固定证据 9 条已物化；`db:verify-plans` 通过（6 条计划 `temp_written_blocks` 全 0）。
- **E 段已收口（2026-09-27）**：**E3b 已 Promote**（`136a2d6` → `Current`，生产域名已切到新构建）；
  **E4 四项由用户在生产域名上复验通过**（`/api/health/ready` = `ready`；首页为「预算执行驾驶舱」且九块均有数字与证据侧栏；
  核心 9 题页面结果正常；热请求 P95 达标）。E5 见 runbook §12。
  说明：站点四项由用户在其本机浏览器/终端执行（沙箱到 `vercel.app` 的 TLS 被阻断）；P95 的具体数值未记录。

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

## 3. 暂缓项（用户 2026-09-25 指示「先不推进」）

| 项                       | 说明                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1 闸门二只读设计**    | ✅ **已完成（2026-09-28）**：产出 `docs/gate2-design.md`——`ModelGateway` 供应商中立边界与适配器契约、D-180 适配器参数、匿名限流与两级熔断、不可变证据快照与三检、20 题评估集与重跑触发条件、角色路由、失败关闭矩阵、验收矩阵、D-182 排除项自查。**未写生产代码**，未引入 D-182 排除项                                             |
| **S2 `pg` 并发告警归因** | ✅ **已完成（2026-09-28）**：结论见 `docs/pg-concurrency-deprecation.md`——触发条件已源码级确认（同一 `Client` 上并发提交查询），触发点为 `query-service.ts:257/1111/1251` 经 Web 的 `pool.connect()` 分支与三个 CLI 脚本；判定**需先修但不阻塞当前计划**（`pg` 尚无 9.x）。真实库端到端复现未完成（沙箱无 PG/Docker），已如实记录 |

> **2026-09-27 实测补充**：该并发告警在 E1 激活时**真实出现**（`activate-release` 运行日志中的
> `DeprecationWarning: Calling client.query() when the client is already executing a query`），
> 因此 S2 不再是纯理论问题，其触发面覆盖到发布/激活入口。
> **已于 2026-09-28 归因收口**：触发条件是**同一 `Client` 上并发提交查询**（源码 predicate + 静态路径 + 该日志三方一致），
> 结论与处置建议见 `docs/pg-concurrency-deprecation.md`。

---

## 4. 已定决策（无需再回答）

- **D-189**：发布门采用 **Vercel 原生 staged production**，不再自建 GitHub Actions 工作流。✓
- **计划类文档以单一滚动文档入库**（形式乙）→ **本文件**。✓

---

## 5. 仍待你决策 / 待授权

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
5. **（已收口）Dependabot 失败运行排查**：`npm_and_yarn in /. - Update #1593405539`（2026-09-27T15:36:30Z，failure）
   根因已定位——Dependabot 升级 `react-dom` 到 `19.3.0` 时，因 `.npmrc` 的 `strict-peer-dependencies=true`
   报 `ERR_PNPM_PEER_DEP_ISSUES`（`react` 仍 19.2.8、`@types/react` 仍 19.2.18），属**预期摩擦而非故障**。
   建议在 `dependabot.yml` 用 `groups` 把 react 家族编组；**不得**放宽 `strict-peer-dependencies`。
   另附当前 10 个开放 Dependabot PR 的分类（4 个改工作流 action SHA、4 个触碰冻结依赖组合、1 个常规补丁），
   结论是**一个都不应顺手合并**。详见 `docs/neon-vercel-baseline-runbook.md` §10.1.1—§10.1.2。
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
   剩余可选：完整 Gate 1（`pnpm verify:gate1:isolated`，需 Docker Desktop）——跑通后可提请把
   D-188 的「本地环境」一栏由「已接受的环境限制」改写为「本地基线通过」（**改写冻结决策需单独批准**）。
7. **（open）macOS 上 `Firefox 核心冒烟` 挂起（2026-09-30，首台 macOS 机器实测）**。同日 macOS 首次完整 Gate 1
   已推进至浏览器阶段，此前全部阶段通过（数据库集成四条腿、迁移/发布/激活/校验、生产构建、快照 `28/28`、
   Chromium 双视口基础 `10 passed / 22 skipped`、Chromium 历史证据 `22/22`）；**唯一失败**是 Firefox 冒烟：
   首条用例 `0ms` 失败且无用例输出，随后 Playwright 挂起，被步骤超时 `240s` 终止（`timedOut` 分支），
   Playwright 的失败详情未及打印（编排 `stdio: inherit`，无缓冲可补）。
   已排除：权限位问题（同日已修复）、Docker/镜像、`.env` 缺失。**待取证判据**：① Playwright Firefox 能否
   单独启动（`firefox.launch()` 最小判据）；② `~/Library/Logs/DiagnosticReports` 是否有 Firefox 崩溃报告；
   ③ 4173/4174 是否有泄漏监听进程。该问题**与 Windows 的 `3221226505` 签名不同**（挂起 vs 原生崩溃），
   不得合并；Windows 项仍按 §5.3 挂起。

---

## 6. 明确不做（沿用既有授权边界）

- Neon 远程写（**除已执行的 E1 原子激活**）、Vercel 部署配置之外的其他远程写。
- **在未确认 `Staged` 标签之前合并 `main`**：E2c 已实测生效，推 main 只产生 Staged 部署；但仍须按
  §2.1 E2c 的两条可靠判据逐次确认，不得凭域名列表或专属 URL 判定（见 runbook §11.4 陷阱 1）。
- 强追本地「连续 5/5」（D-188 已把本地 Windows 记为已接受的环境限制）。
- 任何浏览器启动参数类改动。
- 放宽闸门一的任何数字、证据或页面验收标准。

---

## 7. 暂停条件（命中即停下提问，一次一个问题并给推荐答案）

1. E3 产生的是 `Current` 而非 `Staged` 部署（说明 E2c 未生效，须先查开关）。**判定只能用两条可靠判据**：
   生产域名本身服务的内容，或面板上的 `Staged` / `Current` 标签。**不得**用「详情页 Domains 列了生产域名」
   或「专属 URL 上的内容」判定——2026-09-27 已因此误判一次。
2. E1 激活后复验失败，且回切路径无法确认（回切路径见 runbook §12）。
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
