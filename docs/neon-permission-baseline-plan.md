# Neon 权限失败修复与基线验收执行计划

日期：2026-09-17

状态（2026-09-24，当前）：第三轮（`#418` 根因定位与最小修复）已在工作区完成。本轮完成：① 定位并修复 React 水合失败 `#418`——根因是 `apps/web/app/dashboard-workspace.tsx:509` 的 `<title>` 子节点数组长度为 5（React 不支持长度大于 1 的 `<title>` 子节点数组，服务端渲染为空 `<title></title>`），改为单个模板字符串，不改变可见文本与结构，经用户单独批准；② 证伪 2026-09-23 的两个候选（`loading.tsx` 的 Suspense fallback、`next-route-announcer`）并确认 `#418` 在 chromium-1440、chromium-1280、firefox-smoke 三个工程均出现，原「Firefox 独有」判断不成立；③ 2026-09-23 遗留项「`activate-and-materialize.ts` 仍吞 advisory unlock」由本轮重构关闭（`withInitializationCoordinationLock` 现经 `runWithConnectionCleanup(..., false)` 释放锁，解锁失败以 `SubsequentFailure` 上报并归入 `writeCommittedObservationFailed`），故「advisory unlock 不再被静默吞掉」现对迁移、发布、激活三个入口同时成立。本地验收：完整 Gate 1 **单次退出码 0**（生产构建完整通过、数据库集成四条腿 44/44、44/44、10/10、7/7 零 fail 零 skip、快照 28/28、Chromium 基础 10 passed / 22 skipped、Chromium 历史证据 22/22、Firefox 3/3、查询计划 `temp_written_blocks` 全 0、并发 5×100 热查询 p50 30.3ms / p95 74.5ms / p99 104.5ms、运行后无容器/卷/网络残留）；`pnpm test:db-integration` 独立执行一次同样四条腿零 fail 零 skip；`pnpm test` 14 文件 113 passed / 11 skipped，lint、typecheck（4 个 workspace）、prettier 退出码 0。独立审查（固定点 `bc5383d`）PASS、无 P0/P1、4 项 P2，按下述遗留项处理。**本轮计划要求 Gate 1 连续 5 次（5/5 退出码 0），已执行两批次（`0,0,0,1,1` 与 `0,0,0,0,1`，即 3/5 与 4/5），均未达成**——唯一失败是既有环境不稳定导致的 Windows 原生崩溃 `3221226505`（`0xC0000005`），两批次 10 次执行中 2 次、**零断言失败**。故本轮只记「代码侧验收全部通过」，不得记「Gate 1 稳定通过」。本轮**已执行**提交与推送（`68b9f11`、`8d94b63`，其后 CI 修复提交 `4ff4fb0`）与远程 CI。**CI 已转绿**：修复推送后 `ubuntu-latest` 上连续四次成功（`35984529953`、`35984592984`、`35985477229`、`35986663729`，最新一次 `headSha` = `27f9c8b`），三个 job（Gate 1 deterministic validation、Pull request dependency review、CodeQL JavaScript and TypeScript）全部 success——这同时证明 POSIX 进程组终止修复在 Linux 上正确。本轮未执行：Vercel 部署、数据激活、部署后复验。CI 失败的两个根因与修复详见 `docs/development-roadmap.md` 第 0 节「提交、推送与 CI 首次 Linux 执行」。

本轮（2026-09-24）记录、未修复的遗留项（含独立审查 4 项 P2）：

1. （P2，文档精度）`apps/web/tests/gate1.spec.ts:153-180` 的 `recordHydrationDomProbe` 未做环境变量门控：`LOGIPLAN_GATE1_TIMELINE_FILE` 未设置时仍执行两次页面内只读往返（`page.evaluate` 与 `getByRole(...).count()`）。它不写文件、不发网络请求、被 try/catch 包裹，不影响用例结果；但「未设置时零副作用」只对 `recordHydrationHtmlSnapshot`（`:190` 提前返回）成立，不适用于本函数。
2. （P2，覆盖）`packages/db/src/activate-release.test.ts:24-55` 未正面断言 `[WRITE_COMMITTED_OBSERVATION_FAILED]` → 退出码 1 的映射（仅 `:45` 反向断言）；该映射经 `migrate.test.ts:214`、`publish-release.test.ts:386` 间接覆盖，风险低。
3. （P2，既有）`packages/db/src/transaction-outcome.ts:250-271` 以 `hasPrimaryError ? primaryError : undefined` 传递主错误：`operation()` 抛出 falsy 值（`undefined`/`null`/`0`/`""`）时错误会被吞掉，或与清理失败叠加后被误报为 `writeCommittedObservationFailed`。非本轮改动，当前调用方均抛 `Error`，属潜在问题。
4. （P2，既有 + 本轮新相关）`packages/db/src/activate-release.ts:48-50` 的 `finally { await client.end() }` 在解锁失败已抛 `writeCommittedObservationFailed` 之后若自身再 reject，会替换带标志的错误并丢失前缀（退出码仍 1，不会变 75）。`finally` 为既有写法，本轮新增的分类使其首次具备可观测影响。
5. （P2，既有，非本轮引入）`pg` 弃用警告「Calling client.query() when the client is already executing a query」在 CLI、Web 服务端与测试中普遍出现；候选来源为 `packages/db/src/query-service.ts` 的并发 `pool.query()`（`:257` 2 条、`:1111` 6 条、`:1251` 3 条）配合 `packages/db/src/index.ts:4` 的 `max: 2`，`pg` 内部确切触发条件未确认。本轮重构的 `transaction-outcome.ts`、`activate-and-materialize.ts` 内所有 `client.query()` 均为顺序 `await`，未引入新并发。该警告是 `pg@9` 升级的阻塞项，属 D-183 兼容性闸门范围。
6. （既有环境不稳定，根因未定位，**本轮新增记录**）Gate 1 浏览器阶段偶发 Windows 原生崩溃 `3221226505`（`0xC0000005` = `STATUS_ACCESS_VIOLATION`）。2026-09-21、2026-09-22、2026-09-24 三轮均有记录；2026-09-24 两批次 10 次执行中 2 次（`Firefox 核心冒烟` 1 次、`Chromium 双视口历史证据验收` 1 次），崩溃率约 20%。共同特征：发生在浏览器阶段启动边界、无用例输出或 0ms 即失败、**零断言失败**、同一批用例在其余执行中通过。已排除用户浏览器负载（批次二运行期间 `firefox.exe` 计数为 0）与磁盘空间（系统盘剩余 434 GB）。**影响**：无法取得「连续 5/5」，Gate 1 不能记为稳定通过。**后续任务**：如需消除，应先采集 Windows 事件日志 / WER 崩溃转储以确认崩溃进程（需区分 Playwright worker 进程与浏览器进程），再评估浏览器启动参数类缓解措施；该类改动**超出本轮允许范围，须先取得用户单独批准**，且改动后需重跑完整验收。

