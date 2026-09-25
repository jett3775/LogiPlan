# Neon 基线初始化与 Vercel 接入准备

版本：V1.0
日期：2026-09-11

## 0. 2026-09-22 验收状态与后续执行包

2026-09-22 轮次（第三次修复轮次：交接文件 7 项阻滞中的 1—5 项代码修复，外加 ACL 断言口径修正与 PowerShell 入口编码修正）已在最终代码上完成本地实现、真实 PostgreSQL 回归与独立审查。本轮未再次连接 Neon、未推送、未激活远程发布、未部署 Vercel。本轮修复已提交为 `245dc3017d2d5009844f7f4a35d07cab18bd0dba`（父提交 `06cccf2d855ff8355f0bbd73b61ee1f984bfc329`，14 个文件，加 619 行、减 130 行），分支相对 origin 领先 7。写模式前置检查已通过：HEAD 精确匹配该提交、执行闭包 25 条路径无未提交改动、冻结候选资产 `0229755a097dff94c8de67954b36ab4f9412c0f5` 无改动、工作区仅剩 11 项约定排除资产（修改的 `AGENTS.md`、异常 tracked 文件删除、`e HEAD`、8 份根目录历史报告、`.workbuddy/`）。工具 SHA 最终取 `e03d192ed023699e38df6bc8c12d8ca5cc54892d` 并经用户独立批准；远程执行结果见本节下方。

本轮实际修复（七项）：

1. **`acldefault` 类型错误**（`scripts/neon-baseline.mjs`）：原写法 `acldefault(CASE WHEN object.relkind = 'S' THEN 'S' ELSE 'r' END, object.relowner)` 改为 `acldefault((CASE WHEN object.relkind = 'S' THEN 's' ELSE 'r' END)::"char", object.relowner)`。根因：`CASE` 两个分支都是 unknown 字面量，结果类型被解析为 `text`，而 `pg_catalog` 只有 `acldefault("char", oid)`，`text` 无隐式转换。真实现象：在 PostgreSQL 18.4 与 18.6 上原写法报 `function acldefault(text, oid) does not exist`（SQLSTATE 42883），与 2026-09-21 远程 `-Write` 的失败信息逐字一致。同时把四段 ACL 查询提取为导出函数 `queryPrivilegeAclRows(admin)`、导出 `assertRolePrivilegeBaseline`，使真实数据库测试直接执行生产路径而不是复制实现。
2. **ACL 断言口径修正**（同一文件）：原逻辑以 `relkind !== "S"` 作为「预期 data_publisher INSERT」的判据，既没有排除视图（PostgreSQL 视图不可授予 INSERT），也没有覆盖 `0001_gate1_schema.sql:1317-1320` 对 `data_release`、`active_data_release` 的显式 `REVOKE INSERT`（这两张表的写入按设计走 SECURITY DEFINER 函数）。现改为「只有 `relkind` 为 `r` 或 `p` 的关系才预期 INSERT」，并新增 `publisherReadOnlyRelations = {data_release, active_data_release}`。真实授权事实（一次性容器内跑完 0001—0010 后全量导出）：`data_release`、`active_data_release` 仅 `data_publisher SELECT`；14 个 `active_*` 视图为 `app_reader SELECT` + `data_publisher SELECT`；`active_release`、`active_business_event_note`、`evidence_snapshot` 仅 `app_reader SELECT`；其余普通表为 `data_publisher SELECT` + `INSERT`；函数 EXECUTE 与 `schema_migrator` 默认 ACL 与断言一致。该断言路径此前从未在任何环境真实执行，属零覆盖缺陷。
3. **事务失败分类保守化**（`packages/db/src/migrate.ts`、`packages/db/src/publish-release.ts`）：`isConfirmedCommitFailure` 由「任意 5 位码、仅排除 `08xxx` 与 `57014`」的黑名单改为白名单——只有 `25xxx` 前缀与 `2D000` 才视为「事务已终止且不可能提交」，`40003`（statement completion unknown）、`53100`、`08xxx`、`57014` 以及任何未枚举码一律判为写入结果未知。改前红灯证据：`40003`、`53100` 在 COMMIT 阶段被判为 `rollbackConfirmed: true`，即已提交写入会被误报为确定失败。
4. **事务外自动提交写入收进事务 helper**（同一两个文件）：`migrate.ts` 新增导出 `ensureMigrationTable(client)` 承载 `CREATE TABLE IF NOT EXISTS public._schema_migrations`；`publish-release.ts` 新增导出 `createReleaseCandidate(client, bundle, releaseId)` 承载 `logiplan.create_data_release_candidate(...)`。两处此前在 helper 之外自动提交，响应丢失时无法被判定为未知。
5. **报告路径语义**（`scripts/neon-baseline.mjs`）：新增 `reserveReportPath(path)`，在任何 localConfig、git 预检与数据库连接之前以 `open(path, "wx", 0o600)` 独占预留；路径被占用时立即以已知失败结束、零连接、不覆盖已有文件；预留成功后写入不再吞错，写入失败时把 `reportWriteFailure` 并入错误信息。**这是相对 2026-09-21 的行为变化：复用旧路径将从「仍会执行远程写入但报告丢失」变为「连接前即失败」。**
6. **进程树终止**（`scripts/verify-gate1-isolated.mjs`）：`terminateProcessTree` 落到 `scripts/wait-for-server.mjs` 并导出，应用于超时路径、`stopServer` 与信号处理共 6 处；两处 spawn 增加 `detached: process.platform !== "win32"`（与 `neon-baseline.mjs` 既有做法一致），使 POSIX 的进程组终止分支真正生效。Windows 使用 `taskkill /PID <pid> /T /F`：Windows 无 SIGTERM 语义，因此不做「先温和后强制」的宽限升级，直接终止整棵树；POSIX 使用进程组终止并回退直接信号。
7. **PowerShell 入口编码**（`scripts/neon-baseline.ps1`）：只新增 UTF-8 BOM（3 字节，内容未改，文件由 2703 字节变 2706 字节）。根因：Windows PowerShell 5.1 对无 BOM 脚本按控制台 ANSI 代码页解码，控制台代码页为 437 时中文被错误解码并破坏引号配对，报 `ParserError`（`neon-baseline.ps1:39 char:53`）；加 BOM 后 5.1 与 7.6.6 均正常执行。

本轮实测结果（最终版本）：

- `node --test scripts/neon-baseline.test.mjs scripts/neon-permission-audit.test.mjs scripts/verify-gate1-isolated.test.mjs`：启用 `NEON_BASELINE_TEST_DOCKER=1` 与 `postgres:18.6` 为 **57 passed、0 skipped、退出码 0**；`postgres:18.4` 下 baseline + audit 为 50 passed、0 skipped、退出码 0；无 Docker 下 baseline + audit 为 48 passed、2 skipped、退出码 0。
- **计数口径更正**：baseline 文件由 37 项增至 40 项（新增 1 项真实库 ACL 检查路径回归与 2 项报告路径测试），audit 文件 10 项，Gate 1 继续运行同一 baseline 文件。此前文档中的「Docker 46/46（Neon baseline 36 + 权限 audit 10）」与「无 Docker 46 passed + 1 skipped」均已作废。
- `vitest run`：13 文件、95 passed、11 skipped、退出码 0；`vitest run --coverage` 退出码 0，All files 95.51% stmts / 87.5% branch / 95.96% funcs / 95.66% lines。
- 完整 `eslint --max-warnings 0` 与 `tsc -p packages/db/tsconfig.json --noEmit` 退出码 0。本次改动的 9 个文件全部通过 `prettier --check`；全仓 `pnpm format:check` 仍为退出码 1，失败项为 9 个既有用户资产（`AGENTS.md` + 根目录 8 份 `neon-baseline-report-*.json`）。
- `pnpm verify:gate1:isolated` 本轮共执行 6 次：第 1、3 次退出码 1，第 2、4、5、6 次退出码 0；**第 4、5、6 次构成连续三次正常退出**。退出码 0 的执行覆盖 PostgreSQL 18.4 迁移/V1/V2/发布幂等/显式激活/三角色权限/查询计划（`temp_written_blocks` 全为 0）、生产构建、快照持久化证据 28/28、Chromium 双视口基础 10 passed、Chromium 双视口历史证据 22/22、Firefox 3/3，以及并发 5 的 100 次热查询（第 2 次 P50 24.888ms / P95 42.693ms / P99 50.005ms；第 5 次 P50 26.253ms / P95 46.735ms / P99 53.58ms；第 6 次 P50 23.719ms / P95 42.28ms / P99 46.258ms）。第 2、4、5、6 次执行后的残留检查均为：无 gate1 / acl 容器、卷、网络，Chromium 进程 0，Firefox 进程数与运行前一致，pnpm 0。
- Gate 1 两次失败必须保留，不得记为稳定通过：第 1 次为 Firefox 核心冒烟 3 项中 1 项失败（`apps/web/tests/gate1.spec.ts:118`）——URL 已正确跳转 `/attribution?destination=GB`，但 5 秒内未出现标题「英国履约变动成本归因」，失败现场的可访问性快照显示页面仍停在加载壳（`heading "正在加载分析工作台"` 与 `paragraph: 正在读取已发布的确定性结果，请稍候。`），同轮第二项同页用例通过；第 3 次为 `packages/db/src/evidence-snapshot.test.ts:837-849` 的 `browserExpect.poll` 在 10 秒内未观测到 4 条快照落库（期望 `[1,1,1,1]`、实际 `[0,0,0,0]`），用例 `preserves historical release evidence across both Chromium viewports`（第 2 次 6744ms 通过、本次 14558ms 失败），且该次中止早于浏览器套件，跳过了 Chromium 基础、历史证据、Firefox 与性能验证。两次失败位于不同步骤、均为轮询或等待超时类；第 1 次执行期间无任何并发操作，第 3 次与本轮并发的仓库操作有时间重叠（已排除并发为唯一原因）。与 2026-09-21 的 6 次执行（4 次退出码 0、2 次浏览器启动环节异常且均无用例断言失败）合并看，Gate 1 浏览器相关环节长期不稳定，根因未定位；在消除该不稳定前，Gate 1 不得记为稳定通过，复验必须记录执行次数与每次结果。

