# Neon 基线初始化与 Vercel 接入准备

版本：V1.0
日期：2026-09-11

## 0. 2026-09-21 验收状态与后续执行包

本轮（第二次返工轮次：P1/P2 最小修复）已在最终代码上取得新的实际结果。启用 `NEON_BASELINE_TEST_DOCKER=1` 与 `postgres:18.6` 时，`node --test scripts/neon-baseline.test.mjs scripts/neon-permission-audit.test.mjs` 为 46 passed、0 skipped（Neon baseline 36 + 权限 audit 10）；`pnpm test` 为 85 passed、11 skipped；`pnpm lint`、`pnpm typecheck`、`pnpm test:coverage`、`pnpm build` 退出码均为 0；`pnpm verify:gate1:isolated` 共执行 6 次（4 次退出码 0），每次退出码 0 的执行覆盖 PostgreSQL 18.4 迁移/V1/V2/发布幂等/显式激活/三角色权限/查询计划、生产构建、快照持久化证据 28/28、Chromium 双视口基础 10 passed 与 22 项设计性跳过、Chromium 双视口历史证据 22/22、Firefox 3/3、6 条查询计划 `temp_written_blocks` 全为 0，以及并发 5 的 100 次热查询（第 2 次 P50 23.083ms / P95 38.898ms / P99 42.123ms；第 3 次 P50 23.865ms / P95 42.099ms / P99 44.621ms；第 5 次 P50 23.165ms / P95 43.537ms / P99 47.975ms；第 6 次 P50 22.521ms / P95 40.066ms / P99 45.452ms）；临时容器、网络与卷已清理。axe serious/critical 断言位于 `gate1.spec.ts` 内，随上述 Chromium 与 Firefox 用例执行。

Gate 1 在本机多次执行结果不稳定，必须如实记录（共 6 次：4 次退出码 0，2 次浏览器启动环节异常）。第 1 次在子步骤“Chromium 双视口历史证据验收”以原生崩溃码 `3221226505`（`signal=null`，无任何用例输出）失败，整体退出码 1；第 2、3、5、6 次全流程退出码 0，历史证据子步骤均为 22/22；第 4 次挂起在子步骤“Chromium 双视口基础冒烟”——Playwright 与 `next start` 进程存活，但系统中无任何 Chromium 进程，`test-results/.playwright-artifacts-0` 自启动后约 30 秒起停止更新，等待超过 15 分钟无进展后人工终止该进程树并清理其隔离容器、卷与网络（该次不产生通过或失败结论）。第 5 次执行前完成环境净化（停止陈旧容器、清理测试产物、关闭浏览器进程，可用内存由 5.67 GB 升至 8.85 GB、提交量由 34.93 GB 降至 31.34 GB）后通过，第 6 次在补齐步骤超时后通过；两次异常均无用例断言失败，同一批用例在其余执行中通过，异常时段 Windows 事件日志亦无 `Application Error` / WER 记录，因此判定为环境不稳定而非项目代码缺陷，且根因未定位。在消除该不稳定之前，Gate 1 不得记为稳定通过，复验必须记录执行次数与每次结果。

2026-09-21 经用户授权对 Gate 1 编排做了一处最小改动：此前编排对 Playwright 等步骤未设置 `timeoutMs`，第 4 次的无限挂起即由此产生。现为隔离 PostgreSQL 启动、Neon 基线回归、快照集成测试、生产构建、Chromium 双视口基础冒烟、Chromium 双视口历史证据验收、Firefox 核心冒烟和并发性能验证补上 `timeoutMs`（240–420 秒，约为实测耗时的 6–10 倍）；该次改动只新增超时参数，未改动该脚本的断言、步骤顺序或环境变量。覆盖范围必须限定：迁移、发布、激活、结构校验、权限审计回归等其余步骤仍没有 `timeoutMs`，它们发生挂起仍会无限等待；只有已覆盖的上述 8 个步骤会在挂起时沿编排既有的 SIGTERM → SIGKILL → 失败路径转为一条有记录的超时失败。