7. （P2，覆盖缺口，**2026-09-24 同日新增**）`package.json` 第 19 行的 `pnpm lint` 清单缺少 `scripts/wait-for-server.mjs`（本轮修复的文件）与 `scripts/verify-gate1-isolated.test.mjs`（该修复的回归测试）两条路径，即被改动或新增的脚本可能不被 lint 覆盖。`package.json` 属既有计划的排除项，改动需用户批准（第一窗口计划 T3）。
8. （**写入模式硬前置**，2026-09-24 同日核实）`docs/neon-vercel-baseline-runbook.md:131` 冻结的候选 `0229755a097dff94c8de67954b36ab4f9412c0f5` 已落后 18 个提交（实测 `git rev-list --count 0229755a…..HEAD` = 18），而该 runbook 规定写入模式要求当前 HEAD 精确等于已批准的工具 SHA，故进入 `--write` 前必须重新冻结并独立批准新的工具 SHA（第一窗口计划 P1）。

上一轮（2026-09-23）状态：第二轮（事务语义与 Gate 1 稳定性）已在工作区完成本地实现、真实 PostgreSQL 回归与独立审查，**尚未提交**。本轮完成：① 三类写入结果契约（新增 `writeCommittedObservationFailed`，退出码仍为 0/1/75，既有取值含义不变）；② `migrate.ts` 与 `publish-release.ts` 的 advisory unlock 与 `client.end()` 各自独立尝试、失败可见；③ `markPublishFailedIfKnown` 改为可判定 COMMIT 的显式事务；④ 候选创建与校验写入之后的状态读取改走 `observeCommittedWrite`；⑤ 新增数据库集成入口 `pnpm test:db-integration`（18.4 与 18.6 各跑真实角色事务与 ACL，零 fail 零 skip），Gate 1 的三处脚本测试调用收敛到同一入口，执行闭包 25 → 26 条；⑥ Gate 1 定向重复模式与 JSONL 时间线埋点（Firefox 20/20、快照 20/20，未改动任何断言或超时值）；⑦ 宿主侧可达性探测吸收 Docker 端口转发的偶发 `ECONNRESET`。本地验收：完整 Gate 1 四批各 5 次＝20 次退出码 0（最后一批 5 次完整日志留存并逐项核对，前 15 次仅终端汇总行），每次四条腿 44/44、44/44、10/10、7/7 零 skip；覆盖率 95.51/87.5/95.96/95.66；eslint、`tsc -p packages/db`、prettier 均退出码 0。独立审查（固定点 `da0d769`）PASS、无 P0/P1、6 项 P2，全部按下述遗留项处理。**完成标准 1 的适用范围如实收窄**：「advisory unlock、`mark_failed` 与提交后读取失败不再被静默吞掉或错误归类」本轮只对**迁移与发布两个入口**成立，`activate-and-materialize.ts:59-63` 仍吞 advisory unlock。（**该限定已于 2026-09-24 轮次解除**：三个入口现已同时成立。）本轮未执行：推送、远程 CI、Vercel 部署、数据激活、部署后复验。

上一轮（2026-09-22）状态：第三次修复轮次已在最终代码上完成本地实现、真实 PostgreSQL 回归与独立审查。本轮完成交接文件 7 项阻滞中的 1—5 项代码修复，另加 ACL 断言口径修正与 PowerShell 入口编码修正；未再次连接 Neon、未推送、未激活远程发布、未部署。本轮修复已提交为 `245dc3017d2d5009844f7f4a35d07cab18bd0dba`（父提交 `06cccf2d855ff8355f0bbd73b61ee1f984bfc329`，14 个文件，加 619 行、减 130 行），分支相对 origin 领先 7；写模式前置检查已通过（HEAD 精确匹配、执行闭包 25 条路径无未提交改动、冻结候选资产 `0229755a…` 无改动、工作区仅剩 11 项约定排除资产）。工具 SHA 最终取 `e03d192ed023699e38df6bc8c12d8ca5cc54892d` 并经用户独立批准。完整命令、逐次 Gate 1 结果与失败现场见 `docs/neon-vercel-baseline-runbook.md` 第 0 节。

**远程执行结果（2026-09-22，由用户在本机终端完成）**：阶段 A 只读核查未命中任何停止条件，`latest_migration = 0010`、`release_status = VALIDATED`、`active_release = null`，迁移 0001—0010 与 V2 数据包校验和与本地冻结资产逐字一致，2026-09-21 的写入结果未知由此清账；随后两次 validate-only prepare（工具 SHA `e03d192ed023699e38df6bc8c12d8ca5cc54892d`，经用户独立批准；报告 `neon-baseline-report-20260922-1400.json` 与 `…-1405.json`，逐字节相同）均退出码 0 且达到 `status = prepared`、`last_completed_stage = permissions_verified`、`write_outcome = known`、`active_release_switch = false`。本任务终点已达成：Neon 准备完成、候选已校验、活动发布保持原状。Vercel 部署、数据激活、推送与远程 CI 仍未执行。

本轮实测：`NEON_BASELINE_TEST_DOCKER=1` 与 `postgres:18.6` 下三个脚本测试文件 57 passed、0 skipped、退出码 0；`postgres:18.4` 与 18.6 下 baseline + audit 均 50 passed、0 skipped；无 Docker 48 passed、2 skipped。计数口径更正：baseline 文件由 37 项增至 40 项（新增 1 项真实库 ACL 检查路径回归与 2 项报告路径测试），此前「Docker 46/46」「无 Docker 46 passed + 1 skipped」作废。项目级 `pnpm test` 95 passed、11 skipped，`pnpm test:coverage` 退出码 0（95.51% stmts / 87.5% branch / 95.66% lines），`pnpm lint`、`pnpm typecheck`、`pnpm build` 退出码 0。`pnpm verify:gate1:isolated` 执行 6 次：第 1、3 次退出码 1，第 2、4、5、6 次退出码 0（第 4、5、6 次连续正常退出）；两次失败分别位于 Firefox 核心冒烟与快照集成，均为轮询/等待超时类，根因未定位，**Gate 1 不得记为稳定通过**。