独立审查：2026-09-22 由独立只读子代理（全新上下文、无写入权限）执行，固定点为修复前提交 `06cccf2`，判定 **PASS、无 P0/P1、列出 6 项 P2**。处置：1 项按最小改动收紧（relation ACL 断言显式校验同一 `relname` 的关系类型一致）；1 项按本仓库既有规则彻底关闭——进程树终止此前在 `scripts/neon-baseline.mjs` 与 `scripts/wait-for-server.mjs` 各有一份实现，而 `docs/neon-permission-baseline-plan.md` 第 271 行要求新脚本与 helper 不得以新增外部依赖绕过工具 SHA 保护，故已把 `scripts/wait-for-server.mjs` 纳入 `executionClosurePaths`（执行闭包由 24 条路径增至 25 条）并删除 `neon-baseline.mjs` 内的重复实现，两处统一从该模块导入；其余 4 项为既有问题或文档精度问题——报告预留属行为变化（已在本节第 5 条写明）、真实 ACL 用例受 `NEON_BASELINE_TEST_DOCKER` 门控因而默认 `pnpm test` 不会执行被修复的 SQL（由 Gate 1 编排注入该变量覆盖）、`publish-release.ts:128/230` 与 `migrate.ts:143` 仍吞掉 advisory unlock 与 `mark_failed` 的失败（既有，不在本轮范围）、`publish-release.ts:197` 候选已 COMMIT 后读状态失败仍以退出码 1 结束（既有，不在本轮范围）。审查者明确标注的未验证项：真实 PostgreSQL/Neon 执行与 Docker 门控用例、未运行任何测试套件、ps1 在代码页 437 下的实际解析、以及文档中的历史测试数字。

远程执行结果（2026-09-22，全部由用户在本机终端执行，本会话未持有任何凭据）：

1. **阶段 A 只读核查**：`node scripts/neon-permission-audit.mjs --expected-database neondb` 退出码 0，输出去敏 JSON。判读未命中任何停止条件：`current_user` 与 `session_user` 均为 `neondb_owner`，`server_version` 为 `18.6 (6569466)`；三角色属性与 `expectedRoleProperties` 完全一致；三条成员关系为 parent=基线角色、member=`neondb_owner`、grantor OID 10（`cloud_admin`，超级用户）、`ADMIN=true`、`INHERIT=false`、`SET=false`，`role_validation: accepted`；数据库与 schema 权限分布符合基线；`latest_migration = 0010`、`release_status = VALIDATED`、`active_release = null`；事务模式 `READ ONLY`、`rollback: confirmed`。**校验和无漂移**：`database/migrations/0001—0010` 的 sha256 与远端逐字一致（10/10），`data/generated/logiplan-2026-demo-data-v2.json` 的 sha256 与远端 `4cbd7759…` 一致。据此确认 2026-09-21 那次 `-Write` 的持久化影响，等于一次正常 prepare 除「权限验证通过」之外的全部内容，**写入结果未知已由只读事实证明清账**。
2. **两次远程 prepare**（`-Write`，validate-only；工具 SHA `e03d192ed023699e38df6bc8c12d8ca5cc54892d` 已获用户独立批准）：第一次报告 `neon-baseline-report-20260922-1400.json`，第二次（幂等复验，经用户单独授权）`neon-baseline-report-20260922-1405.json`。两次均退出码 0，报告字段为 `status = prepared`、`mode = prepare`、`last_completed_stage = permissions_verified`、`write_outcome = known`、`active_release_switch = false`、`release_status = VALIDATED`、`observed_active_release = null`、`protected_candidate_assets_verified = true`、`execution_closure_verified = true`、`tooling_head_sha = e03d192…`。两份报告经逐字节比对**完全相同**（2124 字节、45 个字段零差异）；执行日志显示 0001—0010 全部「跳过已执行迁移」、候选「已完成校验并停留在 VALIDATED；未切换活动发布」、三角色已存在因而未改密码。**验收标准中「两次远程执行分别使用不重复的报告路径，报告内容与只读状态一致」已满足。** `target_identity_verification.independently_verified_by_this_entry = false` 属入口设计（该字段本身不独立证明项目与分支），已由第 1 项的 SQL 身份事实与 2026-09-21 的管理 API 只读核对补齐。
3. **未执行项**（不属于本任务终点，均未触碰）：Vercel 配置与部署、数据发布激活、分支推送、远程 CI / GitHub Actions 运行、仓库秘密扫描、部署后的区域与健康检查复验。两份新报告位于仓库根目录且未跟踪，使全仓 `prettier --check .` 的失败项由 9 个（`AGENTS.md` + 8 份历史报告）增至 11 个（`AGENTS.md` + 10 份历史报告），全部为用户资产；`.workbuddy/` 已移出仓库并加入 `.gitignore` 与 `.prettierignore`，不再参与该检查。

保留为历史证据（不替代本轮结果）：2026-09-21 的 Docker `postgres:18.6` 46/46、`pnpm test` 85 passed / 11 skipped 与 6 次 Gate 1（4 次退出码 0）；2026-09-20 的 audit 9/9；以及更早的 Gate 1 退出码 0（Neon baseline 31/31、权限 audit 10/10、本地 API 5/5、快照持久化 28/28、Chromium 历史证据 22/22、Firefox 3/3）。

数据库集成验收的测试分层（2026-09-22 步骤 5）：普通 `pnpm test`（Vitest）**不自动拉起 Docker，也不包含真实 ACL SQL**；真实 PostgreSQL 18.4 与 18.6 上的角色事务与 ACL 验收统一走 `pnpm test:db-integration`（`scripts/run-db-integration-tests.mjs`，先在 18.4、18.6 各跑一次 `node --test scripts/neon-baseline.test.mjs`，再各跑一次与镜像无关的权限只读诊断与本地 API 等待逻辑回归），该入口的判定口径为**零 fail，且每条腿的 `skipped` 精确等于该测试文件显式声明的平台门控跳过数**（`scripts/run-db-integration-tests.mjs` 的 `platformGatedSkipsByFile`）——任一腿出现 fail、`skipped` 与声明不符、出现未登记的新测试文件、或 Docker 前置条件不满足，均以非零退出结束，不得把 skip 计为通过。**该口径于 2026-09-24 由 `counts.skipped > 0` 收紧为精确比较**，起因是该入口首次在 Linux CI 上执行时，Windows 专有门控用例必然跳过而被旧口径误判为失败（见第 0.3 节末「CI 首次 Linux 执行」）。Gate 1 编排中原先的三处脚本测试调用已收敛到同一入口，不再维护第二套隐藏命令。该入口脚本已纳入执行闭包（`executionClosurePaths` 25 条 → 26 条），因此未来远程写模式必须按包含它的新 HEAD 重新生成并独立批准 tooling SHA。

### 0.1 2026-09-21 轮次（历史证据）

本轮（第二次返工轮次：P1/P2 最小修复）已在最终代码上取得新的实际结果。启用 `NEON_BASELINE_TEST_DOCKER=1` 与 `postgres:18.6` 时，`node --test scripts/neon-baseline.test.mjs scripts/neon-permission-audit.test.mjs` 为 46 passed、0 skipped（Neon baseline 36 + 权限 audit 10）；`pnpm test` 为 85 passed、11 skipped；`pnpm lint`、`pnpm typecheck`、`pnpm test:coverage`、`pnpm build` 退出码均为 0；`pnpm verify:gate1:isolated` 共执行 6 次（4 次退出码 0），每次退出码 0 的执行覆盖 PostgreSQL 18.4 迁移/V1/V2/发布幂等/显式激活/三角色权限/查询计划、生产构建、快照持久化证据 28/28、Chromium 双视口基础 10 passed 与 22 项设计性跳过、Chromium 双视口历史证据 22/22、Firefox 3/3、6 条查询计划 `temp_written_blocks` 全为 0，以及并发 5 的 100 次热查询（第 2 次 P50 23.083ms / P95 38.898ms / P99 42.123ms；第 3 次 P50 23.865ms / P95 42.099ms / P99 44.621ms；第 5 次 P50 23.165ms / P95 43.537ms / P99 47.975ms；第 6 次 P50 22.521ms / P95 40.066ms / P99 45.452ms）；临时容器、网络与卷已清理。axe serious/critical 断言位于 `gate1.spec.ts` 内，随上述 Chromium 与 Firefox 用例执行。

Gate 1 在本机多次执行结果不稳定，必须如实记录（共 6 次：4 次退出码 0，2 次浏览器启动环节异常）。第 1 次在子步骤“Chromium 双视口历史证据验收”以原生崩溃码 `3221226505`（`signal=null`，无任何用例输出）失败，整体退出码 1；第 2、3、5、6 次全流程退出码 0，历史证据子步骤均为 22/22；第 4 次挂起在子步骤“Chromium 双视口基础冒烟”——Playwright 与 `next start` 进程存活，但系统中无任何 Chromium 进程，`test-results/.playwright-artifacts-0` 自启动后约 30 秒起停止更新，等待超过 15 分钟无进展后人工终止该进程树并清理其隔离容器、卷与网络（该次不产生通过或失败结论）。第 5 次执行前完成环境净化（停止陈旧容器、清理测试产物、关闭浏览器进程，可用内存由 5.67 GB 升至 8.85 GB、提交量由 34.93 GB 降至 31.34 GB）后通过，第 6 次在补齐步骤超时后通过；两次异常均无用例断言失败，同一批用例在其余执行中通过，异常时段 Windows 事件日志亦无 `Application Error` / WER 记录，因此判定为环境不稳定而非项目代码缺陷，且根因未定位。在消除该不稳定之前，Gate 1 不得记为稳定通过，复验必须记录执行次数与每次结果。

2026-09-21 经用户授权对 Gate 1 编排做了一处最小改动：此前编排对 Playwright 等步骤未设置 `timeoutMs`，第 4 次的无限挂起即由此产生。现为隔离 PostgreSQL 启动、Neon 基线回归、快照集成测试、生产构建、Chromium 双视口基础冒烟、Chromium 双视口历史证据验收、Firefox 核心冒烟和并发性能验证补上 `timeoutMs`（240–420 秒，约为实测耗时的 6–10 倍）；该次改动只新增超时参数，未改动该脚本的断言、步骤顺序或环境变量。覆盖范围必须限定：迁移、发布、激活、结构校验、权限审计回归等其余步骤仍没有 `timeoutMs`，它们发生挂起仍会无限等待；只有已覆盖的上述 8 个步骤会在挂起时沿编排既有的 SIGTERM → SIGKILL → 失败路径转为一条有记录的超时失败。

独立复查：2026-09-21 由独立只读子代理（全新上下文、无写入权限，与被审查者同一模型家族，非原冻结安排中的 Sol High）执行，判定 PASS，无 P0/P1，列出 6 项 P2。据此修复了其中 2 项代码问题：`runCli` 中的 `parseArguments` 移入 `try`，恢复“Neon 基线执行失败：… ”脱敏输出与退出码 1，不再向用户输出原始堆栈；`runProcess` 的 `error` 事件改为走 `isUnknownWriteProcessExit`，与“单一纯函数统一判定”的表述一致（行为等价）。另新增 1 项参数错误回归测试。其余 4 项为文档精度问题，已按本节收窄描述。复查者明确标注的未验证项：ps1 → 真实 Node 入口的 75 组合链路、真实 signal 退出、Docker `postgres:18.6` 的 46 passed 结果、Gate 1 的 6 次执行结果、全部远程结论（均因需连库或耗时未复现）；复查者已自行复现 `pnpm test` 13 文件 85 passed / 11 skipped、`pnpm lint`、`pnpm typecheck`、定向 prettier 与 baseline 定向测试。

