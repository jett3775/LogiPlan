# Neon 基线初始化与 Vercel 接入准备

版本：V1.0
日期：2026-09-11

## 1. 固定目标与边界

本入口只准备以下冻结目标，不创建 Neon/Vercel/GitHub 资源，也不部署应用：

- 候选：`codex/gate1-delivery-baseline`，提交 `0229755a097dff94c8de67954b36ab4f9412c0f5`；
- Neon：`logiplan-public-test` / `mute-mouse-49732061`，`aws-ap-southeast-1`，PostgreSQL `18.6`，`main` / `br-patient-smoke-b3f5jtui`；
- Vercel：团队 `logi-plan`，项目 `logi-plan-web`，Root Directory `apps/web`，Next.js，Node.js 24.x，`sin1`；
- 生产运行时只允许 `app_reader` 的池化 `DATABASE_URL`。Preview 不得获得公开测试数据库连接；应使用 PR 独立分支，无法提供时失败关闭。

`apps/web/vercel.json` 只把 Function 区域固定为 `sin1`。它不创建项目、不修改 Vercel 设置、不注入环境变量，也不构成部署。

## 2. 默认预检

入口必须同时收到候选 SHA 和独立批准 SHA，不以当前 `HEAD` 代替批准。预检模式要求当前分支和 `HEAD` 精确等于冻结候选 commit；写入模式要求当前 `HEAD` 精确等于已批准的工具 SHA，并额外确认候选迁移、数据包和完整执行闭包未偏离各自批准 SHA。

先在当前终端设置以下非秘密目标元数据：

```text
LOGIPLAN_NEON_PROJECT_NAME=logiplan-public-test
LOGIPLAN_NEON_PROJECT_ID=mute-mouse-49732061
LOGIPLAN_NEON_REGION=aws-ap-southeast-1
LOGIPLAN_NEON_BRANCH_NAME=main
LOGIPLAN_NEON_BRANCH_ID=br-patient-smoke-b3f5jtui
LOGIPLAN_NEON_POSTGRES_VERSION=18.6
LOGIPLAN_NEON_ENDPOINT_ID=<Neon 连接主机中的 ep-... 段>
```

执行只读预检：

```bash
pnpm neon:baseline -- \
  --candidate-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --approved-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --expected-database logiplan
```

数据库名未在 Neon 项目元数据中冻结；示例 `logiplan` 只有在 Neon 中已创建同名数据库时才可使用。必须以实际目标库名显式替换，不允许脚本猜测 `neondb` 或其他默认名称。

目标项目 ID、分支 ID 和区域无法仅靠 PostgreSQL 协议从服务器反查。运行前必须在 Neon Console 或只读管理 API 中核对这些元数据及 endpoint ID；脚本随后把显式元数据、连接主机、实际数据库、实际角色和服务器版本交叉校验。该限制会保留在报告中，不得把连接成功当成项目身份的独立证明。

## 3. 隐藏凭据与写入准备

禁止把连接串放在参数、命令历史、报告或聊天中。`--write` 只从进程环境读取：

- `NEON_ADMIN_DATABASE_URL`：目标数据库 owner 的直连连接，用于首次建立三角色；
- `MIGRATION_DATABASE_URL`：`schema_migrator` 直连；
- `PUBLISHER_DATABASE_URL`：`data_publisher` 直连；
- `DATABASE_URL`：`app_reader` 的 `-pooler` 池化连接。

四个 URL 必须启用 `sslmode=require` 或 `sslmode=verify-full`。管理、迁移和发布 URL 必须指向同一直接 endpoint；运行 URL 必须是同一 endpoint 的 `-pooler` 形式。脚本仅在角色缺失时使用相应 URL 中的密码创建角色；已有角色只做属性、成员关系、所有权和 ACL 核验，不改密码，也不另存密码。

PowerShell 入口会对缺失连接串使用隐藏输入，并在结束后恢复进程原环境：

```powershell
./scripts/neon-baseline.ps1 `
  -CandidateSha 0229755a097dff94c8de67954b36ab4f9412c0f5 `
  -ApprovedSha 0229755a097dff94c8de67954b36ab4f9412c0f5 `
  -ToolingSha <已提交执行包 SHA> `
  -ApprovedToolingSha <独立批准执行包 SHA> `
  -ExpectedDatabase logiplan `
  -Write `
  -Report neon-baseline-report-20260911.json
```

Bash/WSL 可用 `read -rsp` 分别读入上述四个变量并 `export`，并把已提交执行包 SHA 与独立批准执行包 SHA 作为非秘密参数/环境值传入；随后执行：

```bash
export LOGIPLAN_APPROVED_TOOLING_SHA=<独立批准执行包 SHA>
pnpm neon:baseline -- \
  --candidate-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --approved-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --tooling-sha <已提交执行包 SHA> \
  --expected-database <已核对的实际数据库名> \
  --write \
  --report neon-baseline-report-YYYYMMDD.json