独立审查：2026-09-22 由独立只读子代理在固定点 `06cccf2` 判定 PASS、无 P0/P1、列出 6 项 P2；1 项按最小改动收紧（relation ACL 断言显式校验同一 relname 的关系类型一致），1 项按既有规则彻底关闭（`scripts/wait-for-server.mjs` 纳入 `executionClosurePaths`，闭包由 24 条增至 25 条，并删除 `neon-baseline.mjs` 内的重复进程树终止实现），其余为既有或文档精度问题。

本轮记录、未修复的遗留项（含独立审查 6 项 P2 与本轮新发现）：

1. `packages/db/src/activate-and-materialize.ts:59-63` 仍以 `catch(() => undefined)` 吞掉 advisory unlock 失败，与本轮修复的两个入口属同类残留；完成标准 1 因此只对迁移与发布入口成立（审查 P2-4）。（**已于 2026-09-24 轮次关闭**：`withInitializationCoordinationLock` 现经 `runWithConnectionCleanup(..., false)` 释放锁，解锁失败以 `SubsequentFailure` 上报并归入 `writeCommittedObservationFailed`，不再静默吞掉。）
2. `scripts/verify-gate1-isolated.mjs` 的定向快照重复只判子进程退出码、不解析 `tests`/`skipped`；目标用例若被跳过仍记通过（当前路径恒注入 `SNAPSHOT_TEST_*`，实际不触发）（P2-1）。
3. 数据库集成外层超时 900 秒与每腿 900 秒不一致（四条腿上界 3600 秒），外层超时会杀死入口并丢掉逐腿汇总（P2-2）。
4. `packages/db/src/transaction-outcome.ts:136-143/161-166`：主错误已带 `subsequentFailures` 时会被清理失败覆盖，观察失败仅留在 message 与 `cause`（P2-3）。
5. `packages/db/src/evidence-snapshot.test.ts:916-918` 的 `classifySnapshotFailure` 内 `await count()` 未包 try，抛错会替换带结论的错误（P2-5）。
6. `scripts/verify-gate1-isolated.mjs:31` 的注释称默认路径与既有「完全一致」已不实（步骤 5 已收敛入口、超时 420s → 900s）（P2-6）。
7. Firefox 每次迭代必现 React 水合失败 `#418`：**已于 2026-09-24 轮次定位并修复**。根因不是 `apps/web/app/loading.tsx` 的 Suspense fallback，而是 `apps/web/app/dashboard-workspace.tsx:509` 的 `<title>` 子节点数组长度为 5——React 不支持长度大于 1 的 `<title>` 子节点数组，服务端渲染为空 `<title></title>`，水合时按真实文本重建形成元素级不匹配；已改为单个模板字符串，不改变可见文本与结构。修复后生产 SSR 空 `<title>` 计数为 0（12/12 月度条形图标题文本正确），DEV 与生产 Firefox 的 `#418` 计数均为 0。根因与证据见 `docs/development-roadmap.md` 第 0 节。仍待单独决定：Firefox 冒烟目前只记录 `pageerror` 而不断言，是否改为「任何 pageerror 即失败」。
8. Gate 1 浏览器与快照的两次历史超时（2026-09-22 第 1、3 次）根因未定位；本轮 40 次定向复现零失败，余量分别为约 3 倍与约 14 倍，已排除「边缘超时」；另发现并吸收 Docker 端口转发的偶发 `ECONNRESET`（宿主侧可达性探测：≤12 次 × 250ms，失败时仍失败并报出镜像、容器、端口与末次错误码）。

本轮已关闭的遗留项：原遗留项 1（`migrate.ts`/`publish-release.ts` 吞 advisory unlock）与 2（候选 COMMIT 后读状态失败以退出码 1 结束）已在类3 契约下修复；原遗留项 3（真实 ACL 受门控）由 `pnpm test:db-integration` 入口加 Gate 1 收敛解决；原遗留项 5（ACL 容器泄漏）由入口的 finally 兜底清理覆盖。

上一轮（2026-09-21）状态：

本轮最新结果摘要：启用 `NEON_BASELINE_TEST_DOCKER=1` 与 `postgres:18.6` 时 `node --test scripts/neon-baseline.test.mjs scripts/neon-permission-audit.test.mjs` 为 46 passed、0 skipped（Neon baseline 36 + 权限 audit 10）；`pnpm test` 为 85 passed、11 skipped；`pnpm lint`、`pnpm typecheck`、`pnpm test:coverage`、`pnpm build` 退出码均为 0；`pnpm verify:gate1:isolated` 第二次执行退出码 0。全仓 `pnpm format:check` 仍因 `AGENTS.md` 与根目录 7 份 `neon-baseline-report-*.json` 共 8 个用户资产失败，本轮只做定向格式检查，未执行全仓 `prettier --write`。

保留为历史证据的结果：裸执行两个 Node 测试文件 41 项（40 passed、1 项 Docker 条件 skip）、PostgreSQL 18.6 定向验证 41/41、完整隔离 Gate 1 退出码 0（Neon baseline 31/31、权限 audit 10/10、本地 API 5/5、持久化证据 28/28、Chromium 双视口历史证据 22/22、Firefox 3/3，覆盖 PostgreSQL 18.4 迁移/V1/V2、发布幂等、三角色权限、axe serious/critical 与并发性能），以及 2026-09-20 的 audit 9/9、相关五文件格式检查通过与独立复查 PASS。上述结果均非本轮最新重跑。H1 仍仅为本地机制证据，未据此确认 Neon 根因。候选 SHA 固定为 `0229755a097dff94c8de67954b36ab4f9412c0f5`，新的 tooling SHA 待生成，不得用候选 SHA 或占位值冒充。

第二次返工轮次关闭了第一轮遗留的两个进程边界问题：P1 为 Node 入口最外层 `catch` 固定写 `process.exitCode = 1`、PowerShell 入口用 `throw` 覆盖原始退出码，导致未知写入结果无法以 75 传播；现由 `exitCodeForBaselineError` 与可注入的 `runCli` 统一映射退出码，PowerShell 入口保存并原样 `exit` Node 的退出码，并在 `finally` 中恢复环境变量与偏好设置。P2 为 `runProcess` 只按退出码 75 认定未知，137 等异常退出码、信号终止、超时及子进程启动后的异常 `error` 事件会被误判为 known_failed；现由单一纯函数 `isUnknownWriteProcessExit` 统一判定，错误对象保留 `childExitCode` 与 `childSignal`。两处均先写红灯测试再实现。第一轮成果继续有效：迁移与发布入口在 COMMIT/ROLLBACK 确认不明时以结构化 `writeOutcomeUnknown` 传播，只有回滚确认后才允许 known_failed，publish 在未知结果时不调用 `mark_data_release_failed`。