本轮修复的两个问题及实际原因：P1 为 Node 入口最外层 `catch` 固定写 `process.exitCode = 1`，PowerShell 入口又用 `throw "…退出码为 $LASTEXITCODE"` 覆盖原始退出码，写入结果未知无法以 75 传播；现由 `exitCodeForBaselineError` 与可注入的 `runCli` 统一映射退出码，PowerShell 入口保存并原样 `exit` Node 的退出码，并在 `finally` 中恢复凭据环境变量与其偏好设置。P2 为 `runProcess` 仅按退出码 75 认定未知写入结果，137 等异常退出码、信号终止、已启动写入子进程的超时，以及子进程启动后的异常 `error` 事件都会落入 known_failed；现由单一纯函数 `isUnknownWriteProcessExit` 统一判定，错误对象保留 `childExitCode` 与 `childSignal` 诊断字段。两处修复均先建立红灯测试再实现，未知写入结果不自动重试、不标记候选 `FAILED`。

执行者说明：用户在本轮明确取消原先冻结的“Luna High 实现 + Sol High 独立复查”角色安排，改由单一会话模型（DeepSeek V4.1 Flash）完成本文件所述的实现与验证，随后由独立只读子代理完成复查（判定 PASS，问题与修复见下段）。该安排覆盖角色与模型名称，独立复查这一要求本身并未取消。本轮状态为“本地实现、验证与独立复查均已完成，复查无 P0/P1”；这不等于基线验收签署，远程准备仍受 tooling SHA 与单独授权约束。

裸执行两个 Node 测试文件 41 项（40 passed、1 项 Docker 条件 skip）、历次 PostgreSQL 18.6 定向验证 41/41，以及历史 Gate 1 退出码 0（Neon baseline 31/31、权限 audit 10/10、本地 API 5/5、快照持久化 28/28、Chromium 历史证据 22/22、Firefox 3/3，P95 43.954ms）全部保留为历史证据，不再是本轮最新结果。普通 Chromium 基础命令中 22 项历史用例按设计跳过，随后由历史证据专项完整执行。

2026-09-20 的局部历史记录为 audit 9/9、相关五文件格式检查通过及独立复查 PASS，仅覆盖当时的 audit 改造，不代表完整本地基线、远程 Neon 基线或本轮最新 Gate 1。候选 SHA 固定为 `0229755a097dff94c8de67954b36ab4f9412c0f5`，新的 tooling SHA 尚未生成，不得用候选 SHA 或任意占位值冒充 tooling SHA。audit 只输出脱敏 JSON、拒绝 `--report` 且不保存文件；正式 `neon-baseline --report` 保留。H1 仅是本地 PostgreSQL 机制证据，不是 Neon 根因确认。该轮后续实际执行了远程只读核对与一次 `-Write` 尝试：管理 API 只读核对的项目、分支、数据库与 endpoint 与冻结值一致；数据库只读预检通过并返回 `status = preflight_passed`（`writes = []`、`last_completed_stage = git_validated`）；随后一次 `-Write` prepare 失败并据此定位出 `acldefault` 类型错误（本轮修复项 1）。未激活远程发布、未部署、未推送；该次尝试之前的远程持久化状态尚无新的只读事实证明，因此不得把「写入结果未知」记为已澄清。

本轮全仓 `pnpm format:check` 仍为退出码 1，失败文件固定为 `AGENTS.md` 与根目录 7 份 `neon-baseline-report-*.json` 共 8 个用户资产；本轮只对改动文件做定向格式检查，未执行全仓 `prettier --write`。注意 `.workbuddy/memory/*.md` 也在全仓检查范围内，新增未格式化记忆文件会把失败数从 8 变 9。本机环境补充事实：`node` 必须显式使用 24.15.0（`C:\nvm4w\nodejs\node.exe`），PATH 默认的 22.22.2 不满足 `engines.node`；`pnpm exec <bin>` 在当前 shell 下无法解析到本地二进制，需改用 `pnpm <script>` 或 `node_modules/.bin/<bin>.cmd`；`prettier --check` 显式指定 `.ps1` 会因无解析器报错（退出码 2），需加 `--ignore-unknown`。

本地数据库入口的未知提交结果使用结构化退出码 75 传播。baseline 把写入子进程的异常终止统一判定为写入结果未知：退出码 75、任何非 0/1 的异常退出码、非空 `signal`、超时，以及子进程已启动后无法解释的 `error` 事件；判定只依据进程状态，不通过 stderr 文本或失败候选状态推断已回滚。Node 入口按“成功 0 / 已知失败 1 / 写入结果未知 75”返回，PowerShell 入口原样透传 Node 的退出码，不再改写为 1；参数与环境校验错误属于已知失败，以退出码 1 结束并输出脱敏单行信息。未知结果只做只读复核，不自动重试、不标记候选 `FAILED`；正常错误只有在 ROLLBACK 得到确认后才允许进入 known_failed；发布入口在未知提交结果时不执行 `mark_data_release_failed`。

`verify-schema` 含事务内写入权限探针，因此按写入敏感子进程处理：它被信号或异常退出码终止时同样判为写入结果未知，这不属于“只读子进程不受影响”的例外说明——该例外只适用于 git 与本地预检等真正的只读子进程。本节契约覆盖 baseline 入口；`packages/db/src/activate-release.ts` 与 `scripts/publish-gate1-v1-baseline.ts` 的 CLI 包装仍固定以退出码 1 结束，二者的底层事务模块已具备 `writeOutcomeUnknown` 语义，但包装层未传播 75。激活被远程执行包显式排除，`publish-gate1-v1-baseline.ts` 只用于本地 Gate 1 夹具，因此二者不影响本轮远程准备；如需把它们纳入统一契约，应作为单独的最小改动处理。

远程执行包在 tooling SHA 生成并独立批准前不可执行。固定目标为 `logiplan-public-test` / `mute-mouse-49732061`、`aws-ap-southeast-1`、PostgreSQL `18.6`、`main` / `br-patient-smoke-b3f5jtui`；准备顺序为：只读目标/身份/迁移/V2/活动发布预检 → 一次 `neon-baseline.ps1 -Write -Report <新报告路径>` 的 `validate-only` prepare → 仅在首次成功且获明确授权时使用新报告路径重复同一入口作幂等复验。前置批准必须同时覆盖精确 candidate SHA、已提交且独立批准的 tooling SHA、目标项目/分支/数据库、一次 prepare、一次幂等复验和只读状态核查；不包括激活、部署、密码变更或额外 GRANT/REVOKE。任何目标漂移、成员/ACL/校验和差异、V2 为 FAILED、状态未知、首个写入失败或提交确认丢失均立即停止；未知结果只做只读复核，不声称 rollback/success。本轮代码修复已于 2026-09-21 以单次提交提交（`104f4b0f`，15 个文件）并通过独立复查；本段文案修正为紧随其后的独立文档提交，因此 tooling SHA 应取包含本次文案修正的当前 HEAD 并仍需独立批准。未连接 Neon、未部署 Vercel、未推送，也未准备远程执行包。

### 0.2 2026-09-23 轮次（事务语义与 Gate 1 稳定性）

本轮任务定义见 `%TEMP%\logiplan-next-round-handoff-2026-09-22.md`（步骤 1—9）。全部改动在工作区、未提交，未触碰任何远程环境。

**事务与清理语义（步骤 2—4）**：新增内部模块 `packages/db/src/transaction-outcome.ts`（未进 `packages/db/src/index.ts`）。三类结果＝类1 `rollbackConfirmed`（退出码 1）、类2 `writeOutcomeUnknown`（退出码 75，语义未变）、类3 新增 `writeCommittedObservationFailed`（退出码 1、stderr 前缀 `[WRITE_COMMITTED_OBSERVATION_FAILED]`、消息固定含「写入已提交，失败发生在后续观察或清理阶段」、报告新增布尔 `write_committed_observation_failed` 与 `write_outcome=committed_observation_failed`）。`migrate.ts` 与 `publish-release.ts` 的加锁流程改由 `runWithConnectionCleanup` 包裹，advisory unlock 与 `client.end()` 各自独立尝试；`markPublishFailedIfKnown` 改为可判定 COMMIT 的显式事务；候选创建后与校验写入后两处读取失败改走 `observeCommittedWrite`。红灯证据：修复前定向测试 10 failed | 19 passed（退出码 1），修复后 29 passed（退出码 0）。

**数据库集成入口（步骤 5）**：新增 `pnpm test:db-integration`（`scripts/run-db-integration-tests.mjs`）＝四条腿：`postgres:18.4` 与 `18.6` 各跑一次真实角色事务与生产 ACL 查询，另加只读诊断与本地 API 等待逻辑回归；零 fail 且零 skip 才退出 0（该口径已于 2026-09-24 收紧为「零 fail，且 `skipped` 精确等于显式声明的平台门控跳过数」，见第 0.3 节末「CI 首次 Linux 执行与两处修复」），Docker 不可用时以「前置条件不满足」非零退出。Gate 1 的三处脚本测试调用收敛到该入口；`executionClosurePaths` 25 → 26 条；新入口与 Gate 1 编排脚本进入 `pnpm lint` 清单。

**Gate 1 稳定性（步骤 6—8）**：新增环境变量驱动的定向重复模式（`LOGIPLAN_GATE1_TARGET=firefox|snapshot`、`LOGIPLAN_GATE1_REPEAT=N`）与 JSONL 时间线埋点；**未改动任何断言或超时值**。实测余量：Firefox 导航→目标标题 1.55—1.86s（预算 5s，首迭代冷启动最慢 1.65s）；快照首次轮询采样即 `[1,1,1,1]`（约 1.18s，且 `started_requests=0`，四条快照由服务端首屏 SSR 提交），预算 10s。定向重复各 20/20。

**失败现场（必须保留）**