独立复查：2026-09-21 由独立只读子代理（全新上下文、无写入权限，与被审查者同一模型家族，非原冻结安排中的 Sol High）执行，判定 PASS，无 P0/P1，列出 6 项 P2。据此修复了其中 2 项代码问题：`runCli` 中的 `parseArguments` 移入 `try`，恢复“Neon 基线执行失败：… ”脱敏输出与退出码 1，不再向用户输出原始堆栈；`runProcess` 的 `error` 事件改为走 `isUnknownWriteProcessExit`，与“单一纯函数统一判定”的表述一致（行为等价）。另新增 1 项参数错误回归测试。其余 4 项为文档精度问题，已按本节收窄描述。复查者明确标注的未验证项：ps1 → 真实 Node 入口的 75 组合链路、真实 signal 退出、Docker `postgres:18.6` 的 46 passed 结果、Gate 1 的 6 次执行结果、全部远程结论（均因需连库或耗时未复现）；复查者已自行复现 `pnpm test` 13 文件 85 passed / 11 skipped、`pnpm lint`、`pnpm typecheck`、定向 prettier 与 baseline 定向测试。

本轮修复的两个问题及实际原因：P1 为 Node 入口最外层 `catch` 固定写 `process.exitCode = 1`，PowerShell 入口又用 `throw "…退出码为 $LASTEXITCODE"` 覆盖原始退出码，写入结果未知无法以 75 传播；现由 `exitCodeForBaselineError` 与可注入的 `runCli` 统一映射退出码，PowerShell 入口保存并原样 `exit` Node 的退出码，并在 `finally` 中恢复凭据环境变量与其偏好设置。P2 为 `runProcess` 仅按退出码 75 认定未知写入结果，137 等异常退出码、信号终止、已启动写入子进程的超时，以及子进程启动后的异常 `error` 事件都会落入 known_failed；现由单一纯函数 `isUnknownWriteProcessExit` 统一判定，错误对象保留 `childExitCode` 与 `childSignal` 诊断字段。两处修复均先建立红灯测试再实现，未知写入结果不自动重试、不标记候选 `FAILED`。

执行者说明：用户在本轮明确取消原先冻结的“Luna High 实现 + Sol High 独立复查”角色安排，改由单一会话模型（DeepSeek V4.1 Flash）完成本文件所述的实现与验证，随后由独立只读子代理完成复查（判定 PASS，问题与修复见下段）。该安排覆盖角色与模型名称，独立复查这一要求本身并未取消。本轮状态为“本地实现、验证与独立复查均已完成，复查无 P0/P1”；这不等于基线验收签署，远程准备仍受 tooling SHA 与单独授权约束。

裸执行两个 Node 测试文件 41 项（40 passed、1 项 Docker 条件 skip）、历次 PostgreSQL 18.6 定向验证 41/41，以及历史 Gate 1 退出码 0（Neon baseline 31/31、权限 audit 10/10、本地 API 5/5、快照持久化 28/28、Chromium 历史证据 22/22、Firefox 3/3，P95 43.954ms）全部保留为历史证据，不再是本轮最新结果。普通 Chromium 基础命令中 22 项历史用例按设计跳过，随后由历史证据专项完整执行。

2026-09-20 的局部历史记录为 audit 9/9、相关五文件格式检查通过及独立复查 PASS，仅覆盖当时的 audit 改造，不代表完整本地基线、远程 Neon 基线或本轮最新 Gate 1。候选 SHA 固定为 `0229755a097dff94c8de67954b36ab4f9412c0f5`，新的 tooling SHA 尚未生成，不得用候选 SHA 或任意占位值冒充 tooling SHA。audit 只输出脱敏 JSON、拒绝 `--report` 且不保存文件；正式 `neon-baseline --report` 保留。H1 仅是本地 PostgreSQL 机制证据，不是 Neon 根因确认；当前未连接 Neon、未激活远程发布、未部署或推送。