执行者变更：用户于 2026-09-21 明确取消原先冻结的“Luna High 实现 + Sol High 独立复查”安排，改由单一会话模型（DeepSeek V4.1 Flash）完成本轮的实现与验证，随后由独立只读子代理（全新上下文、无写入权限）完成复查。复查判定 PASS、无 P0/P1、列出 6 项 P2；其中 2 项代码问题（`runCli` 中 `parseArguments` 未纳入 `try`、`error` 事件未走统一判定函数）已修复并新增 1 项回归测试，其余 4 项为文档精度问题并已收窄描述。复查者标注的未验证项为：ps1 → 真实 Node 入口的 75 组合链路、真实 signal 退出、Docker `postgres:18.6` 的 46 passed、Gate 1 的 6 次执行结果与全部远程结论。该变更覆盖角色与模型名称，独立审查要求本身仍然有效；本轮状态为“本地实现、验证与独立复查均已完成”，远程操作仍须另行授权。

远程执行包待 tooling SHA 真实生成并独立批准后使用：固定目标、候选 SHA、预检、`validate-only` prepare、获批后的单次幂等复验和停止条件见 `docs/neon-vercel-baseline-runbook.md` 第 0、3、9 节。不得用占位 SHA、候选 SHA 或旧 HEAD 代替 tooling SHA。

适用执行者：原定 Luna High（`gpt-5.6-luna` / `high`）；2026-09-21 第二轮最小修复经用户明确变更执行者与复查者安排，改由单一会话模型完成实现与验证，第 0 节状态说明为准。

## 1. 目标、完成边界与执行角色

目标：确定 Neon 基线初始化的成员关系校验失败原因，完成必要的最小修复、真实 PostgreSQL 回归、独立审查和获授权的远程基线复验。

本任务的终点是 **Neon 准备完成，候选数据已校验，活动发布保持原状**。Vercel 部署、激活数据、远程 CI 和第一闸门整体关闭属于后续工作。不得用本任务成功替代这些验收。

本任务按 L2 管理。用户指定的 Luna High 作为主执行模型，覆盖仓库默认的实现模型选择，但不取消安全与验收要求：

- 主 Agent负责顺序控制、写入范围、用户授权、最终结论，以及获授权后的 Git 提交。
- 如委派实现，使用唯一 `slice_owner`，显式指定 `gpt-5.6-luna` / `high`，并只传递最小交接包；主 Agent同时停止源码写入。
- 实现者负责代码、首次测试和返工。独立审查沿用仓库的 `independent_auditor`（Sol High），只审查，不修改源码。
- 审查最多两轮修复—复查；第二轮仍失败时停止相关修改，提出一个明确决策问题及推荐答案。

完成条件必须全部满足：

1. 有远程脱敏只读证据、真实 PostgreSQL 复现和根因解释，能区分校验误判与实际越权。
2. 新的权限判定有正反向测试，且保留三角色隔离、对象 ACL、凭据隔离和候选保护。
3. 本地 L2 与阶段闸门验证通过，独立审查通过。
4. 修复后的执行包已提交，实际执行 HEAD、工具 SHA、独立批准工具 SHA 一致；原候选资产未变化。
5. 远程入口返回 `status=prepared`、`last_completed_stage=permissions_verified`；本次首次基线预期 V2 为 `VALIDATED`。
6. 执行前后实际查询的活动发布相同，`active_release_switch=false`，未部署 Vercel。
7. 正式 runbook 和路线图准确记录最终结果；未执行项如实列出。

## 2. 固定上下文与已知证据

启动时按顺序读取：`AGENTS.md`、`CONTEXT.md` 成本及证据定义、`docs/development-roadmap.md` 当前阶段、`docs/multi-agent-workflow.md` L2/审查/授权规则，再读本节列出的文件。无需重新访谈已经冻结的业务设计。

| 项目                  | 计划编制时的值                                 | 执行要求                            |
| --------------------- | ---------------------------------------------- | ----------------------------------- |
| 分支                  | `codex/gate1-delivery-baseline`                | 重新核查，不自动切分支              |
| 当前 HEAD             | `1603b51714f460a67151f3dadd8613bdaacf9ccd`     | 只作起点；本轮修复提交为 `104f4b0f` |
| 冻结候选              | `0229755a097dff94c8de67954b36ab4f9412c0f5`     | 保持不变                            |
| Neon 项目             | `logiplan-public-test` / `mute-mouse-49732061` | 管理 API 只读核对                   |
| Neon 分支             | `main` / `br-patient-smoke-b3f5jtui`           | 管理 API 只读核对                   |
| 数据库与 endpoint     | `neondb` / `ep-empty-shape-b35qu1jv`           | 不能只凭历史记录或连接成功确认      |
| 区域 / 远程数据库版本 | `aws-ap-southeast-1` / PostgreSQL `18.6`       | 实测不符即停止，不自动修改版本要求  |
| 本地完整回归版本      | PostgreSQL `18.4`                              | 保持既定版本                        |
| 候选数据包            | `LOGIPLAN_2026_DEMO_V2`                        | 不换包，不激活                      |

关键文件及阅读目的：

- `scripts/neon-baseline.mjs`：`assertRoleDefinitions`、`assertRolePrivilegeBaseline`、`bootstrapRoles`、`defaultPrepareDatabase`、`defaultGitPreflight`、`executionClosurePaths`、`runBaseline`。
- `scripts/neon-baseline.test.mjs`：角色创建集成测试、Docker 环境开关、事务失败、执行顺序、Git 保护、脱敏与报告测试。
- `scripts/neon-baseline.ps1`：隐藏凭据输入、批准 SHA、退出码和环境恢复。
- `packages/db/src/verify-schema.ts`：三角色实连、权限探针与受控证据函数；该命令含事务内写入探针，不是纯只读诊断。
- `docs/neon-vercel-baseline-runbook.md`：目标核对、准备操作、恢复规则。
- `docs/decisions.md`：D-148、D-149、D-154—156、D-176、D-187；最小权限与受控证据写入例外。
- `neon-baseline-report-20260916-185321.json`：最后成功阶段为 `candidate_validated`，错误为“三角色不得存在任何角色成员关系”，`write_outcome=known_failed`。

源码确认的执行顺序是：锁 → 三角色创建或检查 → 各角色身份检查 → 增量迁移 → V2 validate-only → 结构/精度/权限检查 → 最终成员关系及 ACL 检查 → 读取准备结果。最新报告说明迁移与候选校验阶段已返回成功，不能假定远程仍是空库，也不能把整次失败解释为所有阶段回滚。