- 2026-09-23 上午完整 Gate 1 四批各 5 次中有 16 次失败，全部倒在第一步数据库集成，错误为 `read ECONNRESET`（errno -4077）或 `Connection terminated unexpectedly`，耗时 1.9—2.1s，即容器就绪后宿主机建立 TCP 连接的瞬间；同轮其余 42/44 项全绿，腿 3 与腿 4 始终通过。隔离复现（异步通道、单进程、六轮：18.4、18.6、以及先 18.4 后 18.6 的连续两轮）全部成功，容器单独运行 15s 稳定，就绪与连接时序复刻成功 → 判定为宿主侧端口转发的偶发抖动。处置：在 `startRoleBootstrapPostgres` 增加有界宿主侧可达性探测（≤12 次 × 250ms；失败时报出镜像、容器、发布端口、尝试次数与末次错误码），属「等待可观察状态」而非放宽超时。此后用户终端连续 6 次集成入口与 20 次完整 Gate 1 均未再现连接重置，且探测未触发过重试（总耗时与改动前同量级）。
- 两次历史浏览器超时（2026-09-22 第 1 次 Firefox 首次导航、第 3 次快照轮询）在本轮 40 次定向复现中零复现；余量分别约 3 倍与约 14 倍，据此排除「边缘超时」，根因仍未定位。
- Firefox 每次迭代必现 React 水合失败 `#418`（`args[]=HTML` ⇒ 元素级不匹配），本轮未修复，列入遗留项；**已于 2026-09-24 轮次定位并修复**：根因是 `apps/web/app/dashboard-workspace.tsx:509` 的 `<title>` 子节点数组长度为 5（React 不支持长度大于 1 的 `<title>` 子节点数组，服务端渲染为空 `<title>`），改为单个模板字符串后生产 SSR 空标题计数为 0、生产 Firefox 20 次迭代 `#418` 计数为 0。详见 `docs/development-roadmap.md` 第 0 节。

**本轮逐次执行记录**

- 完整 Gate 1：20 次（四批各 5 次）全部退出码 0。其中**最后一批 5 次的完整日志已留存并逐项核对**：每次四条腿 `44/44`、`44/44`、`10/10`、`7/7` 零 skip；Chromium 双视口基础 10 passed（14.2—19.5s）；历史证据 22 passed（41.1—42.8s）；Firefox 3 passed（9.1—32.0s）；查询计划 `temp_written_blocks` 全 0；并发 5 × 100 热查询 p50 22.2—23.9ms、p95 37.6—46.5ms、p99 42.8—48.3ms。前 15 次仅有终端汇总行（`[accept N] exit=0`）为证据，未留存完整日志。
- 数据库集成入口：用户终端连续执行 6 次全部退出码 0（可归档日志覆盖其中 5 次，逐腿 `44/44`、`44/44`、`10/10`、`7/7`）。
- 无 Docker 时脚本测试：退出码 0，跳过 2 条门控用例。
- 覆盖率 `vitest run --coverage`：退出码 0，All files 95.51% stmts / 87.5% branch / 95.96% funcs / 95.66% lines。eslint、`tsc -p packages/db`、14 个改动文件的 prettier 均退出码 0。

**运行后残留检查**：无 gate1 容器、网络、卷；Chromium 进程 0；Firefox 进程数与运行前一致（为用户自身浏览器）；pnpm 进程 0。

**独立审查**：以 `da0d769` 为固定点判定 PASS、无 P0/P1、6 项 P2；P2 全部按后续任务记录，见 `docs/neon-permission-baseline-plan.md` 遗留项 1—6。审查者未能独立验证 Gate 1、Playwright 与 Docker 实跑，并指出「20 次」「6 次」中可核对的只有留存的 5 次——本节已按此收窄表述。

**未执行项**：推送分支、远程 CI、Vercel 配置与部署、数据激活、部署后区域与健康检查复验；`#418` 修复与 `activate-and-materialize.ts` 同类吞错收口均需超出本轮批准范围（两者**均已**于 2026-09-24 轮次完成：`#418` 经用户单独批准后修复，`activate-and-materialize.ts` 的 advisory unlock 吞错由同一轮重构关闭）。另需注意：`scripts/neon-baseline.mjs` 与 `scripts/run-db-integration-tests.mjs` 都在执行闭包内，若未来需要远程 `--write`，必须按新 HEAD 重新生成工具 SHA 并独立批准。

### 0.3 2026-09-24 轮次（`#418` 修复、Gate 1 两批次连续复跑与独立审查）

**执行环境更正**：会话内环境无法运行仓库验收入口——`spawnSync`/`execSync` 恒返回 `EBUSY`，宿主 `node-safe-delete-shim` 拦截单次删除 ≥50 文件的操作（`next build` 的收尾清理与 Playwright 清理 `test-results/` 均会触发），导致会话内构建停留在未定稿状态。**结论：Gate 1、`pnpm test:db-integration` 与生产构建必须在本机终端执行**；会话内以未定稿构建跑出的 E2E 失败（导航期 `_rsc` 重定向循环、Firefox「The page isn't redirecting properly」）已确认与代码无关，正式构建下同一用例通过。

**命令语法（本轮实际踩到）**：本项目脚本以 Git Bash 编写。在 **Windows PowerShell** 中，`rm -rf <path>` 与 `VAR=value pnpm ...` 均无效，须改用：

```powershell
Remove-Item -Recurse -Force apps/web/.next
$env:LOGIPLAN_GATE1_TARGET = 'firefox'
$env:LOGIPLAN_GATE1_REPEAT = '20'
pnpm verify:gate1:isolated
Remove-Item Env:LOGIPLAN_GATE1_TARGET, Env:LOGIPLAN_GATE1_REPEAT
```

**Gate 1（用户终端，单次）**：退出码 0。生产构建完整通过（`✓ Finalizing page optimization in 56ms`）。分项：数据库集成四条腿 `44/44`、`44/44`、`10/10`、`7/7` 零 fail 零 skip（当时口径为「零 fail、零 skip」；该口径已于同日收紧为「零 fail，且 `skipped` 精确等于显式声明的平台门控跳过数」，Windows 上的声明值即为 0，故该次记录仍成立）；从零迁移 0001—0003 后升级 0004—0010；V1 基线发布、V2 候选校验、显式激活与原子物化、重复发布幂等；结构/精度/三角色权限；不可变发布升级与核心查询；6 条查询计划 `temp_written_blocks` 全 0；快照集成 28/28；Chromium 双视口基础 10 passed / 22 skipped；Chromium 双视口历史证据 22/22；Firefox 核心冒烟 3/3（`V01-V04` 8.5s，含会话内曾 20/20 失败的「展开固定成本」一步）；并发 5 × 100 热查询 p50 30.316ms / p95 74.502ms / p99 104.476ms；运行后隔离容器、卷、网络全部移除。`pnpm test:db-integration` 另独立执行一次，同样四条腿零 fail 零 skip。

**未达成的计划要求（完整 Gate 1 × 5 连续，要求 5/5 退出码 0）**：两批次均已执行，均未达成。

- **批次一**（原始命令，无迭代间清理）：`0, 0, 0, 1, 1`，即 3/5。第 4 次在 `Firefox 核心冒烟` 以原生崩溃码 `3221226505` 失败、**零用例输出**（此前各阶段全部通过：数据库集成四条腿、迁移/发布/激活/查询计划、生产构建、快照 28/28、Chromium 双视口基础 10 passed、Chromium 双视口历史证据 22 passed）。第 5 次在 `Chromium 双视口基础冒烟` 以 `Error: http://127.0.0.1:4173/api/health/live is already used` 失败——第 4 次崩溃时 Playwright 进程先于收尾退出，`next start` 泄漏并占住 4173（实测泄漏进程 `next start --hostname 127.0.0.1 --port 4173`，父进程已消失），属**纯级联**而非独立失败。
- **批次二**（加固编排：每次迭代前后清理 4173/4174 监听进程与泄漏的 `next start`，**不触碰断言、超时与用例选择**）：`0, 0, 0, 0, 1`，即 4/5。第 1—4 次全部退出码 0；第 5 次在 `Chromium 双视口历史证据验收` 失败，错误为 `Error: worker process exited unexpectedly (code=3221226505, signal=null)`，首个用例 `[chromium-1440] historical-evidence.spec.ts:326:5` 在 **0ms** 失败（worker 在用例体执行前崩溃），其余 **21 passed**。该次结束后隔离容器、命名卷、网络残留均为 `none`，端口无泄漏。

**崩溃定性**：`3221226505` = `0xC0000005` = `STATUS_ACCESS_VIOLATION`。两批次共 10 次执行、2 次原生崩溃（`Firefox 核心冒烟` 1 次、`Chromium 双视口历史证据验收` 1 次）、**零断言失败**；崩溃跨两个阶段但均落在浏览器阶段的启动边界。同一崩溃码与同一阶段在 2026-09-21 已有记录（见第 0.1 节），判定为**既有环境不稳定**。已排除用户浏览器负载（批次二运行期间 `firefox.exe` 计数为 0）与磁盘空间（系统盘剩余 434 GB）。故本轮只记「代码侧验收全部通过」，**不得**记「Gate 1 稳定通过」。

**`#418` 修复**：根因、证据与修复见 `docs/development-roadmap.md` 第 0 节。要点：`apps/web/app/dashboard-workspace.tsx:509` 的 `<title>` 子节点数组长度为 5，React 服务端渲染为空 `<title></title>`，造成元素级水合不匹配；改为单个模板字符串后，生产 SSR 空 `<title>` 计数为 0（12/12 月度条形图标题文本正确），生产 Firefox 20 次迭代 `#418` 与 `pageerror` 计数均为 0。原「Firefox 独有」判断不成立（三个浏览器工程均出现）。

**独立审查（固定点 `bc5383d`）**：全新上下文的只读子代理判定 **PASS、无 P0/P1、4 项 P2**。已确认：`closeConnection=false` 语义正确（`releaseConnection` 提前返回，不代调用方关闭连接）；`40001` 现归类为未知写入（保守方向正确，白名单仍为 `25*` + `2D000`）；CLI 退出码 75 与 `[WRITE_COMMITTED_OBSERVATION_FAILED]` 前缀互斥、不可能同时出现；**未改动任何既有断言或超时值**；环境变量透传不夹带凭据、未设置时行为逐字节不变；`<title>` 修复为最小正确改动且全仓无同类残留；`transaction-outcome.ts` 未进入 `packages/db/src/index.ts`，公共 API 无变化。4 项 P2（`recordHydrationDomProbe` 未做环境变量门控、激活 CLI 缺少提交后观察失败的正向断言、`transaction-outcome.ts` 吞 falsy 抛出、`activate-release.ts` 的 `finally` 可能掩盖第三类）与 `pg` 弃用警告一并列入 `docs/neon-permission-baseline-plan.md` 的本轮遗留项 1—5。

**未执行项**：Vercel 配置与部署、数据激活、部署后区域与健康检查复验。推送分支与远程 CI **已执行**（见下文「CI 首次 Linux 执行与两处修复」）。本轮计划要求的 Gate 1 连续 5 次复跑已执行两批次，均未达成 5/5（见上文），阻塞项为既有环境不稳定；原生崩溃 `3221226505` 的根因定位（Windows 事件日志 / WER 崩溃转储）未执行。