```

不要写入 `.env`、shell profile 或仓库文件。报告路径必须是不存在的新文件；入口以 `0600` 创建，拒绝覆盖。

连接建立最多重试三次，仅覆盖尚未开始写入的连接故障。`--write` 使用管理直连持有覆盖角色、迁移、发布和权限验收全流程的 advisory lock；无法取得锁时立即拒绝并发任务。迁移或发布命令不自动重试，避免把未知提交结果误报为已回滚。

## 4. `--write` 的持久影响

固定顺序与影响如下：

| 阶段                                                 | 持久写入                                                                                                                                                                                | 活动发布切换 | 测试残留       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------- |
| 角色初始化                                           | 三角色全部缺失时原子创建，并只在创建时设置密码；已有角色只核验属性、成员关系、所有权与 ACL，不改密码；授予明确的数据库连接与 migrator 建模权限；撤销 `PUBLIC` 的 public schema 建模权限 | 否           | 无             |
| `db:migrate`                                         | 仅执行未应用的前向迁移；写入 `public._schema_migrations`；已执行 SQL 校验和变化时失败                                                                                                   | 否           | 无             |
| `db:publish` + `LOGIPLAN_PUBLISH_MODE=validate-only` | 创建 V2 候选、导入业务行、执行完整校验并进入 `VALIDATED`；失败候选进入 `FAILED`                                                                                                         | **否**       | 无             |
| `db:verify`                                          | 验证结构、精度、三角色及受控证据函数；权限探针位于事务中并回滚                                                                                                                          | 否           | 无持久测试发布 |

入口不运行 `db:verify-plans`，因为候选尚未激活；也不运行远程页面测试。成功报告的 `active_release_switch` 必须为 `false`。

现有 `db:publish` 默认行为仍是校验并激活；只有显式 `LOGIPLAN_PUBLISH_MODE=validate-only` 才停在 `VALIDATED`。不要在普通终端遗留该变量。

## 5. Vercel 接入与后续激活

在 Vercel 中人工核对 Team、Project、Root Directory、Framework、Node.js 和 Function Region。Production 只配置池化 `DATABASE_URL`；不得配置 admin、migrator、publisher 或 Neon 管理凭据。Preview 不配置 Production 的 `DATABASE_URL`。

准备阶段不激活数据。完成真实部署并取得部署标识后，按照 D-154 对具体 SHA 单独批准，再由受控发布流程执行：

1. 确认部署使用批准 SHA，且 `/api/health/live` 正常；已有旧活动发布时再确认 `/api/health/ready` 正常。
2. 显式运行 `pnpm db:activate-release -- LOGIPLAN_2026_DEMO_V2`。该命令会切换活动发布，是数据库写入，不能作为本准备入口的隐式后续动作。
3. 激活后运行 `pnpm db:verify-plans`、`/api/health/ready`、核心 9 题、页面冒烟与性能验收。
4. 激活后复验失败时，按 D-155 回切到已验证旧发布和兼容的旧应用；首次无旧发布的初始化必须停止公开流量并修复，不能伪造可回切版本。

`pnpm db:verify-release` 验证仓库固定的 V1→V2 升级与事务回切，要求数据库中同时存在 V1 和 V2。它由本地隔离 Gate 1 流程覆盖，不适用于只装载 V2 的首次远程基线。

## 6. 重复执行与恢复

- 角色、迁移和已校验候选均支持重复入口检查；已执行迁移必须保持原校验和。
- 角色阶段完成、迁移失败：修正连接或兼容问题后重新运行同一入口；已成功迁移会按校验和跳过。
- 迁移完成、发布连接中断：先查询 V2 状态。`CANDIDATE` 可由同一入口继续；`VALIDATED` 会重新执行候选校验而不重复写入；`ACTIVE` 会重新校验并保持活动版本，`RETIRED` 只校验且不切换状态；`FAILED` 必须修正数据并创建新的版本化发布包，不能复用 V2。
- 发布完成、权限验证失败：不得激活。先修正新增迁移或权限，再从入口重复执行。
- 连接或命令提交结果不明确：报告只能记录“结果未知”，不得宣称回滚；通过只读状态查询确认后再决定重试。

本地 `pnpm verify:gate1:isolated` 仍是必需的隔离验收。公开 Neon 不是隔离测试环境，Neon PostgreSQL 18.6 的结果也不能替代本地 PostgreSQL 18.4 的回归；两者同属 PostgreSQL 18，但必须共同验证 `btree_gist` 可用、无 Neon 专有 API/扩展依赖以及迁移、发布、权限、查询和性能一致性。