已有测试用 `postgres` 超级用户创建三角色；现有成员关系 SQL 只取 `parent_role/member_role` 并要求零行。它没有区分成员方向、授予者和 ADMIN/INHERIT/SET 选项。这是已确认的覆盖缺口，尚不是远程根因结论。

## 3. 阶段 0：保护现场并建立工作范围

先运行以下只读命令，并在会话中记录结果；不另存逐次工作日志：

```bash
git status --short --branch
git log -8 --oneline
git rev-parse HEAD
node --version
pnpm --version
```

Node 必须为 `>=24.15.0 <25`，pnpm 使用仓库锁定版本。优先使用已有、已验证的原生 Windows 入口；只有确认 Node、Docker 和浏览器依赖可用时才使用 WSL。禁止为方便而升级工具链或改锁文件。

编制计划时已有用户改动：`AGENTS.md` 修改、一个名称异常的 tracked 文件删除、7 份未跟踪 Neon 报告。以执行当时 `git status` 为准；不得覆盖、清理、暂存或提交这些用户资产。也不得整体运行格式写入命令修复它们。

建议 write_scope：

| 文件                                             | 允许修改内容                                          |
| ------------------------------------------------ | ----------------------------------------------------- |
| `scripts/neon-baseline.mjs`                      | 成员关系采集/判定、必要的检查时机和脱敏诊断、执行闭包 |
| `scripts/neon-baseline.test.mjs`                 | 真实非超级用户复现、正反向权限回归、重复执行          |
| `scripts/neon-permission-audit.mjs`（新增）      | 独立只读诊断入口，详见阶段 2                          |
| `scripts/neon-permission-audit.test.mjs`（新增） | 只读性、目标检查、输出与脱敏测试                      |
| `scripts/neon-baseline.ps1`                      | 仅在确需支持同等安全的诊断输入时修改                  |
| `scripts/verify-gate1-isolated.mjs`              | 必要时纳入新增测试；保持已有隔离与清理边界            |
| 根 `package.json`                                | 必要时仅调整脚本的测试/lint 入口，不改依赖            |
| `docs/neon-vercel-baseline-runbook.md`           | 写入经证实的权限规则、命令和恢复分支                  |
| `docs/development-roadmap.md`                    | 完成后记录本任务结果，保留 Gate 1 未完成项            |
| 本计划                                           | 修正已验证的不准确步骤，不写过程聊天                  |

默认只读范围：`database/migrations`、`database/releases`、`data/generated`、数据生成脚本、锁文件、Web 业务代码、领域计算和查询契约。历史迁移不得改写。需要扩大范围时先交给主 Agent重新评估；涉及冻结资产或权限实质扩大时提出具体取舍，不能顺手处理。

完成标准：确认工具链、用户资产、唯一源码写入者和 write_scope。未获远程授权时继续完成本地复现和诊断工具，不使用真实凭据。

## 4. 阶段 1：建立真实、可失败的本地复现

先运行已有 Node 测试，确认现状：

```bash
node --test scripts/neon-baseline.test.mjs
```

此文件使用 `node:test`；仅运行 `pnpm test` 不足以证明该文件通过。其 Docker 集成部分由 `NEON_BASELINE_TEST_DOCKER=1` 启用，普通命令中的跳过必须单列。

在现有独立容器测试框架内增加以下复现。容器只绑定 loopback，随机名称/密码，退出时仅删除本测试创建的容器；不得使用持久 Compose 数据库。

1. 由本地超级用户创建一个 `LOGIN CREATEROLE NOSUPERUSER` 的管理角色，并使其拥有测试数据库；用新的独立连接以此角色登录。不要继续用超级用户调用创建函数。
2. 管理角色的 `createrole_self_grant` 设为本地会话空值，构造标准 PostgreSQL 行为；其余高权限属性保持关闭。
3. 使用真实 `executeRoleBootstrapTransaction` 创建三角色。必要时只导出既有检查函数供测试调用，尚不改变权限判定。
4. 查询成员关系，确认自动产生的管理关系方向及选项；调用真实 `assertRoleDefinitions`，复现同一错误文本。
5. 写一个表达正确预期的回归用例：标准管理关系应被按规则接受。修复前必须看到该用例失败；另保留对旧错误触发路径的证据。
6. 增加超级用户创建的零成员关系对照，不把某个宿主机角色名写死为唯一正确值。

本地快速复现命令应收敛到一个 Node 测试入口，例如：

```bash
NEON_BASELINE_TEST_DOCKER=1 node --test scripts/neon-baseline.test.mjs
```

PowerShell 使用进程环境设置同名开关后运行，再恢复原值；Bash 语法不能原样粘贴到 PowerShell。

完成标准：记录已实际运行的命令、错误和测试结果；同一真实路径能红、修复后能绿。若标准路径未复现，保持旧判定，先缩小差异再继续，不以 mock 行代替数据库机制验证。

## 5. 阶段 2：准备只读诊断并取得远程事实

### 5.1 独立诊断入口

新增 `scripts/neon-permission-audit.mjs`，复用现有 pg 依赖和可安全复用的目标/URL 检查；不要通过 `--write` 路径取得诊断信息。默认 `--help` 或缺少必要参数时不连接。入口只接受已核对的非秘密目标参数，秘密只来自进程环境。

要求：

- 远程只使用既有管理直连；读取迁移或发布状态权限不足时，可使用已获授权的 migrator/publisher 连接，不临时扩大 admin 权限。
- 通过 `BEGIN READ ONLY`、短 `statement_timeout` 和最终 `ROLLBACK` 读取系统目录与版本元数据；所有 SQL 固定或参数化。
- 不运行迁移、发布、权限写入探针、SECURITY DEFINER 写函数，不执行 CREATE/GRANT/REVOKE/ALTER/SET ROLE。
- 不读取 `pg_authid.rolpassword`、业务明细、完整环境变量、完整角色配置内容、完整连接串或服务端日志。
- 输出只包含本节允许的元数据；URL、密码及其编码形式始终脱敏。成功时仅向 stdout 输出一个脱敏 JSON 对象和换行，不创建文件或目录；失败时仅向 stderr 输出脱敏错误并返回非零退出码。
- 测试证明：导入模块不会连接；错误目标会在连接前失败；只读事务始终结束；输出不含测试凭据；不触发任何写入依赖。

完成后先审查诊断入口和精确命令，再请求缺失的远程只读授权。仓库规则要求使用真实密钥和外部账户前有授权；本次“制定计划”不是该授权。若后续会话已授权同一目标的只读核查，不重复询问。

建议授权问题：是否允许使用现有本机凭据，对本计划固定 Neon 项目/分支执行管理 API GET 与只读 SQL，仅读取身份、成员关系、权限和发布元数据？推荐允许；不包含数据库写入或密钥变更。无需在聊天中提交凭据。