**操作要点（供后续轮次复用）**：`next start` 会在 Playwright 进程异常终止时泄漏并占住 4173，使**下一次** Gate 1 在 `Chromium 双视口基础冒烟` 直接失败（`/api/health/live is already used`）。因此连续复跑的每次迭代**前后**都应清理 4173/4174 的监听进程与命令行匹配 `next*start*4173` 的 `node.exe`，并逐次报告隔离容器与命名卷残留。该清理只处理进程与端口，不涉及断言、超时或用例选择。

**CI 首次 Linux 执行与两处修复（2026-09-24，同日续）**：提交与推送后，CI run `35977886490`（`pull_request` 触发）**失败**。步骤 1—10（Check formatting / Lint / Type-check / Test with coverage / Install Chromium and Firefox）全部通过，失败在步骤 11「Run isolated Gate 1 validation」，即 `pnpm test:db-integration` 的**首次 Linux 执行**。两个根因均为本地 Windows 验证结构上无法发现：

1. **平台门控跳过与零 skip 策略冲突**：`scripts/neon-baseline.test.mjs` 的用例「Windows 入口原样透传 Node 退出码」由 `process.platform === "win32"` 硬门控（其宿主探测只查找 Windows 路径），在 POSIX 上必然跳过，于是 legs 1/2 报 `skipped=1`，被旧判定 `counts.skipped > 0` 判为失败（尽管 `fail=0`）。
2. **POSIX 进程组终止实际是死代码**：`scripts/wait-for-server.mjs` 原写 `child.kill(-child.pid, signal)`；`ChildProcess.kill()` 只接受 `[signal]`，负 pid 被当作信号名解析并抛 `ERR_UNKNOWN_SIGNAL`（实测 `Unknown signal: -45592`），`catch` 必然触发、退化为只杀直接子进程，后代（pnpm / Playwright / 浏览器 / `next start`）全部残留并占住端口——与上文「操作要点」记录的 4173 泄漏属同一类故障。CI 用例「进程树终止会一并结束后代进程」因此失败（后代进程 5763 未被终止）。

修复提交 `4ff4fb0`（`fix(gate1)`，2 文件 +67/−9）：POSIX 分支改用 `process.kill(-child.pid, signal)`（全部调用点均以 `detached: process.platform !== "win32"` 启动，故 POSIX 下 `child.pid` 即 PGID；Windows 的 `taskkill /PID /T /F` 分支逐字节未改动）；判定改为 `platformGatedSkipsByFile` 显式声明 + 精确比较。**未改动任何既有断言、超时值或用例选择。**

**CI 已转绿**：`ubuntu-latest` 上连续五次成功——`35984529953`、`35984592984`、`35985477229`、`35986663729`、`35987670886`（最新一次 `headSha` = `f9c4bfd`），三个 job（Gate 1 deterministic validation、Pull request dependency review、CodeQL JavaScript and TypeScript）全部 success。**这是根因 2 唯一的独立证明**（POSIX 路径在 Windows 上无法验证）。

**对后续写入模式的影响（硬前置）**：第 1 节冻结的候选 `0229755a097dff94c8de67954b36ab4f9412c0f5` 现已落后 22 个提交（2026-09-25 实测 `git rev-list --count 0229755a…..HEAD` = 22；该值随分支推进单调增加，进入写入模式前须以当时实测为准），而第 2 节规定写入模式要求当前 HEAD 精确等于已批准的工具 SHA，故**进入 `--write` 前必须重新冻结并独立批准新的工具 SHA**。

**交接文档**：`docs/handoff-2026-09-25.md`（窗口 2026-09-25 → 2026-10-01，任务 T1—T8）与 `docs/handoff-2026-10-01.md`（窗口 2026-10-01 → 2026-10-05，任务 P1—P6 / E1—E5 / S1—S2）。第二窗口第一段 P1—P6 为只读准备（含上述工具 SHA 重新冻结），第二段 E1—E5 为远程写，未获授权前不执行。

**2026-09-25 续：lint 覆盖收口、工作区清理与独立审查（T3 / T8 / T5）**

- **T3（提交 `77b6797`）**：把 `scripts/wait-for-server.mjs` 与 `scripts/verify-gate1-isolated.test.mjs` 补入 `package.json` 的 `lint` 清单（1 行改动）。`eslint` 全清单退出码 0。
- **T8（提交 `6c3afb6`）**：删除工作区两处错误重定向产物。已跟踪的 `"itory multi-agent workflow•"` 内容经取证确认为 **`less` 分页器的帮助屏**，于 `a63a43c`（同时存在于 `origin/main`）加入；未跟踪的 `e HEAD`（33359 字节的 `git diff` 碎片）已移至 `%TEMP%` 备份而非直接销毁。工作区由 13 项约定资产降至 **11 项**（`AGENTS.md` + 10 份 `neon-baseline-report-*.json`）。**注意**：本节与第 0.2 节的历史记录把「工作区仅剩 11 项约定排除资产」列为写模式前置检查项——该数字现在仍是 11，但**组成已不同**（历史记录为 `AGENTS.md` + 异常 tracked 文件删除 + `e HEAD` + 8 份报告 + `.workbuddy/`；现为 `AGENTS.md` + 10 份报告）。比对时须按组成而非仅按数量。
- **T5 独立审查（固定点 `6c3afb6`）**：全新上下文的只读子代理判定 **PASS、无 P0/P1、6 项 P2**。已确认 `process.kill(-child.pid, signal)` 正确、全部 `terminateProcessTree` 调用点的子进程均以 `detached: process.platform !== "win32"` 启动、Windows `taskkill` 分支逐字节未变、`platformGatedSkipsByFile` 四类场景（未登记抛错 / 声明 1 实得 0 / 声明 0 实得 1 / 无法解析计数）全部 fail closed、未改动任何断言、超时值或用例选择。**6 项 P2 全部为文档精度问题**，已一并修正：本节的「连续四次」更正为五次、「落后 18 个提交」更正为 22，`docs/development-roadmap.md` §0 遗留项 7 标注关闭、遗留项 8 更正为 22，`docs/handoff-2026-09-25.md` 的「领先 18 个提交」更正为 26，`docs/handoff-2026-10-01.md` 的「落后 18 个提交」更正为 22，`6c3afb6` 的提交标题由「two files」修正为单数。
- **T1 本地正式复验（2026-09-25，用户终端，全部通过）**：`pnpm test:db-integration` 四条腿 `fail=0` 且 `skipped=0` 与显式声明的平台门控跳过数完全一致；`pnpm verify:gate1:isolated` 退出码 0，且**本次是完整且干净的 Gate 1，未命中 `3221226505`**（生产构建完整通过、快照集成 28/28、Chromium 双视口基础 10 passed / 22 skipped、Chromium 双视口历史证据 22/22、Firefox 核心冒烟 3/3、6 条查询计划 `temp_written_blocks` 全 0、并发 5 × 100 热查询 p50 28.753 ms / p95 50.459 ms / p99 56.447 ms、运行后无容器/卷/网络残留）；`pnpm lint`、`pnpm typecheck`、`pnpm test`（113 passed / 11 skipped）均退出码 0。
- **T6 只读取证与 G2 冻结决策（2026-09-25，经用户单独授权）**：只读检查 Windows 事件日志与 WER 报告——Application 日志 Id=1000/1001 共 400 条（覆盖 09-18 → 09-25）中匹配 `c0000005` 的为 **0 条**；`ReportArchive` 中无 node/chrome/firefox/playwright 报告；Playwright 的 Chromium profile 下无 Crashpad 报告；WER 未被禁用。唯一提到本项目相关进程的事件是 2026-09-22 10:06:55 的 `RADAR_PRE_LEAK_64`（`node.exe` 24.15.0.0），属资源泄漏预警而非崩溃。机器上那份 2026-09-21 的浏览器崩溃转储（`EXCEPTION_ACCESS_VIOLATION_READ`、`crash_address 0x0`）经 `ProfileDirectory`（`eqnm8cyw.default-release`）、`URL`（`chat.deepseek.com`）、模块（含用户输入法 `weasel.dll`）与会话时长 9886 s 判定为**用户自己的 Firefox**，与 Playwright 捆绑构建 `firefox-1538` 无关。**结论：Windows 层面无任何可归因记录，在批准的只读范围内根因无法定位**；据此写入 **D-188**（CI `ubuntu-latest` 为 Gate 1 稳定性的权威证据来源，本地 Windows 记为已接受的环境限制并附重试政策）。**G2 达成。**
- **仍未执行**：`3221226505` 的根因消除（D-188 明确其根因未关闭，如需消除须另行批准启用崩溃转储采集）；写入模式前的工具 SHA 重新冻结与批准（见第 2 节）；公开环境部署与数据激活（各自需要显式授权）。

## 1. 固定目标与边界

本入口只准备以下冻结目标，不创建 Neon/Vercel/GitHub 资源，也不部署应用：

- 候选：`codex/gate1-delivery-baseline`，提交 `0229755a097dff94c8de67954b36ab4f9412c0f5`（**已于 2026-09-25 重新锚定，见第 1.1 节**）；
- Neon：`logiplan-public-test` / `mute-mouse-49732061`，`aws-ap-southeast-1`，PostgreSQL `18.6`，`main` / `br-patient-smoke-b3f5jtui`；
- Vercel：团队 `logi-plan`，项目 `logi-plan-web`，Root Directory `apps/web`，Next.js，Node.js 24.x，`sin1`；
- 生产运行时只允许 `app_reader` 的池化 `DATABASE_URL`。Preview 不得获得公开测试数据库连接；应使用 PR 独立分支，无法提供时失败关闭。

`apps/web/vercel.json` 只把 Function 区域固定为 `sin1`。它不创建项目、不修改 Vercel 设置、不注入环境变量，也不构成部署。

### 1.1 冻结锚点的重新锚定（2026-09-25，第一窗口计划 P1）

**候选资产冻结仍然有效**：

- `protectedCandidatePaths`（`database/migrations`、`database/releases`、`data/generated`、`scripts/generate_demo_data.py`、`scripts/upgrade_demo_release_v2.py`）自 `0229755a…` 以来**逐字节未变**——`git diff --quiet 0229755a…..HEAD -- <protectedCandidatePaths>` 退出码 0。
- 四项清单校验和与磁盘实际值**逐字一致**（用 `sha256sum` 独立复算，结果与 `packages/db/src/release-package.ts` 的 `createHash("sha256")` 相同）：