本轮全仓 `pnpm format:check` 仍为退出码 1，失败文件固定为 `AGENTS.md` 与根目录 7 份 `neon-baseline-report-*.json` 共 8 个用户资产；本轮只对改动文件做定向格式检查，未执行全仓 `prettier --write`。注意 `.workbuddy/memory/*.md` 也在全仓检查范围内，新增未格式化记忆文件会把失败数从 8 变 9。本机环境补充事实：`node` 必须显式使用 24.15.0（`C:\nvm4w\nodejs\node.exe`），PATH 默认的 22.22.2 不满足 `engines.node`；`pnpm exec <bin>` 在当前 shell 下无法解析到本地二进制，需改用 `pnpm <script>` 或 `node_modules/.bin/<bin>.cmd`；`prettier --check` 显式指定 `.ps1` 会因无解析器报错（退出码 2），需加 `--ignore-unknown`。

本地数据库入口的未知提交结果使用结构化退出码 75 传播。baseline 把写入子进程的异常终止统一判定为写入结果未知：退出码 75、任何非 0/1 的异常退出码、非空 `signal`、超时，以及子进程已启动后无法解释的 `error` 事件；判定只依据进程状态，不通过 stderr 文本或失败候选状态推断已回滚。Node 入口按“成功 0 / 已知失败 1 / 写入结果未知 75”返回，PowerShell 入口原样透传 Node 的退出码，不再改写为 1；参数与环境校验错误属于已知失败，以退出码 1 结束并输出脱敏单行信息。未知结果只做只读复核，不自动重试、不标记候选 `FAILED`；正常错误只有在 ROLLBACK 得到确认后才允许进入 known_failed；发布入口在未知提交结果时不执行 `mark_data_release_failed`。

`verify-schema` 含事务内写入权限探针，因此按写入敏感子进程处理：它被信号或异常退出码终止时同样判为写入结果未知，这不属于“只读子进程不受影响”的例外说明——该例外只适用于 git 与本地预检等真正的只读子进程。本节契约覆盖 baseline 入口；`packages/db/src/activate-release.ts` 与 `scripts/publish-gate1-v1-baseline.ts` 的 CLI 包装仍固定以退出码 1 结束，二者的底层事务模块已具备 `writeOutcomeUnknown` 语义，但包装层未传播 75。激活被远程执行包显式排除，`publish-gate1-v1-baseline.ts` 只用于本地 Gate 1 夹具，因此二者不影响本轮远程准备；如需把它们纳入统一契约，应作为单独的最小改动处理。

远程执行包在 tooling SHA 生成并独立批准前不可执行。固定目标为 `logiplan-public-test` / `mute-mouse-49732061`、`aws-ap-southeast-1`、PostgreSQL `18.6`、`main` / `br-patient-smoke-b3f5jtui`；准备顺序为：只读目标/身份/迁移/V2/活动发布预检 → 一次 `neon-baseline.ps1 -Write -Report <新报告路径>` 的 `validate-only` prepare → 仅在首次成功且获明确授权时使用新报告路径重复同一入口作幂等复验。前置批准必须同时覆盖精确 candidate SHA、已提交且独立批准的 tooling SHA、目标项目/分支/数据库、一次 prepare、一次幂等复验和只读状态核查；不包括激活、部署、密码变更或额外 GRANT/REVOKE。任何目标漂移、成员/ACL/校验和差异、V2 为 FAILED、状态未知、首个写入失败或提交确认丢失均立即停止；未知结果只做只读复核，不声称 rollback/success。本轮未生成 tooling SHA、未提交或暂存、未连接 Neon、未部署 Vercel，也未准备远程执行包；本轮本地修复在独立复查通过前不构成远程执行的前置条件。

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
  --tooling-sha "$LOGIPLAN_TOOLING_SHA" \
  --expected-database neondb