### 5.2 身份与状态采集

先按既有 runbook 调用 Neon 管理 API，只读核对项目、分支、数据库列表、区域和 `read_write` endpoint 归属。对输出进行字段过滤；不查询返回密码的接口。

随后收集：

1. `current_user`、`session_user`、`current_database()`、`server_version_num`、`createrole_self_grant`。
2. 三角色与管理角色的 OID、名称、SUPERUSER/CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS/LOGIN/INHERIT 标志；过期/配置仅输出既有基线所需的布尔值和数量。
3. 下方 SQL 返回的所有关系，不按预期只保留“好关系”。
4. 三角色有效数据库/schema 权限；必要时读取针对项目对象的既有 ACL/所有权摘要。关系来源不明确时保留失败，不扩展允许名单。
5. 先用 `to_regclass` 判断对象存在，再单独查询迁移版本及校验和、V2 状态及数据包校验和、当前活动发布 ID。对象不存在要记录为不存在，不能用会在解析时引用缺失表的 SQL 假装容错。

成员关系核心 SQL（由 pg 传 `$1` 为三角色字符串数组）：

```sql
SELECT m.roleid AS parent_oid, parent.rolname AS parent_role,
       m.member AS member_oid, member.rolname AS member_role,
       m.grantor AS grantor_oid, grantor.rolname AS grantor_role,
       grantor.rolsuper AS grantor_is_superuser,
       m.admin_option, m.inherit_option, m.set_option
FROM pg_auth_members AS m
JOIN pg_roles AS parent ON parent.oid = m.roleid
JOIN pg_roles AS member ON member.oid = m.member
LEFT JOIN pg_roles AS grantor ON grantor.oid = m.grantor
WHERE parent.rolname = ANY($1::text[])
   OR member.rolname = ANY($1::text[])
ORDER BY parent.rolname, member.rolname, m.grantor;
```

语义：`parent_role` 是被授予的角色，`member_role` 是获得该角色成员资格的一方。`parent=schema_migrator, member=neondb_owner` 与相反方向含义完全不同。

完成标准：实际目标已确认；每条成员关系包含方向、授予者和三个选项；当前迁移、V2 和活动发布状态可解释。无法取得状态时标记未知，不推断为空，不重跑写入口“试试看”。

## 6. 阶段 3：判定原因并按分支处理

本节是待验证假设，不能提前写入最终根因：

| 假设                                           | 可证伪预测                                                                                                    | 处理                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| H1：标准 CREATEROLE 自动管理关系被零行规则误拒 | 三角色作为 parent，已验证 admin 作为 member；ADMIN=true、INHERIT=false、SET=false；本地非超级用户路径同样产生 | 实施下节的窄范围校验修复                                                                |
| H2：三角色获得了其他角色能力或被额外账号持有   | 存在以三角色为 member 的边，或非预期 member 持有三角色，或权限选项偏离                                        | 保持拒绝，形成逐条权限修复提案；远程 REVOKE/ALTER 需针对实际差异单独授权                |
| H3：自动授予配置/平台行为改变了选项或来源      | `createrole_self_grant`、grantor 或选项与标准复现不符                                                         | 补对应本地实验及官方依据；不能因“Neon 自动产生”而放行；需要新权限规则时提交一个明确决策 |
| H4：目标或历史现场不同                         | 项目、分支、endpoint、数据库、角色属性、迁移/包校验和不匹配                                                   | 停止写入，核实目标；禁止删除并重建来消除差异                                            |

H1 修复的推荐判定规则：

1. 三角色作为 `member_role` 的任何边均拒绝，包括三角色互相授予、加入 owner、`neon_superuser`、`pg_read_all_data` 或其他组。零成员关系仍可接受。
2. 三角色作为 `parent_role` 时，仅允许 member 精确等于已验证的当前管理身份；当前远程固定身份为 `neondb_owner`。不能把任何带 admin 字样的名称当管理员。
3. 允许关系须满足 `admin_option === true`、`inherit_option === false`、`set_option === false`；缺字段、非布尔类型均拒绝。
4. PostgreSQL 18 官方源码把 bootstrap superuser 固定为 OID `10`。H1 的推荐严格规则是 `grantor_oid=10` 且对应 `pg_roles.rolsuper=true`，并经本地真实复现、远程只读结果确认；常量须附官方源码依据。授予者缺失、OID/属性不同均进入 H3，不自动放宽。不能仅凭可改名的角色名称、任意 SUPERUSER 标志或“刚刚观察到”建立信任名单。
5. 每一行均须满足规则；检查多 grantor、额外关系和重复输入，不能找到一条正确关系就忽略其他行。
6. 三角色属性、数据库/schema/表/函数/默认 ACL、对象所有权和 D-187 受控证据函数要求继续全部验证。

这条例外承认既有可信管理角色的角色管理权，不是声称其永远无法访问业务角色。拥有 ADMIN 的管理角色可以进一步授予权限；安全边界仍是该凭据受控、业务角色没有反向提权路径、Web 仅持有 app_reader。

H1 不需要远程删除自动管理关系，不修改三角色密码，不赋予 app_reader 写表、DDL 或角色管理权限。若实际选项并非严格默认组合，Luna 不得自行将它们加入允许名单以追求通过。

实现建议：在既有脚本中抽取纯函数 `validateRoleMemberships(rows, context)`，由 `assertRoleDefinitions` 调用，SQL 增加所需字段。新增角色路径也应在角色创建事务提交前调用同一检查（已创建角色对当前事务可见），使异常在首次初始化时尽早失败；已有角色路径和最终权限路径保持同样规则。保留事务失败分类，不能把提交结果未知改成成功或已回滚。

完成标准：一张“实际关系 → 适用规则 → 接受/拒绝理由”的脱敏对照表；H1/H2/H3/H4 由证据定性；修复只处理被证实的原因。

## 7. 阶段 4：测试矩阵与本地验收

### 7.1 必须覆盖的行为