| 资产                                             | 清单字段              | 校验和（前 16 位） |
| ------------------------------------------------ | --------------------- | ------------------ |
| `data/generated/logiplan-2026-demo-data-v2.json` | `V2.data_sha256`      | `4cbd7759d4a85a0c` |
| `scripts/upgrade_demo_release_v2.py`             | `V2.generator_sha256` | `80cc8da0871a35df` |
| `data/generated/logiplan-2026-demo-data.json`    | `V1.data_sha256`      | `4d7285a9d3cbe067` |
| `scripts/generate_demo_data.py`                  | `V1.generator_sha256` | `d8b1e7ad997e35d7` |

- 迁移 `0001`—`0010` 的 sha256 已一并复算并记录，供后续远程比对。

**旧工具 SHA 已失效**：此前批准的 `e03d192ed023699e38df6bc8c12d8ca5cc54892d` 相对当前执行闭包有 **16 文件漂移（+2091/−396）**。漂移来源包括 `scripts/wait-for-server.mjs`（进程组终止修复 `4ff4fb0`）、`scripts/run-db-integration-tests.mjs`（新增数据库集成入口）、`package.json`（lint 清单补两条路径 `77b6797`）、`packages/db/src/transaction-outcome.ts`（新增）等。按 `defaultGitPreflight`，该 SHA 会使写入模式以「执行闭包存在未提交或偏离工具 SHA 的改动，拒绝数据库写入」直接拒绝。

**执行闭包当前状态**：26 条路径 `git status --porcelain --untracked-files=all` 为空，即无未提交改动。

**锚定规则（本记录不预设锚点值）**：

- 工具 SHA 与候选 SHA 必须取 **`--write` 执行时的 `HEAD`**。因此锚点不是仓库产物，而是**运行时取值**：应在 `--write` 之前的**最后一次提交之后**立即确定，并由用户按值独立批准。本节只记录验证结论与规则，**不声明锚点值**——任何后续提交都会使其失效。
- `validateGitIdentity` 对写入模式断言 `HEAD === toolingSha`（**精确相等**）；`validateToolingApproval` 要求环境变量 `LOGIPLAN_APPROVED_TOOLING_SHA` 存在、为 40 位小写十六进制、且与 `toolingSha` 相同。**独立批准必须按值给出，不得以「当前 HEAD」代替。**
- 因此 `P3`—`P6` 若产生文档提交，**应先完成再锚定**；锚定与批准紧接在 `--write` 之前执行。
- 两条断言彼此独立：闭包比对（`git diff --quiet <toolingSha> -- <executionClosurePaths>`）只看闭包内文件是否变化；`HEAD === toolingSha` 看的是提交指针。**两条都必须满足**，只满足其一仍会被拒绝。
- 工作区的 11 项用户资产（`AGENTS.md` + 10 份 `neon-baseline-report-*.json`）不在执行闭包内，不影响锚定。

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
不要写入 `.env`、shell profile 或仓库文件。报告路径必须是不存在的新文件：入口在参数校验之后、任何本地预检、Git 检查与数据库连接之前以 `0600` 独占预留该路径；路径已被占用时立即以已知失败结束、不执行任何数据库操作，也不会覆盖已有文件。预留成功后的写入失败会以 `reportWriteFailure` 并入错误信息，不再静默吞掉。

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

### 5.1 环境变量分层表（P4，2026-09-25）

**核实方法**：全仓检索 `process.env.*` 与 `process.env[name]`，并读 `scripts/neon-baseline.mjs:32-51` 的 `roleConnections`。**本节不含任何凭据值。**

#### 5.1.1 分层表

| 变量名                                                                                                                                       | 作用域                                                                                       | 允许值来源                                     | 禁止项                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                                               | **Vercel Production 运行时**（亦为本地开发与 CI 的读路径）                                   | Neon **池化**端点；角色**必须**是 `app_reader` | 不得使用直连端点；不得使用 `schema_migrator` / `data_publisher` / `neondb_owner` 等管理角色 |
| `MIGRATION_DATABASE_URL`                                                                                                                     | 迁移入口（`packages/db` 的 migrate CLI，在**受控主机**上运行）                               | Neon **直连**端点；角色 `schema_migrator`      | **不得**配置到 Vercel 的任何环境                                                            |
| `PUBLISHER_DATABASE_URL`                                                                                                                     | 发布与激活入口（publish-release / activate-release CLI，在**受控主机**上运行）               | Neon **直连**端点；角色 `data_publisher`       | **不得**配置到 Vercel 的任何环境                                                            |
| `NEON_SCHEMA_MIGRATOR_PASSWORD`                                                                                                              | Neon 基线工具，仅用于构造 `MIGRATION_DATABASE_URL`                                           | Neon 管理直连的主机与隐藏密码                  | **不得**配置到 Vercel；不得写入仓库                                                         |
| `NEON_DATA_PUBLISHER_PASSWORD`                                                                                                               | 同上，构造 `PUBLISHER_DATABASE_URL`                                                          | 同上                                           | 同上                                                                                        |
| `NEON_APP_READER_PASSWORD`                                                                                                                   | 同上，构造 `DATABASE_URL`                                                                    | 同上                                           | 同上                                                                                        |
| `LOGIPLAN_SCHEMA_MIGRATOR_PASSWORD`、`LOGIPLAN_DATA_PUBLISHER_PASSWORD`、`LOGIPLAN_APP_READER_PASSWORD`                                      | **本地 Docker Compose 的 PostgreSQL 容器内部**（`compose.yaml:10-12`），由容器用于初始化角色 | 本地开发占位值（见 `.env.example`）            | **不是**远程凭据；**不得**与上面的 `NEON_*` 混用                                            |
| `POSTGRES_SUPERUSER_PASSWORD`                                                                                                                | 本地 Compose 的超级用户（仅本地）                                                            | 本地开发占位值                                 | 不得用于远程                                                                                |
| `LOGIPLAN_NEON_PROJECT_NAME`、`_PROJECT_ID`、`_REGION`、`_BRANCH_NAME`、`_BRANCH_ID`、`_POSTGRES_VERSION`                                    | Neon 基线工具的**非秘密**目标元数据                                                          | 仓库冻结值（第 1 节）                          | 非秘密，但同样不得配置到 Vercel                                                             |
| `LOGIPLAN_APPROVED_TOOLING_SHA`                                                                                                              | `--write` 的独立批准（`validateToolingApproval`）                                            | 用户按值给出                                   | 不得配置到 Vercel                                                                           |
| `LOGIPLAN_PUBLISH_MODE`                                                                                                                      | 发布入口（`publish-release.ts:32`）                                                          | `activate`（默认）或 `validate-only`           | 不得配置到 Vercel；**不要在普通终端遗留该变量**                                             |
| `MIGRATION_DIRECTORY`、`RELEASE_MANIFEST`                                                                                                    | 迁移与发布入口的可选覆盖路径                                                                 | 仓库内路径                                     | 不得配置到 Vercel                                                                           |
| `LOGIPLAN_GATE1_TARGET`、`_REPEAT`、`_ITERATION`、`_TIMELINE_FILE`                                                                           | 仅 Gate 1 编排脚本（定向重复与时间线埋点）                                                   | 测试用途                                       | 不得配置到 Vercel                                                                           |
| `NEON_BASELINE_TEST_DOCKER`、`NEON_BASELINE_TEST_POSTGRES_IMAGE`、`SNAPSHOT_TEST_*`、`ISSUE6_TEST_BASE_URL`、`LOGIPLAN_PERF_*`、`DOCKER_CLI` | 仅测试与性能脚本                                                                             | 测试用途                                       | 不得配置到 Vercel                                                                           |

#### 5.1.2 结构性结论（比表格更重要）

**Web 应用只读一个数据库变量。** 全仓检索确认，`apps/web` 中引用 `process.env` 的位置**只有三处，且全部是 `DATABASE_URL`**：`app/api/health/ready/route.ts:6`、`app/api/v1/query/route.ts:9`、`app/lib/query-server.ts:28`。因此「管理凭据不得进入 Web 应用环境」不只是约定，而是**代码结构上成立**——Web 侧不存在任何读取 `MIGRATION_DATABASE_URL`、`PUBLISHER_DATABASE_URL` 或 `NEON_*_PASSWORD` 的路径。

**两套密码命名空间不可混用**：`LOGIPLAN_*_PASSWORD` 是**本地 Compose 容器内部**的角色初始化密码（`compose.yaml:10-12` 把它们作为 `environment` 传给 Postgres 容器）；`NEON_*_PASSWORD` 是**主机侧工具**用于构造远程连接串的密码（`roleConnections` 的 `passwordEnv`）。名字相近但作用域完全不同。

#### 5.1.3 Preview 与 PR 分支规则

- Preview **不配置** Production 的 `DATABASE_URL`。
- Preview 只能连接**隔离的临时 Neon 分支**；隔离环境缺失或失败时**关闭预览数据访问**，**禁止回退**到公开测试数据库。
- 每个开放 PR 最多一个 `preview-pr-<编号>` 分支，并行上限 5；PR 合并或关闭后撤销连接并在 24 小时内删除；超额时保留 CI 但**不创建**预览数据库。
- 与 Neon Free 配额的相容性：每项目 10 个分支，5 并行 + `main` = 6，**余量足够**（见第 8.2 节）。

#### 5.1.4 本轮发现的一处缺口（未修复，需单独决定）

`docs/decisions.md` D-177 要求「服务器端使用 Zod 在启动或首次使用前集中校验」。实际核查：**`apps/web` 全目录没有任何 zod 引用（0 个文件）**，`DATABASE_URL` 只做真值判断（`process.env.DATABASE_URL ? createReadOnlyPool(...) : null`）。

**后果**：格式错误、或指向**错误角色**的 `DATABASE_URL` **不会在启动时被拒绝**，而是推迟到首次查询才失败；若它指向了直连端点，也不会有任何告警——这与第 9.3 节的 advisory 锁风险**同源**，都属于「配置错了不会响」这一类。

`packages/db` 侧的 `requiredEnvironment()`（`migrate.ts:25`）也只做缺失检查，不校验格式。

**处置建议（未实施，需用户决定）**：把 D-177 的 Zod 校验落到 `apps/web` 的启动路径，至少校验 `DATABASE_URL` 的存在性、协议与角色名；或把 D-177 该条明确窄化为「仅对 CLI 入口生效」。**本轮只记录，不改代码。**

#### 5.1.5 禁止项复核

`.env` 已被 `.gitignore:6` 忽略（`.gitignore:9` 以 `!.env.example` 保留示例），`git ls-files` 只跟踪 `.env.example`——**仓库内无凭据泄露**。`.env.example` 只含本地占位值，并已注明「不用于公开部署」。

## 6. 重复执行与恢复

