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
LOGIPLAN_NEON_ENDPOINT_ID=ep-empty-shape-b35qu1jv
```

数据库名和 endpoint ID 必须先通过 Neon 管理 API 只读核对，不从 branch
详情中的 `database_name` 推断。使用已认证的 Neon CLI API passthrough：

```powershell
$ErrorActionPreference = "Stop"
$projectId = "mute-mouse-49732061"
$branchId = "br-patient-smoke-b3f5jtui"

# GET /projects/{project_id}/branches/{branch_id}/databases
$databaseJson = & neonctl api "/projects/$projectId/branches/$branchId/databases" --output json
if ($LASTEXITCODE -ne 0) { throw "读取目标分支数据库列表失败" }
$databases = (($databaseJson | ConvertFrom-Json).databases | ForEach-Object { $_.name })

# GET /projects/{project_id}/endpoints；只保留目标分支的 read_write endpoint
$endpointJson = & neonctl api "/projects/$projectId/endpoints" --output json
if ($LASTEXITCODE -ne 0) { throw "读取项目 endpoint 列表失败" }
$endpoints = (($endpointJson | ConvertFrom-Json).endpoints |
  Where-Object { $_.branch_id -eq $branchId -and $_.type -eq "read_write" } |
  ForEach-Object {
    [pscustomobject]@{ endpoint_id = $_.id; branch_id = $_.branch_id }
  })

[pscustomobject]@{
  database_names = @($databases)
  read_write_endpoints = @($endpoints)
} | ConvertTo-Json -Depth 4
```

输出只能包含数据库名、endpoint ID 和 endpoint 的 `branch_id`。数据库选择规则：

- 无数据库：停止，不创建数据库；
- 一个数据库：使用该名称；
- 多个数据库：停止并人工明确选择一个名称，不猜测 `neondb` 或 `logiplan`；
- 无 `read_write` endpoint：停止，不创建 endpoint；
- 多个目标分支的 `read_write` endpoint：停止并报告差异，不选择或删除 endpoint。

确认数据库名称后，再将其显式传入只读预检：

```bash
pnpm neon:baseline -- \
  --candidate-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --approved-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --tooling-sha d3fc0b8e807db1771487e8c6b0175bb99d405764 \
  --expected-database neondb
```

上述只读核对已确认目标数据库为 `neondb`；仍不得从 branch 详情猜测
`database_name`，也不得在其他目标上猜测 `neondb`、`logiplan` 或其他默认名称。

目标项目 ID、分支 ID、数据库和 endpoint ID 无法仅靠 PostgreSQL 协议完整反查。
运行前必须通过上述只读管理 API 核对数据库列表，并从项目 endpoint 列表按
`branch_id` 和 `type=read_write` 筛选 endpoint；脚本随后把显式元数据、连接主机、
实际数据库、实际角色和服务器版本交叉校验。该限制会保留在报告中，不得把连接成功
当成项目身份的独立证明。

## 3. 隐藏凭据与写入准备

禁止把连接串或密码放在参数、命令历史、报告或聊天中。`--write` 只从进程环境读取：

- `NEON_ADMIN_DATABASE_URL`：目标数据库 owner 的直连连接，用于首次建立三角色；
- `NEON_SCHEMA_MIGRATOR_PASSWORD`：`schema_migrator` 的新建或现有密码；
- `NEON_DATA_PUBLISHER_PASSWORD`：`data_publisher` 的新建或现有密码；
- `NEON_APP_READER_PASSWORD`：`app_reader` 的新建或现有密码。

PowerShell 入口只隐藏读取一个已有的 owner 连接串和三个密码。Node 入口先验证
owner URL 的区域、直连 endpoint、SSL、`neondb_owner` 和数据库名，再在内存中构造：
`schema_migrator` 与 `data_publisher` 使用同一直接 endpoint，`app_reader` 使用同一
endpoint 的 `-pooler` 主机。角色名、数据库名和 endpoint 不从密码输入中读取，也不要求
手工构造角色连接串。密码仅在进程内用于缺失角色的原子创建和角色连接验证；已有角色
只做属性、成员关系、所有权和 ACL 核验，不改密码。

PowerShell 入口只在 `-Write` 时进行隐藏输入，并在结束后恢复进程原环境：

```powershell
./scripts/neon-baseline.ps1 `
  -CandidateSha 0229755a097dff94c8de67954b36ab4f9412c0f5 `
  -ApprovedSha 0229755a097dff94c8de67954b36ab4f9412c0f5 `
  -ToolingSha <已提交执行包 SHA> `
  -ApprovedToolingSha <独立批准执行包 SHA> `
  -ExpectedDatabase neondb `
  -Write `
  -Report neon-baseline-report-20260911.json
```

Bash/WSL 可用 `read -rsp` 分别读入上述一个 admin URL 和三个密码并 `export`，并把已提交执行包 SHA 与独立批准执行包 SHA 作为非秘密参数/环境值传入；随后执行：

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

默认预检不读取上述四个秘密、不建立数据库连接；只有 `--write` 才进行实时角色检测和初始化。
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