| 类别         | 用例                                                  | 预期                                        |
| ------------ | ----------------------------------------------------- | ------------------------------------------- |
| 兼容         | 超级用户创建，无成员边                                | 接受                                        |
| 正常         | 非超级用户创建，三条精确标准管理边                    | 接受，首次创建和重复检查均成立              |
| 反向越权     | reader 成为 migrator/publisher/admin/其他组成员       | 拒绝                                        |
| 暴露业务角色 | 其他登录角色或 NOLOGIN 组获得三角色之一               | 拒绝                                        |
| 权限选项     | 允许边的 SET=true 或 INHERIT=true；ADMIN=false        | 拒绝                                        |
| 证据不完整   | 缺失字段、错误类型、未知/不匹配 grantor、额外 grantor | 拒绝                                        |
| 混合输入     | 一条合法边加任意非法边                                | 整体拒绝                                    |
| 原有约束     | 属性、所有权、对象 ACL 或默认 ACL 偏离                | 仍拒绝                                      |
| 原子性       | 新建事务中检查失败                                    | 本事务角色/授权未提交；提交确认丢失仍记未知 |
| 幂等         | 既有三角色、既有 VALIDATED V2 重复执行                | 不改密码、不重复导入、不激活                |
| 资产保护     | 工具 SHA/批准 SHA/闭包漂移、候选资产变化              | 连接或写入前拒绝                            |
| 只读诊断     | 读事务、目标失败、模块导入、脱敏                      | 无写入，无凭据输出                          |

真实集成测试至少覆盖：超级用户对照、非超级用户标准创建、用真实 GRANT 形成的危险方向和 SET/INHERIT 反例、首次及重复检查、错误回滚。所有构造危险权限的 SQL 只用于独立临时数据库。

运行真实复现于 PostgreSQL 18.4，并在单独临时容器补 18.6 定向验证；可给测试容器增加只接受 `18.4`/`18.6` 的版本选项，默认仍为 18.4，不修改 Compose 的冻结版本。正式 Neon 18.6 仍须独立验收。

### 7.2 执行顺序

逐条运行，保留退出码。独立检查可并行；同一数据库写入测试与清理顺序执行：

```bash
node --test scripts/neon-baseline.test.mjs scripts/neon-permission-audit.test.mjs
# 数据库集成验收：PostgreSQL 18.4 与 18.6 的真实角色事务与 ACL 查询；要求零 fail，且 skipped 精确等于显式声明的平台门控跳过数
pnpm test:db-integration
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm verify:gate1:isolated
```

执行前按实际源码确认 `verify:gate1:isolated` 已包含真实角色测试、完整 PostgreSQL 验证、Chromium 两档、历史证据、Firefox、axe 与性能检查；缺少新增的测试入口则补入明确调用。独立 Node 测试不会因为 Vitest 覆盖率通过而自动计入通过。

新脚本加入 lint 与执行闭包；更新 `executionClosurePaths` 时检查被加载的项目文件，不能以新增外部 helper 绕过工具 SHA 保护。根依赖和锁文件保持不变。

若用户原有未提交文件导致全仓格式检查失败，明确区分已有问题与本任务问题。可在临时目录从固定 Git 对象重建，只应用本任务差异进行验证；不能修整用户文件，也不能把含已知失败的原工作区表述为全绿。冻结依赖安装不得修改锁文件。

完成标准：上述实际适用检查全部通过；必需数据库/浏览器项无环境原因跳过；临时容器、网络和卷已清理；验收对应明确代码版本。无新增代码变化或新风险时，不重复整套验证。

## 8. 阶段 5：独立审查、固定执行包与授权

把最小交接包提交 `independent_auditor`：目标、修改文件、远程关系摘要、被证实的原因、规则、测试结果/跳过、候选资产差异、现存用户改动和剩余风险。

重点审查：

- 是否把成员方向解释反了，或把 admin 管理业务角色误当成业务角色继承 admin。
- 是否通过新增例外扩大三角色实际权限，是否遗漏额外 grantor 或成员边。
- 测试是否真实调用生产校验函数，并走非超级用户连接路径。
- `assertRoleDefinitions` 与完整 `assertRolePrivilegeBaseline` 是否持续执行；H1 修复没有跳过对象权限检查。
- 诊断工具是否纯只读，报告是否可能含密钥，未知提交状态是否准确。
- 新 helper、脚本、测试是否纳入需要的执行闭包和验收入口。

审查通过后固定执行包：

1. 只有主 Agent在用户已明确允许本地提交时，逐项暂存本任务文件并检查 staged diff；子 Agent不得提交。不推送，不夹带用户改动。
2. 获取新的 40 位 `TOOLING_SHA`。需要修改源码才能通过复验时，产生新 SHA，旧批准不沿用。
3. 核查冻结候选资产与 `0229755a097dff94c8de67954b36ab4f9412c0f5` 一致，完整执行闭包无未提交改动。
4. 针对已提交 SHA 进行干净重建的工具测试/安装或确认前序完整验收与提交树一致；不把受污染工作区结果绑定到不同树。
5. 提供具体写入包：目标项目/分支/数据库、候选 SHA、新工具 SHA、通过的测试/审查、预计 SQL 影响、报告位置和失败停止条件，再请求所缺授权。

推荐授权内容：允许指定工具 SHA 在固定 Neon 目标执行一次准备入口，并在首次成功且状态符合预期后，再执行一次相同入口验证幂等；允许随后的只读状态核查；不授权数据激活、Vercel 操作、密码变更、角色删除或额外 GRANT/REVOKE。若 H2 需要权限修复，必须先提供具体 SQL、对象、影响与恢复方法，取得与该 SQL 对应的授权。

已有同范围、同 SHA 授权时直接继续。不得由脚本把当前 HEAD 自动写入“独立批准 SHA”。用户批准的是具体执行包，不能以“批准了计划”替代。

修复后的 HEAD 可以通过显式 `--tooling-sha` 执行现有离线预检；仅在省略该参数时，非写入预检才要求 HEAD 等于原候选 SHA。无需新增预检能力，也无需回退分支。示例：

```bash
pnpm neon:baseline -- \
  --candidate-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --approved-sha 0229755a097dff94c8de67954b36ab4f9412c0f5 \
  --tooling-sha "$LOGIPLAN_TOOLING_SHA" \
  --expected-database neondb
```

仅在 `$LOGIPLAN_TOOLING_SHA` 已被真实生成并独立批准、且与批准值一致时执行；变量为空或格式不符时停止。

该模式不读取凭据、不连接 Neon，也不检查执行闭包是否干净；因此它的成功不能替代步骤 3 的闭包核查。写入入口仍须再次验证工具批准 SHA、实际 HEAD 和完整闭包。

## 9. 阶段 6：远程准备、幂等复验与停止规则

### 9.1 写入前

再次核对目标身份、迁移/包校验和、V2 和活动发布状态，记录脱敏前值。恢复分支：