- 角色、迁移和已校验候选均支持重复入口检查；已执行迁移必须保持原校验和。
- 角色阶段完成、迁移失败：修正连接或兼容问题后重新运行同一入口；已成功迁移会按校验和跳过。
- 迁移完成、发布连接中断：先查询 V2 状态。`CANDIDATE` 可由同一入口继续；`VALIDATED` 会重新执行候选校验而不重复写入；`ACTIVE` 会重新校验并保持活动版本，`RETIRED` 只校验且不切换状态；`FAILED` 必须修正数据并创建新的版本化发布包，不能复用 V2。
- 发布完成、权限验证失败：不得激活。先修正新增迁移或权限，再从入口重复执行。
- 连接或命令提交结果不明确：报告只能记录“结果未知”，不得宣称回滚；通过只读状态查询确认后再决定重试。

本地 `pnpm verify:gate1:isolated` 仍是必需的隔离验收。公开 Neon 不是隔离测试环境，Neon PostgreSQL 18.6 的结果也不能替代本地 PostgreSQL 18.4 的回归；两者同属 PostgreSQL 18，但必须共同验证 `btree_gist` 可用、无 Neon 专有 API/扩展依赖以及迁移、发布、权限、查询和性能一致性。

## 7. 闸门一部署前检查清单（T7 盘点，2026-09-25）

本清单只做盘点，**未执行任何远程写、未创建任何云资源**。每项可直接转为后续任务。
「依据」列给出该约束的权威位置。

| #   | 检查项                         | 当前状态                        | 需用户授权        | 前置条件                                                                    | 验收标准                                                                                                                                                                            | 依据                                                                   |
| --- | ------------------------------ | ------------------------------- | ----------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | **重新冻结并独立批准工具 SHA** | **未开始（硬前置）**            | 是                | HEAD 确定；执行闭包 26 条路径无未提交改动；迁移与数据包校验和与冻结资产一致 | `docs/decisions.md` 记录新的工具 SHA 并标注「已批准」                                                                                                                               | 第 2 节；`docs/development-roadmap.md` §0 遗留项 8                     |
| 2   | Vercel 项目创建与六项人工核对  | 未开始                          | 是                | Team `logi-plan`、Project `logi-plan-web` 已存在                            | Team、Project、Root Directory `apps/web`、Framework Next.js、Node.js 24.x、Function Region `sin1` 六项逐项核对通过                                                                  | 第 1 节；D-147                                                         |
| 3   | Neon 区域、分支与端点核对      | 部分（2026-09-22 已做只读核对） | 只读可先做        | Neon 管理 API 只读凭据                                                      | 区域 `aws-ap-southeast-1`、分支 `main` / `br-patient-smoke-b3f5jtui`、endpoint `ep-empty-shape-b35qu1jv`、PostgreSQL 18.6 与冻结值一致                                              | 第 1 节、第 2 节；D-147                                                |
| 4   | 环境变量分层                   | 未开始                          | 是                | —                                                                           | Production **仅**含池化 `DATABASE_URL`（`app_reader`）；无 admin / migrator / publisher / Neon 管理凭据；Preview **不含** Production 的 `DATABASE_URL`                              | 第 1 节、第 5 节；`docs/development-roadmap.md` §1.1                   |
| 5   | `app_reader` 为唯一运行时角色  | 已具备本地机制证据              | 否                | —                                                                           | 公开运行环境只持有 `app_reader`                                                                                                                                                     | `docs/development-roadmap.md` §1.1                                     |
| 6   | Neon 池化只读连接              | 未开始                          | 是                | #2 完成                                                                     | Vercel 运行时使用池化只读连接；迁移与发布使用隔离管理直连，管理凭据不进入 Web 应用环境                                                                                              | `docs/development-roadmap.md` §1.1                                     |
| 7   | GitHub 秘密扫描启用与验证      | **未完成（既有缺口）**          | 是（仓库设置）    | GitHub 仓库管理权限                                                         | 秘密扫描已启用，且**有生效证据**（非仅配置）                                                                                                                                        | `docs/development-roadmap.md`（「仓库秘密扫描仍待启用并验证」）；D-178 |
| 8   | Dependabot 状态                | 未核实                          | 否（只读）        | —                                                                           | 状态明确（启用 / 未启用 / 不适用）并记录                                                                                                                                            | D-178                                                                  |
| 9   | 受保护 Production 工作流       | 未开始                          | 是                | —                                                                           | **人工批准**；绑定已通过检查的具体提交 SHA、迁移清单与数据包校验和；合并 `main` **不**自动发布公开测试环境                                                                          | D-178；`docs/development-roadmap.md` §1.1                              |
| 10  | Preview 隔离与 PR 分支配额     | 未开始                          | 是                | —                                                                           | Preview 只连隔离临时 Neon 分支；每 PR 最多 1 个 `preview-pr-<编号>`，并行上限 5；PR 合并/关闭后撤销连接并在 24 小时内删除；超额时保留 CI 但不创建预览数据库                         | `docs/development-roadmap.md` §1.1                                     |
| 11  | 外部 Fork PR 无密钥检查        | 未核实                          | 否（只读）        | —                                                                           | 持有 Neon / Vercel / 发布凭据的工作流**不**执行未受信任的外部代码                                                                                                                   | `docs/development-roadmap.md` §1.1                                     |
| 12  | 平台配额与降级行为             | 未核实                          | 否（只读）        | —                                                                           | Vercel Hobby 与 Neon Free 的免费额度、**冷启动**、**日志保留**、**告警缺口**逐项核实并记录；**不得宣称生产 SLA**                                                                    | `docs/development-roadmap.md` §1.1                                     |
| 13  | 跨环境一致性清单               | 未开始                          | 否（只读 + 本地） | —                                                                           | 共同验证 `btree_gist` 可用、无 Neon 专有 API/扩展依赖，以及迁移 / 发布 / 权限 / 查询 / 性能一致                                                                                     | 第 6 节末段                                                            |
| 14  | 公开发布顺序与回切路径         | 未开始                          | 是                | #1、#2                                                                      | 严格按「扩展迁移 → 候选数据校验 → 兼容应用部署 → 健康检查 → 原子激活 → 核心复验」执行；D-155 回切路径已确认（首次无旧发布时复验失败必须停止公开流量并修复，**不得伪造可回切版本**） | 第 5 节；D-154、D-155                                                  |

**盘点结论**：14 项中 **1 项已具备本地机制证据**（#5）、**1 项部分完成**（#3）、**1 项为硬前置且未开始**（#1）、**2 项为既有缺口**（#7 秘密扫描、#8 未核实）、**其余 9 项未开始**。清单中**没有任何一项**可以在不取得用户授权的前提下推进到执行阶段；#3、#8、#11、#12 为只读，可先行。

## 8. 平台配额、区域与降级行为核对（P3，2026-09-25）

本节把「免费额度的限制」从宣称变为核实。**未核实项一律标注，不得写成通过。**

### 8.1 仓库侧（已核实）

- `apps/web/vercel.json` 的全部内容为 `{"$schema": "https://openapi.vercel.sh/vercel.json", "regions": ["sin1"]}`——**只固定 Function 区域**，不创建项目、不修改 Vercel 设置、不注入环境变量。与第 1 节的声明一致。
- 受版本控制的文件 **480** 个（远低于 Vercel 的 15,000 文件/部署上限）。
- V2 数据包 `data/generated/logiplan-2026-demo-data-v2.json` 为 **9,178,251 字节（约 8.75 MiB）**。

### 8.2 官方文档（2026-09-25 查证，附来源）

**Vercel Hobby**（来源：`vercel.com/docs/limits`、`vercel.com/docs/functions/limitations`）：

| 项                                 | Hobby 值                                 |
| ---------------------------------- | ---------------------------------------- |
| Function 执行时长（Fluid compute） | 默认 **300 s**，最大 **300 s**           |
| Function 内存                      | **2 GB / 1 vCPU**（默认即最大）          |
| Bundle 大小（未压缩）              | **250 MB**（Python 500 MB）              |
| 构建步骤上限                       | **45 分钟**（全计划一致）                |
| 并发部署                           | **1**                                    |
| 每日部署数                         | **100**                                  |
| **运行时日志保留**                 | **1 小时**                               |
| 构建日志                           | 永久保留                                 |
| 代理请求超时                       | 120 s                                    |
| 环境变量                           | 每环境每项目 **1000** 条，合计 **64 KB** |
| 每部署路由数                       | 2048                                     |

**Neon Free**（来源：`neon.com/docs/introduction/plans`）：

| 项            | Free 值                              |
| ------------- | ------------------------------------ |
| 项目数        | 100                                  |
| 每项目分支数  | **10**                               |
| 计算          | **100 CU-hours / 项目 / 月**         |
| 存储          | **0.5 GB / 项目**                    |
| 公网传输      | **5 GB / 项目 / 月**                 |
| PITR 历史窗口 | **6 小时**（上限 1 GB-month 变更量） |
| **缩容到零**  | **闲置 5 分钟后挂起，Free 不可关闭** |
| 监控指标保留  | **1 天**                             |
| 手动快照      | 1                                    |
| 自动扩缩上限  | 2 CU（约 8 GB RAM）                  |

Free **不可用**：IP Allow（仅 Scale）、计划备份、指标/日志导出（Datadog/OTel）、支出通知、私有网络、Uptime SLA、合规认证、受保护分支、额外分支。

**超限行为**：CU-hours 或公网传输用尽 → 计算**挂起**至下一计费周期；存储超过 0.5 GB → 增加存储的操作（insert / update / delete）**失败**；分支数达 10 → 创建分支失败。三者均**不删除数据**。

### 8.3 关键缺口（真实发现，必须处理）

1. **Vercel Hobby 运行时日志仅保留 1 小时**，而 D-139 要求请求级查询日志保留 14 天、匿名聚合性能指标保留 90 天。**平台日志无法满足 D-139**，14 天明细与 90 天聚合必须另行实现并单独验收。此判断与 `docs/decisions.md:1651` 一致，本节补上确切数字。
2. **Neon Free 的监控指标仅保留 1 天**，同样低于 D-139 的 90 天匿名聚合要求。**90 天指标不能依赖 Neon 自带监控。**
3. **Neon Free 闲置 5 分钟即挂起且不可关闭** → 冷启动延迟不可避免；与 `docs/decisions.md:1649` 一致，**不得包装为生产级可用性**。
4. **Vercel Hobby 并发部署为 1** → PR 预览部署会串行。与「每 PR 最多 1 个预览分支、并行上限 5」的配额设计不直接冲突（Neon Free 允许 10 个分支，5 并行 + `main` = 6，余量足够），但**并发构建数为 1** 会成为实际吞吐瓶颈。

### 8.4 无冲突项（澄清，避免误读旧文档）