```

该命令仅在 `$LOGIPLAN_TOOLING_SHA` 已由实际提交生成且通过独立批准后执行；缺少真实 SHA 时停止。

上述只读核对已确认目标数据库为 `neondb`；仍不得从 branch 详情猜测
`database_name`，也不得在其他目标上猜测 `neondb`、`logiplan` 或其他默认名称。

目标项目 ID、分支 ID、数据库和 endpoint ID 无法仅靠 PostgreSQL 协议完整反查。
运行前必须通过上述只读管理 API 核对数据库列表，并从项目 endpoint 列表按
`branch_id` 和 `type=read_write` 筛选 endpoint；脚本随后把显式元数据、连接主机、
实际数据库、实际角色和服务器版本交叉校验。该限制会保留在报告中，不得把连接成功
当成项目身份的独立证明。

## 2.1 权限失败的独立只读诊断

权限校验失败时，先使用独立诊断入口收集脱敏事实，不要用 `--write` 入口“试运行”或
通过授予额外权限追求通过。入口只读取管理连接环境变量 `NEON_ADMIN_DATABASE_URL`，
要求目标元数据环境变量已经按上节管理 API 结果核对，并把数据库名显式传入：

```bash
pnpm neon:permission-audit -- \
  --expected-database <已核对的实际数据库名>
```

入口在连接后执行 `BEGIN READ ONLY`、短 `statement_timeout` 和最终 `ROLLBACK`，并严格比较
实连的 `current_user`、`session_user`、`current_database()` 与管理连接/显式数据库参数，
以及固定 PostgreSQL `18.6` 的 `server_version_num=180006`；URL 或环境元数据校验不能替代
这些实连事实。入口只读取当前身份、PostgreSQL 版本、`createrole_self_grant`、三角色属性
摘要、数据库/schema 权限、`pg_auth_members` 的完整相关关系以及迁移、V2 和活动发布对象状态，
并在对应对象存在后读取已应用迁移的版本/`checksum_sha256` 摘要与 V2
`data_release.input_checksum_sha256`。
对象或目标记录缺失记录为未知，不引用不存在的表。它不执行
`CREATE`、`GRANT`、`REVOKE`、`ALTER`、`SET ROLE`、迁移、发布或权限探针，不读取
`pg_authid.rolpassword`、业务明细、完整角色配置或完整连接串。成功时仅向 stdout
输出一个脱敏 JSON 对象和换行，不创建文件或目录；失败时仅向 stderr 输出脱敏错误并返回非零退出码。

`pg_auth_members` 的方向固定为“parent 是被授予的角色，member 是获得成员资格的一方”。
三角色作为 `member` 的任何关系均拒绝；H1 标准关系仅允许三角色作为 `parent`、当前已
验证管理身份作为 `member`，且 `admin_option=true`、`inherit_option=false`、
`set_option=false`、`grantor_oid=10` 并由 `rolsuper=true` 的授予者产生。缺失字段、
类型错误、重复/额外授予者和其他 member 均拒绝。该规则承认 PostgreSQL 18
`CREATEROLE` 的标准管理边，不等于授予业务角色继承管理权限；`assertRoleDefinitions`
和完整 `assertRolePrivilegeBaseline` 仍必须执行。

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
$toolingSha = $env:LOGIPLAN_TOOLING_SHA
$approvedToolingSha = $env:LOGIPLAN_APPROVED_TOOLING_SHA
if ($toolingSha -notmatch '^[0-9a-f]{40}$' -or $approvedToolingSha -notmatch '^[0-9a-f]{40}$') {
  throw "必须先提供已生成且已批准的真实 tooling SHA；当前不可执行远程 prepare"
}

./scripts/neon-baseline.ps1 `
  -CandidateSha 0229755a097dff94c8de67954b36ab4f9412c0f5 `
  -ApprovedSha 0229755a097dff94c8de67954b36ab4f9412c0f5 `
  -ToolingSha $toolingSha `
  -ApprovedToolingSha $approvedToolingSha `
  -ExpectedDatabase neondb `
  -Write `
  -Report neon-baseline-report-20260911.json
```

执行前必须确认两个环境变量均为已生成且已独立批准的真实 40 位小写 SHA；为空、格式不符或两者不一致时停止，不得执行。

Bash/WSL 可用 `read -rsp` 分别读入上述一个 admin URL 和三个密码并 `export`，并把已提交执行包 SHA 与独立批准执行包 SHA 作为非秘密参数/环境值传入；随后执行：

```bash
[[ "$LOGIPLAN_TOOLING_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$LOGIPLAN_APPROVED_TOOLING_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
pnpm neon:baseline -- \
  --candidate-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --approved-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --tooling-sha "$LOGIPLAN_TOOLING_SHA" \
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