| 实际状态                                                    | 行动                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| 三角色齐全、迁移一致、V2 为 VALIDATED、活动发布符合批准前值 | 复核并继续，不重建角色或重设密码                           |
| V2 缺失或为 CANDIDATE                                       | 仅在本次授权明确覆盖候选导入/继续发布且没有其他异常时继续  |
| V2 为 ACTIVE 或 RETIRED                                     | 与本次首次准备预期不同；暂停核对新的现场，不自动切换或退役 |
| V2 为 FAILED                                                | 停止；不能复用 V2、删除失败行或改历史包“修复”              |
| 三角色只有一部分、校验和漂移、身份不符                      | 停止，报告具体差异                                         |
| 状态未知或无法读取                                          | 只读复核；不得盲目重试写操作                               |

使用 runbook 的隐藏输入入口；凭据不放在命令参数、聊天或文件中。已有 URL 参数错误时，说明当前允许规则并在本机安全构造正确 URL，不打印原值，也不放宽 endpoint/身份/SSL 检查。

### 9.2 执行模板

以下 PowerShell 模板中的工具 SHA 必须换成已经独立批准的精确值；报告使用新的临时文件名。目标环境变量按 runbook 配置，移除会影响写入口的遗留 `MIGRATION_DIRECTORY`、`RELEASE_MANIFEST`、`LOGIPLAN_PUBLISH_MODE`、`NODE_OPTIONS`、`NODE_PATH`，但保存并在结束后恢复原环境。

```powershell
$toolingSha = $env:LOGIPLAN_TOOLING_SHA
$approvedToolingSha = $env:LOGIPLAN_APPROVED_TOOLING_SHA
if ($toolingSha -notmatch '^[0-9a-f]{40}$' -or $approvedToolingSha -notmatch '^[0-9a-f]{40}$') {
  throw "必须先提供已生成且已批准的真实 tooling SHA；当前不可执行远程 prepare"
}
$reportPath = Join-Path $env:TEMP ("logiplan-neon-" + [guid]::NewGuid().ToString("N") + ".json")

./scripts/neon-baseline.ps1 `
  -CandidateSha 0229755a097dff94c8de67954b36ab4f9412c0f5 `
  -ApprovedSha 0229755a097dff94c8de67954b36ab4f9412c0f5 `
  -ToolingSha $toolingSha `
  -ApprovedToolingSha $approvedToolingSha `
  -ExpectedDatabase neondb `
  -Write `
  -Report $reportPath
```

该入口明确以 `validate-only` 发布，并执行权限验证；不要在旁边单独运行默认会激活数据的 `pnpm db:publish`。

### 9.3 首次成功后的核验

只有退出成功且报告/实际状态一致时才能继续：

- 报告 `status=prepared`、`mode=prepare`、`write_outcome=known`、`last_completed_stage=permissions_verified`。
- 候选、工具、批准工具、实际 HEAD 符合要求；资产和闭包检查为 true。
- 三角色属性、成员规则、对象权限、结构、精度及受控证据函数验证通过；最高迁移 `0010`，全部已应用迁移校验和与候选一致。
- V2 实测为 `VALIDATED`，数据包校验和正确；当前活动发布与执行前相同。
- `active_release_switch=false` 只是脚本声明，还必须用前后实际状态证明未切换。
- 目标身份由管理 API 独立核实；不能把脚本中的 `independently_verified_by_this_entry=false` 改为 true 冒充脚本自证。

若已获幂等复验授权，换一个新报告路径执行第二次同一入口。对比角色定义/成员/对象权限、迁移数量及校验和、V2 行数与内容校验和、活动发布；允许正常校验时间更新，不要求全部元数据字节相同。不读取远程密码哈希，已有密码不变由代码路径和本地回归证明。

首次失败就停止该次写入，不进入第二次幂等调用。权限失败不自动降级为警告。网络中断或提交确认丢失只读复核，不声称回滚；修复或重试需符合已有授权范围，代码 SHA 改变后重新批准。

远程准备期间不运行 `db:activate-release`、`db:verify-release`、`db:verify-plans` 或页面查询：本目标只有 V2，尚未激活；这些命令的前提属于其他验收阶段。数据库完整升级、查询计划、API 和浏览器路径由本地隔离 Gate 1 覆盖。

完成标准：首次与获授权的第二次准备均成功，实际状态满足全部不变量，未改变活动发布。若只能完成本地修复，结论只能是“本地修复通过，远程基线待验收”。

## 10. 阶段 7：正式记录与交付

更新 runbook：解释实际根因、管理关系与提权方向的区别、严格允许条件、诊断入口、审批方式和恢复分支。若只是修正实现以符合 D-149，不把早期决策改写为已经允许任意成员关系。

更新路线图：写入执行日期、实际工具 SHA、候选 SHA、数据库版本、验收摘要和本任务边界。明确“Neon 准备通过，未激活、未部署；远程 CI/公开部署复验仍待完成”。

CLI 不持久化逐次诊断报告或包含凭据的输出；正式文档只保留脱敏证据摘要及可核查的最终结论。如获准提交收尾文档，由主 Agent单独提交；不要把事后文档提交 SHA 冒充实际运行过的工具 SHA。

最终交付必须包含：

1. 根因与证据，不超过三句话。
2. 修改文件及权限规则变化。
3. 真实执行的测试、跳过/失败项、独立审查结果。
4. 候选 SHA、实际工具 SHA、批准 SHA 与远程前后状态。
5. 是否达到本计划终点；下一项工作仅指向部署/激活等后续独立步骤。

## 官方依据与使用限制

以下资料已于计划编制时核查。它们支持排查方向，不证明当前远程实例的具体状态：

- [PostgreSQL 18：Role Attributes](https://www.postgresql.org/docs/18/role-attributes.html)：非超级用户 CREATEROLE 创建角色时，创建者会取得 ADMIN 管理关系；默认不继承且不能 SET ROLE。它仍是可信管理权限，不能据此声称管理员无法提升访问能力。
- [PostgreSQL 18：pg_auth_members](https://www.postgresql.org/docs/18/catalog-pg-auth-members.html)：成员方向、grantor、ADMIN/INHERIT/SET 字段定义。
- [PostgreSQL 18 分支：pg_authid.dat](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/include/catalog/pg_authid.dat) 与 [CreateRole 源码](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/commands/user.c)：bootstrap superuser 的 OID 为 10；用作上述严格 grantor 核验的实现依据，不把其可变名称写死。
- [PostgreSQL 18：createrole_self_grant](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-CREATEROLE-SELF-GRANT)：非空设置可增加 INHERIT/SET 自动授予，必须与严格默认情形区别处理。
- [Neon 官方角色文档源文件](https://raw.githubusercontent.com/neondatabase/website/main/content/docs/manage/roles.md)：控制台/API/CLI 创建角色与 SQL 创建角色的权限边界不同；不能为了通过检查把业务角色加入 neon_superuser，也不能修改平台内部角色。