- **Function 执行时长 300 s ≫ 查询契约的 10 s 硬超时**：余量充足，不构成冲突。
- 注意**不要把「Hobby 默认 10 s / 最大 60 s」当作现状**：该值仅适用于 **2025-04-23 之前部署且未启用 Fluid compute** 的项目；当前新项目默认启用 Fluid compute，Hobby 为 300 s。

### 8.5 未核实（需 Vercel / Neon 账户访问，本节不得视为通过）

- Vercel 项目的实际 Function Region 是否确为 `sin1`（仓库侧 `vercel.json` 只表达意图）。
- Neon 项目的实际区域是否确为 `aws-ap-southeast-1`。
- 两个平台的**实际当前用量**与剩余额度（带宽、调用量、CU-hours、存储、egress）。
- **Vercel 侧的带宽与调用量免费额度具体数字**：官方 Limits 页**未给出**，仅指向 Fair Use Guidelines，需在账户内实测或另查。
- 实际冷启动延迟与连接延迟。
- 实际数据库占用大小 vs 0.5 GB 上限（依据数据包 8.75 MiB 估计远低于上限，但**未实测**）。

### 8.6 不适用

- Neon 的 **IP Allow**：本项目用最小权限角色（`app_reader` 等）而非 IP 白名单，Free 不提供该功能也不影响设计。
- Neon 的**合规认证**与 **Uptime SLA**：D-147 明确公开测试环境仅用于个人非商业演示，不宣称生产 SLA。

## 9. Neon 隔离性与跨环境一致性清单（P6，2026-09-25）

### 9.1 声明

**公开 Neon 不是隔离测试环境。** Neon PostgreSQL 18.6 的结果**不能替代**本地 PostgreSQL 18.4 的回归；两者同属 PostgreSQL 18，必须**共同**验证。本地 `pnpm verify:gate1:isolated` 仍是必需的隔离验收。

### 9.2 必须在两个环境共同验证的清单

| #   | 待验项                                    | 当前证据                                                                                                                                             | 状态                                      |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | `btree_gist` 可用                         | `0001_gate1_schema.sql:1` 创建该扩展，`:100` 有 `EXCLUDE USING gist` **实际使用**（不是仅创建）                                                      | 本地 18.4 与 CI 已验；**Neon 待验**       |
| 2   | 无 Neon 专有 API 或扩展依赖               | `packages/db` 仅依赖 `pg` 8.23.0 + `@types/pg` 8.23.1；全仓无 `@neondatabase/serverless` 或其他 Neon 驱动；唯一的 `CREATE EXTENSION` 是 `btree_gist` | **已核实（仓库侧）**                      |
| 3   | 迁移 0001—0010 从零执行                   | 本地 18.4 与 CI 已通过                                                                                                                               | **Neon 待验**                             |
| 4   | 数据发布（候选 → 校验 → 激活 → 幂等）     | 本地与 CI 已通过                                                                                                                                     | **Neon 待验**                             |
| 5   | 三角色权限基线成立                        | 本地与 CI 已通过（含 `CREATEROLE` 自动管理边）                                                                                                       | **Neon 待验**                             |
| 6   | 6 条查询计划 `temp_written_blocks` 全 0   | 本地与 CI 已通过                                                                                                                                     | **Neon 待验**                             |
| 7   | 热查询 P95 ≤ 1 s                          | 本地 p95 50.459 ms；CI 通过                                                                                                                          | **Neon 待验**（跨区域网络延迟需另计）     |
| 8   | **advisory 锁只走管理直连，不走池化端点** | 见第 9.3 节                                                                                                                                          | **已核实（仓库侧）**，Neon 实际连接串待验 |

### 9.3 第 8 项为什么关键（本清单里最容易被忽略的一项）

本项目使用**会话级** advisory 锁：

- `packages/db/src/migrate.ts:58` — `SELECT pg_advisory_lock(hashtextextended($1, 0))`
- `packages/db/src/publish-release.ts:117` — 同上
- `packages/db/src/activate-and-materialize.ts:33` — 同上
- 三处配套 `pg_advisory_unlock`；`transaction-outcome.ts:9` 的注释明确「关闭连接本身会释放**会话级**锁」。

Neon 的**池化端点**是 PgBouncer 事务模式：**不支持会话级 advisory 锁**，因为会话在事务之外不会固定到同一服务端连接，锁的持有与释放不可预期。

**本项目的设计已经把风险隔离**：advisory 锁只由**迁移、发布、激活**三个入口使用，而这三个入口按 `docs/neon-vercel-baseline-runbook.md` 第 1 节走**管理直连**；`app_reader` 的池化连接只做只读查询与 REPEATABLE READ 事务（事务模式下事务期间连接被固定，因此 REPEATABLE READ 成立）。仓库已有测试断言「管理和发布必须直连，运行角色必须池化」。

**因此部署时必须确认**：三个写入入口实际使用的连接串是**直连**而非池化。若误用池化端点，advisory 锁会**静默失效**——这是把「本地通过」误当成「Neon 通过」最可能的路径，且失效时不会报错。

## 10. GitHub 侧安全与发布治理（P5，2026-09-25）

本节只含**只读核查**与**设计稿**。任何仓库设置改动（启用秘密扫描等）属外部操作，需用户单独授权，本节**未执行**。

### 10.1 Dependabot 状态（已核实）

| 项                                                  | 状态             | 依据                                                                                                                                              |
| --------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/dependabot.yml` 配置文件                   | **存在且已配置** | npm 与 github-actions 两个生态，每周一，`open-pull-requests-limit: 5`                                                                             |
| Dependabot **告警**（vulnerability alerts）         | **已禁用**       | `GET /repos/jett3775/LogiPlan/vulnerability-alerts` → **404**                                                                                     |
| Dependabot **安全更新**（automated security fixes） | **已禁用**       | `GET .../automated-security-fixes` → `{"enabled": false, "paused": false}`；`security_and_analysis.dependabot_security_updates.status = disabled` |

**必须区分两件事**：`dependabot.yml` 只控制**版本更新**（按计划开 PR）；**告警**与**安全更新**是**仓库级设置**，与配置文件无关，当前**均为关闭**。因此现状是「会定期开版本升级 PR，但不会因已知漏洞告警或自动修复」。

### 10.2 秘密扫描状态（已核实，启用需授权）

`GET /repos/jett3775/LogiPlan` 的 `security_and_analysis` 四项**全部为 `disabled`**：

- `secret_scanning`（秘密扫描）
- `secret_scanning_push_protection`（推送保护）
- `secret_scanning_non_provider_patterns`（非供应商模式）
- `secret_scanning_validity_checks`（有效性校验）

仓库为 **public**（`fork: false`，默认分支 `main`）。**启用这四项属外部仓库设置操作，需用户单独授权**，本节未执行。这与 `docs/development-roadmap.md` 中「仓库秘密扫描仍待在外部 GitHub 仓库设置中启用并验证」的记录一致。

### 10.3 代码扫描（澄清，非缺口）

`GET .../code-scanning/default-setup` 返回 `{"state": "not-configured"}`，但这**不是缺口**：CodeQL 已在 `gate1.yml` 的 `codeql` job 中以 **advanced setup** 运行（`github/codeql-action/init` + `analyze`，`languages: javascript-typescript`），CI 中可见「CodeQL JavaScript and TypeScript」job 通过。默认设置未配置只是因为采用了工作流方式。

### 10.4 外部 Fork PR 安全性（已核实，结论：结构上安全）

| 检查                                                              | 结果                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 是否使用 `pull_request_target` 或 `workflow_run`（fork 提权风险） | **无**                                                                                                          |
| 工作流中 `secrets.` 引用次数                                      | **0 次**——即**没有任何工作流持有凭据**                                                                          |
| checkout 是否禁用凭据持久化                                       | 三处全部 `persist-credentials: false`                                                                           |
| 工作流级权限                                                      | `permissions: {contents: read}`（最小）                                                                         |
| job 级权限                                                        | `dependency-review`：`contents: read`；`codeql`：`contents: read` + `packages: read` + `security-events: write` |
| 第三方 action 是否固定 SHA                                        | **全部固定为 commit SHA**（非 tag）                                                                             |
| 触发条件                                                          | `pull_request`（全部）+ `push` 仅 `main`                                                                        |

**结论**：当前唯一的 workflow **不持有任何凭据**，且无 `pull_request_target`/`workflow_run`，因此外部 Fork PR **不可能触及密钥**——「外部 Fork PR 只运行无密钥检查」这一要求在结构上已经满足，而不是靠条件判断兜住。

### 10.5 受保护 Production 工作流（设计稿，**未实施**）

按 `docs/development-roadmap.md` §1.1 与 D-178 的要求，设计要点如下：

1. **触发**：仅 `workflow_dispatch` 手动触发；**不在 `main` 合并时自动发布**。
2. **人工批准**：使用 GitHub **Environment**（如 `production`）配置 required reviewers，job 声明 `environment: production`，未批准不进入执行。
3. **SHA 绑定**：输入参数 `approved_sha`，job 第一步断言 `github.sha == inputs.approved_sha`，不等即失败——**绑定已通过检查的具体提交**。
4. **迁移清单与数据包校验和绑定**：输入 `migrations_digest` 与 `release_package_sha256`，job 内用 `sha256sum` 复算并与输入比对，不等即失败。
5. **权限最小化**：`permissions: {contents: read}`；发布凭据（`PUBLISHER_DATABASE_URL`）只经 Environment secrets 注入，且**绝不进入任何由 PR 触发的 job**。
6. **发布顺序**：扩展迁移 → 候选数据校验 → 兼容应用部署 → 健康检查 → 原子激活 → 核心复验；任一阶段失败即停止。
7. **禁止项**：不让任何持有 Neon / Vercel / 发布凭据的工作流执行未经信任的外部代码。

**未实施原因**：需要 Vercel 与 Neon 凭据、Environment 配置以及受保护分支规则，**全部属外部设置操作**，需用户授权。

### 10.6 本轮发现的一处小缺口（P2，未修复）

`gate1.yml:88` 的 Playwright 产物凭据扫描列出了 `POSTGRES_SUPERUSER_PASSWORD`、`LOGIPLAN_SCHEMA_MIGRATOR_PASSWORD`、`LOGIPLAN_DATA_PUBLISHER_PASSWORD`、`LOGIPLAN_APP_READER_PASSWORD`，但**未包含对应的三个 `NEON_*_PASSWORD` 名字**。

由于同一行的 `postgresql://` 模式仍能捕获实际的连接串，风险较低；但若产物中出现裸的 `NEON_APP_READER_PASSWORD=<值>` 行，该扫描**不会捕获**。建议下一轮把 `NEON_SCHEMA_MIGRATOR_PASSWORD`、`NEON_DATA_PUBLISHER_PASSWORD`、`NEON_APP_READER_PASSWORD` 加入该列表——**属代码改动，需单独批准**。本节只记录，未修改。
