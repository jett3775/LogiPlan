# LogiPlan AI 开发阶段与扩展路线

版本：V1.1
日期：2026-08-18
依据：`docs/product-baseline.md`、`docs/decisions.md`

## 1. 当前阶段

第一阶段“业务模型冻结”已经完成，并通过数据字典、归因方法、小样本测试夹具、恒等式验证和跨文档一致性检查。

项目于 2026-08-14 进入第二阶段“全年演示数据与评估基线”。当前已经按 D-092 人工拆分口径生成 2026 年 Budget、1—8 月 Actual、9—12 月 Forecast、Base / Growth / Cost Saving 情景数据、20 题固定中文 AI 评估集、结构化审计基线和可审计工作簿。正式页面尚未开发。

第二阶段数据基线已经完成。第三阶段按 D-093 推进“全年 Latest Outlook 异常 → 2026 年 8 月英国下钻 → 五因素归因 → 数字级证据 → AI 管理分析”的核心纵向切片。方案 B 桌面原型已通过 D-124 验收，查询与证据契约已按 D-125 冻结为 V1.0，当前进入正式 Next.js 实现准备；该切片实现并验收通过后，再扩展 Forecast 和情景模拟。

## 0. 2026-09-24 轮次：`#418` 根因定位与最小修复

本轮处理 2026-09-23 遗留项 ①（Firefox 每次迭代必现 React 水合失败 `#418`），给出确定性结论并应用最小修复（改动 `apps/web`，经用户单独批准）。全部改动已提交为 `68b9f11`（`fix(db,web)`，8 文件 +382/−84）与 `8d94b63`（`docs(round3)`，3 文件 +105/−9）并已推送至 `codex/gate1-delivery-baseline`（`0229755..8d94b63`）；未触碰 Neon、未部署 Vercel、未激活数据发布。提交后的 CI 执行与两处修复见本节末「提交、推送与 CI 首次 Linux 执行」。

**根因（已证）**：`apps/web/app/dashboard-workspace.tsx:509` 的月度趋势条形图把 `<title>` 的子节点写成 5 个相邻表达式（`{month.month_id}`、空格、`{month.series_type}`、空格、`{formatMoney(...)}`）。React 对 `<title>` 的子节点有类型限制：子节点数组长度大于 1 时不受支持，服务端渲染为**空** `<title></title>`，客户端水合时按真实文本重建，形成元素级不匹配并报 `#418`。`args[]=HTML` 中的 `HTML` 是 `fromText === false` 的固定字面量，并非名为 HTML 的标签，此前的「元素级不匹配」方向正确但落点有误。

排查中证伪两个候选：`apps/web/app/loading.tsx` 的 Suspense fallback（`#418` 出现在 `first_document_loaded` 之后约 5ms，加载壳已消失且目标标题已存在）与 `next-route-announcer`（服务端与客户端首帧均返回 `null`）。同时确认 `#418` 在 chromium-1440、chromium-1280、firefox-smoke 三者均出现，故 2026-09-23 的「Firefox 独有」判断不成立，`#418` 并非浏览器差异问题。

**修复**：改为单个模板字符串，3 行 → 1 行，不改变可见文本与结构：

```tsx
<title>{`${month.month_id} ${month.series_type} ${formatMoney(month.current.total_cost)}`}</title>
```

**证据**：生产 SSR 中 `/` 的 `<title>` 共 14 个、空 0 个、12/12 月度条形图标题文本正确（修复前 13 个 SVG 标题中 12 个为空）；`/attribution?destination=GB` 共 2 个、空 0 个；DEV 模式 chromium-1440、chromium-1280、firefox-smoke 三者 `#418` 计数均为 0；生产 Firefox 连续 20 次迭代 `pageerror` 与 `#418` 均为 0。全仓仅此一处使用该写法，其余两个 `<title>` 均为单条静态字符串；无测试断言该标题文本。

**静态检查**：`pnpm test` 14 文件 113 passed / 11 skipped、`pnpm lint`、`pnpm typecheck`（4 个 workspace）、8 个改动文件的 prettier 全部退出码 0。

**用户终端验收：单次完整执行（2026-09-24，退出码 0）**。生产构建完整通过（`✓ Finalizing page optimization in 56ms`），证实会话内 E2E 失败确为未定稿构建所致，而非应用缺陷。分项：数据库集成 4 条腿 `44/44`、`44/44`、`10/10`、`7/7` 零 fail 零 skip；从零迁移 0001—0003 后升级 0004—0010；V1 基线发布、V2 候选校验、显式激活与原子物化、重复发布幂等；结构、精度与三角色权限验证；不可变发布升级与核心查询验证；6 条查询计划 `temp_written_blocks` 全 0；快照集成 28/28；Chromium 双视口基础 10 passed / 22 skipped；Chromium 双视口历史证据 22/22；**Firefox 核心冒烟 3/3（`V01-V04` 8.5s 通过，含此前会话内 20/20 失败的展开固定成本一步）**；并发 5 × 100 热查询 p50 30.316ms / p95 74.502ms / p99 104.476ms（P95 预算 1s）；运行后隔离容器、卷、网络全部移除。`pnpm test:db-integration` 独立执行一次同样 4 条腿零 fail 零 skip。

**用户终端验收：两批「完整 Gate 1 × 5 连续」（均未达成 5/5）**

批次一（原始命令，无迭代间清理）：`0, 0, 0, 1, 1`，即 3/5。第 4 次在 `Firefox 核心冒烟` 以原生崩溃码 `3221226505` 失败且**零用例输出**（此前各阶段全部通过：数据库集成四条腿、迁移/发布/激活/查询计划、生产构建、快照 28/28、Chromium 双视口基础 10 passed、Chromium 双视口历史证据 22 passed）。第 5 次在 `Chromium 双视口基础冒烟` 以 `Error: http://127.0.0.1:4173/api/health/live is already used` 失败——根因是第 4 次崩溃时 Playwright 进程先于收尾退出，`webServer` 的 `next start` 泄漏并占住 4173（实测泄漏进程 `next start --hostname 127.0.0.1 --port 4173`，父进程已消失），属**纯级联**，非独立失败。

批次二（加固编排：每次迭代前后清理 4173/4174 监听进程与泄漏的 `next start`，**不触碰断言、超时与用例选择**）：`0, 0, 0, 0, 1`，即 4/5。第 1—4 次全部退出码 0；第 5 次在 `Chromium 双视口历史证据验收` 失败，错误为 `Error: worker process exited unexpectedly (code=3221226505, signal=null)`，首个用例 `[chromium-1440] historical-evidence.spec.ts:326:5` 在 **0ms** 即失败（worker 在用例体执行前崩溃），其余 **21 passed**。该次运行后隔离容器、命名卷、网络残留均为 `none`，端口无泄漏。

**崩溃定性**：`3221226505` = `0xC0000005` = `STATUS_ACCESS_VIOLATION`，为 Windows 进程级崩溃。本轮两批次共执行 10 次，出现 2 次原生崩溃（`Firefox 核心冒烟` 1 次、`Chromium 双视口历史证据验收` 1 次），**零断言失败**；崩溃跨两个不同阶段，但均落在浏览器阶段的启动边界。同一崩溃码与同一阶段在 2026-09-21 已有记录（该次为「Chromium 双视口历史证据验收」+ `3221226505` + 无用例输出，见第 0.2.1 节），故判定为**既有环境不稳定**，非本轮代码缺陷。

**已排除的归因**：批次二运行期间用户已关闭本机浏览器（`firefox.exe` 计数为 0），系统盘剩余 434 GB，故不可归因于用户浏览器负载或磁盘空间。泄漏类级联已在批次二被加固编排消除。

**本轮计划要求「完整 Gate 1 × 5 连续（5/5 退出码 0）」，两批次分别为 3/5 与 4/5，均未达成。** 按本文件既有规则「在消除该不稳定前 Gate 1 不得记为稳定通过」以及计划「任何失败保留现场、不重新计数」，本轮**不得**记为「Gate 1 稳定通过」。正式结论为：**代码侧验收全部通过**（10 次执行零断言失败、集成入口零 fail 零 skip（该口径已于同日收紧为「零 fail，且 `skipped` 精确等于显式声明的平台门控跳过数」，见本节末「提交、推送与 CI 首次 Linux 执行」）、静态检查全绿、独立复查 PASS），**唯一未达成项是被既有环境不稳定阻塞的「连续 5/5 退出码 0」**。

**本会话环境限制（供后续会话复用，避免重复试错）**：

- `spawnSync`/`execSync` 在本会话对任意命令恒返回 `EBUSY`（`node -v`、`git --version`、`docker --version` 皆然），异步 `spawn` 正常。因此以 `spawnSync` 为基础的 `scripts/run-docker-compose.mjs`、`scripts/verify-gate1-isolated.mjs`、`scripts/run-db-integration-tests.mjs` 均无法在会话内运行。
- 宿主 `node-safe-delete-shim` 拦截任何单次删除 ≥50 个文件的操作（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，`scope=turn`，按用户回合累计，拦截时不累计计数）。`next build` 的「Finalizing page optimization」与 Playwright 启动时清理 `test-results/` 都会触发，Bash 通道的 `rm -rf` 同样受管。**不得**以 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 关闭该保护。可用规避：给 Playwright 传 `--output=<全新空目录>`，使启动清理的删除计数为 0。
- 本会话内 `next build` 因上述拦截在收尾阶段失败，产出的 `.next` 属**未完成定稿**的构建。用它做 E2E 得到的失败（导航期 `_rsc` 重定向循环、Firefox 显示「The page isn't redirecting properly」）**不能**作为应用缺陷的证据，须以用户终端完成的正式构建复验。
- Playwright 在收尾阶段挂起（`next start` 子进程不退出、4173 端口被占），需人工终止。以 `--repeat-each=20` 调用时重复用例实际并行执行（20 次 `first_document_loaded` 落在 458ms 窗口内），不满足「串行冷启动」语义，故该方式的结果不作为证据；仓库既定机制是 `LOGIPLAN_GATE1_TARGET`/`LOGIPLAN_GATE1_REPEAT` 的逐次串行调用。
- PowerShell 工具通道无输出；如需 PowerShell 语义，改由异步 `spawn` 调用 `powershell -NoProfile -NonInteractive -Command`。
- 会话内残留已清理：`node.exe` 回到基线、4173 无监听、无 gate1 容器/卷/网络、用户自身 Firefox 进程未被触碰。

**独立审查（2026-09-24）**：以 `bc5383d` 为固定点、由全新上下文的只读子代理完成，判定 **PASS、无 P0/P1**、4 项 P2。已确认：`closeConnection=false` 语义正确（`releaseConnection` 在 `transaction-outcome.ts:232-234` 提前返回，不代调用方关闭连接，解锁失败仍以 `SubsequentFailure` 上报）；`40001` 现归类为**未知写入**（保守方向正确，白名单仍为 `25*` + `2D000`，改动来自 `activate-and-materialize.ts` 弃用本地宽正则改用共享 `runTransaction`）；CLI 退出码与 stderr 前缀互斥且不可能同时出现；**未改动任何既有断言或超时值**；环境变量透传不夹带凭据、未设置时行为逐字节不变；`<title>` 修复为最小正确改动且全仓无同类残留；`transaction-outcome.ts` 未进入 `packages/db/src/index.ts`，公共 API 无变化；测试为真实行为断言且 `process.exitCode` 在 `finally` 中还原，不会污染 vitest 退出码。

**提交、推送与 CI 首次 Linux 执行（2026-09-24，同日续）**：上述改动已提交为 `68b9f11` 与 `8d94b63` 并推送。推送后 CI run `35977886490`（`pull_request` 触发）**失败**——步骤 1—10（Check formatting / Lint / Type-check / Test with coverage / Install Chromium and Firefox）全部通过，失败在步骤 11「Run isolated Gate 1 validation」，即 `pnpm test:db-integration` 的**首次 Linux 执行**（该入口 2026-09-23 才接入 Gate 1）。失败暴露两个本地 Windows 验证结构上无法发现的真实缺陷：

1. **平台门控跳过与零 skip 策略冲突**：`scripts/neon-baseline.test.mjs` 的用例「Windows 入口原样透传 Node 退出码」由 `process.platform === "win32"` 硬门控（其宿主探测只查找 Windows 路径），在 POSIX 上必然跳过，于是 legs 1/2 报 `skipped=1`，被旧判定 `counts.skipped > 0` 判为失败（尽管 `fail=0`）。
2. **POSIX 进程组终止实际是死代码**：`scripts/wait-for-server.mjs` 原写 `child.kill(-child.pid, signal)`。`ChildProcess.kill()` 只接受 `[signal]`，负 pid 被当作信号名解析并抛 `ERR_UNKNOWN_SIGNAL`（实测 `Unknown signal: -45592`），`catch` 必然触发、退化为只杀直接子进程，后代（pnpm / Playwright / 浏览器 / `next start`）全部残留并占住端口。CI 用例「进程树终止会一并结束后代进程」因此失败（后代进程 5763 未被终止）。

修复提交为 `4ff4fb0`（`fix(gate1)`，2 文件 +67/−9）：POSIX 分支改用 `process.kill(-child.pid, signal)`（全部调用点均以 `detached: process.platform !== "win32"` 启动，故 POSIX 下 `child.pid` 即 PGID；Windows 的 `taskkill /PID /T /F` 分支逐字节未改动）；判定改为显式声明表 `platformGatedSkipsByFile` + 精确比较 `counts.skipped !== leg.expectedPlatformSkips`（未登记的新测试文件直接抛错，声明值与实际不符同样判失败，防止声明过期后继续放行）。**未改动任何既有断言、超时值或用例选择。**

**CI 已转绿**：修复推送后 `ubuntu-latest` 上连续五次成功——`35984529953`、`35984592984`、`35985477229`、`35986663729`、`35987670886`（最新一次 `headSha` = `f9c4bfd`），三个 job（Gate 1 deterministic validation、Pull request dependency review、CodeQL JavaScript and TypeScript）全部 success。**这同时是上述根因 2 唯一的独立证明**：POSIX 进程组终止路径在 Windows 上无法验证，只能由 CI 证明。

**稳定性权威证据的定位**：Gate 1 稳定性的权威证据来源为 **CI `ubuntu-latest`**（Linux 无 `3221226505` 原生崩溃）；本地 Windows 执行记录为已记录的环境限制，附重试政策（失败保留现场、原样重跑、不掩盖、不重算）。该定位尚待按本节遗留项 6 的后续任务正式落为 `docs/decisions.md` 决策。

**交接文档**：`docs/handoff-2026-09-25.md`（窗口 2026-09-25 → 2026-10-01，任务 T1—T8）与 `docs/handoff-2026-10-01.md`（窗口 2026-10-01 → 2026-10-05，任务 P1—P6 / E1—E5 / S1—S2）。两份均按用户指示放入仓库并推送；与既有 `%TEMP%` 约定的偏差已在 `docs/handoff-2026-09-25.md` §0 说明。

**遗留项（本轮新增，含独立审查 4 项 P2）**：

1. （P2，文档精度）`apps/web/tests/gate1.spec.ts:153-180` 的 `recordHydrationDomProbe` 未做环境变量门控，`LOGIPLAN_GATE1_TIMELINE_FILE` 未设置时仍执行两次页面内只读往返（`page.evaluate` 与 `getByRole(...).count()`）。它不写文件、不发网络请求、且被 try/catch 包裹，**不影响用例结果**；但「未设置时零副作用」仅对 `recordHydrationHtmlSnapshot`（`:190` 提前返回）成立，不适用于本函数。
2. （P2，覆盖）`packages/db/src/activate-release.test.ts:24-55` 覆盖了未知写入（75）、已确认回滚（1）与非 Error 输入，但**未**正面断言 `[WRITE_COMMITTED_OBSERVATION_FAILED]` → 退出码 1 的映射（仅 `:45` 反向断言）；该映射经 `migrate.test.ts:214` 与 `publish-release.test.ts:386` 间接覆盖，风险低。
3. （P2，既有）`packages/db/src/transaction-outcome.ts:250-271` 以 `hasPrimaryError ? primaryError : undefined` 传递主错误：若 `operation()` 抛出 falsy 值（`undefined`/`null`/`0`/`""`）且清理成功，错误被吞掉；若清理同时失败则被误报为 `writeCommittedObservationFailed`。该行非本轮改动，当前所有调用方均抛 `Error`，属潜在问题。
4. （P2，既有 + 本轮新相关）`packages/db/src/activate-release.ts:48-50` 的 `finally { await client.end() }` 若在 `withInitializationCoordinationLock` 抛出 `writeCommittedObservationFailed`（解锁失败）之后自身也 reject，`finally` 的拒绝会替换带标志的错误并丢失前缀（退出码仍 1，不会变 75）。`finally` 为既有写法，本轮新增的分类使其首次具备可观测影响。
5. （P2，既有，非本轮引入）`pg` 弃用警告「Calling client.query() when the client is already executing a query」在 CLI、Web 服务端与测试中普遍出现。候选来源为 `packages/db/src/query-service.ts` 的三处并发 `pool.query()`（`:257` 2 条、`:1111` 6 条、`:1251` 3 条），配合 `packages/db/src/index.ts:4` 的池上限 `max: 2`；`pg` 内部的确切触发条件未在本轮确认。已核实本轮重构的 `transaction-outcome.ts`、`activate-and-materialize.ts` 内所有 `client.query()` 均为顺序 `await`，**未引入新的并发**。该警告是 `pg@9` 升级的阻塞项，属 D-183 兼容性闸门范围，本轮不修。
6. （既有环境不稳定，未定位根因）Gate 1 浏览器阶段偶发 Windows 原生崩溃 `3221226505`（`0xC0000005`）。2026-09-21、2026-09-22、2026-09-24 三轮均有记录，累计样本中崩溃率约 20%（2026-09-24 两批次 10 次执行中 2 次）。特征：发生在浏览器阶段启动边界、无用例输出或 0ms 即失败、零断言失败、同一批用例在其余执行中通过。已排除用户浏览器负载与磁盘空间；**未定位根因**（未做 WER/崩溃转储级排查）。影响：无法取得「连续 5/5」，Gate 1 不能记为稳定通过。后续任务：如需消除，应采集 Windows 事件日志/WER 崩溃转储确认崩溃进程（Playwright worker 与浏览器进程需区分），再评估浏览器启动参数类缓解措施——**该类改动超出本轮允许范围，须先取得用户批准**。

7. （P2，覆盖缺口，**本轮新增**）`package.json` 第 19 行的 `pnpm lint` 清单缺少两条路径：`scripts/wait-for-server.mjs`（本轮修复的文件）与 `scripts/verify-gate1-isolated.test.mjs`（该修复的回归测试）。即被改动或新增的脚本可能不被 lint 覆盖。`package.json` 属既有计划的排除项，改动需用户批准（第一窗口计划 T3）。**已于 2026-09-25 关闭**：提交 `77b6797` 把这两条路径补入 `lint` 清单（1 行改动），`eslint` 全清单退出码 0，CI 的 Lint 步骤仍为 success。
8. （**写入模式硬前置**，本轮核实）`docs/neon-vercel-baseline-runbook.md:131` 冻结的候选提交 `0229755a097dff94c8de67954b36ab4f9412c0f5` 已落后 22 个提交（2026-09-25 实测 `git rev-list --count 0229755a…..HEAD` = 22；该值随分支推进单调增加，进入写入模式前须以当时实测为准），而该 runbook 规定写入模式要求当前 HEAD 精确等于已批准的工具 SHA。因此进入 `--write` 前必须重新冻结并独立批准新的工具 SHA（第一窗口计划 P1）。

**未关闭事项**：① 已在本轮定位并修复（见上），2026-09-23 段落中该项不再有效；② 2026-09-23 记录的「`packages/db/src/activate-and-materialize.ts:59-63` 仍吞 advisory unlock」**已由本轮重构关闭**——`withInitializationCoordinationLock`（`:29-39`）现经 `runWithConnectionCleanup(client, advisoryUnlock, activationScope, operation, false)` 释放锁，解锁失败以 `SubsequentFailure` 上报并归入 `writeCommittedObservationFailed`（见 `transaction-outcome.ts:226-241`）。因此「advisory unlock 不再被静默吞掉」现对**迁移、发布、激活三个入口同时成立**，2026-09-23 段落中该限定不再需要。

**2026-09-25 续：lint 覆盖收口、工作区清理与独立审查（T3 / T8 / T5）**

- **T3（提交 `77b6797`）**：把 `scripts/wait-for-server.mjs` 与 `scripts/verify-gate1-isolated.test.mjs` 补入 `package.json` 的 `lint` 清单（1 行改动），关闭上述遗留项 7 的覆盖缺口。`eslint` 全清单（含两条新路径）退出码 0，`package.json` 通过 prettier。
- **T8（提交 `6c3afb6`）**：删除工作区两处错误重定向产物。已跟踪的 `"itory multi-agent workflow•"` 内容经取证确认为 **`less` 分页器的帮助屏**（`less` 的保存功能误写入），它是在 `a63a43c`（同时存在于 `origin/main`）中加入的；未跟踪的 `e HEAD`（33359 字节）是 `git diff` 输出碎片，已移至 `%TEMP%` 备份而非直接销毁。工作区由 13 项约定资产降至 **11 项**（`AGENTS.md` + 10 份 `neon-baseline-report-*.json`）。
- **T5 独立审查（固定点 `6c3afb6`）**：全新上下文的只读子代理判定 **PASS、无 P0/P1、6 项 P2**。已确认：`process.kill(-child.pid, signal)` 正确；**全部 `terminateProcessTree` 调用点的子进程都以 `detached: process.platform !== "win32"` 启动**（`run-db-integration-tests.mjs:90`、`neon-baseline.mjs:534`、`verify-gate1-isolated.mjs:391/514`、`verify-gate1-isolated.test.mjs:189`）；Windows `taskkill` 分支逐字节未变；`platformGatedSkipsByFile` 的四类场景（未登记文件抛错、声明 1 实得 0、声明 0 实得 1、无法解析计数）**全部 fail closed**；未改动任何断言、超时值或用例选择；`6c3afb6` 仅删除一个已跟踪文件、未触及源码。**6 项 P2 全部为文档精度问题**，已在本轮一并修正（见下）。
- **本轮 P2 处置**：① 遗留项 7 标注关闭、遗留项 8 的计数由 18 更正为 22；② 本文件与 `docs/neon-vercel-baseline-runbook.md`、`docs/neon-permission-baseline-plan.md` 中「CI 连续四次成功」更正为五次（新增 `35987670886`，`headSha` = `f9c4bfd`）；③ `docs/handoff-2026-09-25.md` 的「领先 18 个提交」更正为 26；④ `docs/handoff-2026-10-01.md` 的「落后 18 个提交」更正为 22；⑤ 审查者指出 `executionClosurePaths`（26 条）与 `pnpm lint` 清单**并非同一集合**——`scripts/verify-gate1-isolated.test.mjs` 已纳入 lint 但不在闭包内，`scripts/neon-baseline.ps1` 在闭包内但不可 lint，其余差异属目录级或配置文件级。两者职责不同（前者是工具 SHA 保护范围，后者是静态检查范围），**不要求相等**，此处仅作记录；⑥ `6c3afb6` 的提交标题原写「two files」，但 git 记录中只有一个已跟踪文件的删除（`e HEAD` 从未被跟踪、不产生 git 记录），标题已在推送前修正并补充说明。
- **仍未执行**：T6（`3221226505` 的只读 WER / 事件日志取证）本轮**未获授权**，故 G2 仍开放；T1（本地正式复验）需用户在终端执行，本会话 `spawnSync` 仍恒返回 `EBUSY`（实测 `git` / `node` / `pnpm` 三者皆然）。

## 0.1 2026-09-23 轮次（历史证据）

2026-09-23 轮次处理两件事：迁移与发布入口的事务/清理结果语义收口，以及 Gate 1 中 Firefox 首次导航与证据快照轮询的间歇性超时定位。全部改动当时在工作区、尚未提交（后已提交为 `baa1407` 与 `bc5383d`）；未触碰任何远程环境。

- **三类写入结果**：新增内部模块 `packages/db/src/transaction-outcome.ts`（未进 `packages/db/src/index.ts`）。类1 `rollbackConfirmed` → 退出码 1；类2 `writeOutcomeUnknown` → 75；类3 新增 `writeCommittedObservationFailed` → 退出码 1、stderr 前缀 `[WRITE_COMMITTED_OBSERVATION_FAILED]`、消息固定含「写入已提交，失败发生在后续观察或清理阶段」，报告新增布尔 `write_committed_observation_failed` 与 `write_outcome=committed_observation_failed`。既有 0/1/75 与既有 `write_outcome` 取值含义不变。
- **入口接线**：`migrate.ts` 与 `publish-release.ts` 的加锁流程统一由 `runWithConnectionCleanup` 包裹（unlock 与 `client.end()` 各自独立尝试、任一失败不阻止另一步）；`markPublishFailedIfKnown` 改为可判定 COMMIT 的显式事务；候选创建后与校验写入后两处读取失败改走 `observeCommittedWrite`，不重做创建、不标记失败。
- **数据库集成入口**：新增 `pnpm test:db-integration`（`scripts/run-db-integration-tests.mjs`；四条腿＝`postgres:18.4`、`18.6` 上跑真实角色事务与 ACL 查询，另加只读诊断与本地 API 等待逻辑回归），要求零 fail，且 `skipped` 精确等于该文件显式声明的平台门控跳过数（`scripts/run-db-integration-tests.mjs` 的 `platformGatedSkipsByFile`；未登记文件直接抛错，声明值与实际不符同样判失败——见本节末「提交、推送与 CI 首次 Linux 执行」）；Gate 1 的三处脚本测试调用收敛到该入口；`executionClosurePaths` 25 → 26 条，并把新入口与 Gate 1 编排脚本纳入 `pnpm lint` 清单。
- **间歇性超时定位**：为 Gate 1 增加环境变量驱动的定向重复模式（`LOGIPLAN_GATE1_TARGET=firefox|snapshot`、`LOGIPLAN_GATE1_REPEAT=N`）与 JSONL 时间线埋点。实测余量：Firefox 导航→目标标题 1.55—1.86s（预算 5s）；快照首次轮询采样即为 `[1,1,1,1]`（约 1.18s，且此时客户端请求尚未发出，四条快照由服务端首屏 SSR 提交），预算 10s。**未改动任何断言或超时值**。
- **偶发连接重置**：Docker 门控用例的偶发失败为 `read ECONNRESET`，发生在容器就绪、宿主机建立 TCP 连接的时刻，重复执行结果不同。已在 `startRoleBootstrapPostgres` 增加有界的宿主侧可达性探测（≤12 次 × 250ms，失败时报出镜像、容器、端口与末次错误码），属「等待可观察状态」而非放宽超时。
- **本地验收**：完整 Gate 1 四批各 5 次＝20 次全部退出码 0（最后一批 5 次的完整日志保留并逐项核对；前 15 次仅有终端汇总行）；每次四条腿 `44/44`、`44/44`、`10/10`、`7/7` 零 skip；Chromium 双视口基础 10、历史证据 22、Firefox 3；查询计划 `temp_written_blocks` 全 0；并发 5 × 100 热查询 p50 22.2—23.9ms、p95 37.6—46.5ms、p99 42.8—48.3ms；运行后无容器、卷、网络与浏览器残留；无 Docker 时脚本测试退出码 0 并跳过 2 条门控用例；覆盖率 95.51% stmts / 87.5% branch / 95.96% funcs / 95.66% lines；eslint、`tsc -p packages/db`、14 个改动文件的 prettier 均退出码 0。
- **独立审查**：以 `da0d769` 为固定点判定 PASS、无 P0/P1、6 项 P2；P2 全部按「后续任务」记录（见 `docs/neon-permission-baseline-plan.md` 遗留项），本轮不修，以保住已取得的稳定性证据。
- **未关闭事项**：① Firefox 每次迭代必现 React 水合失败 `#418`（元素级不匹配，最强候选为 `apps/web/app/loading.tsx` 的 Suspense fallback 与页面根差异），修复需改动 `apps/web`，超出本轮范围（**已于 2026-09-24 轮次定位并修复，根因与证据见第 0 节**）；② `packages/db/src/activate-and-materialize.ts:59-63` 仍吞 advisory unlock，属同类残留，因此「advisory unlock 不再被静默吞掉」这一条**仅对迁移与发布两个入口成立**。

## 0.2 2026-09-22 轮次（历史证据）

2026-09-22 轮次（第三次修复轮次）已完成交接文件 7 项阻滞中的 1—5 项代码修复，另加 ACL 断言口径修正与 PowerShell 入口编码修正。本轮未再次连接 Neon、未推送、未激活远程发布、未部署 Vercel。本轮修复已提交为 `245dc3017d2d5009844f7f4a35d07cab18bd0dba`（父提交 `06cccf2d855ff8355f0bbd73b61ee1f984bfc329`，14 个文件，加 619 行、减 130 行），分支相对 origin 领先 7。写模式前置检查已通过：HEAD 精确匹配该提交、执行闭包 25 条路径无未提交改动、冻结候选资产 `0229755a097dff94c8de67954b36ab4f9412c0f5` 无改动、工作区仅剩 11 项约定排除资产。工具 SHA 最终取 `e03d192ed023699e38df6bc8c12d8ca5cc54892d` 并经用户独立批准。详细命令、逐次结果与失败现场见 `docs/neon-vercel-baseline-runbook.md` 第 0 节。

修复内容：`scripts/neon-baseline.mjs` 的 `acldefault` 由 `CASE ... THEN 'S' ...` 改为 `(CASE ... THEN 's' ...)::"char"`（根因：`CASE` 结果类型被解析为 `text`，`pg_catalog` 无 `acldefault(text, oid)`，真实 PostgreSQL 报 SQLSTATE 42883，与 2026-09-21 远程 `-Write` 失败信息逐字一致），并把四段 ACL 查询提取为导出函数 `queryPrivilegeAclRows`、导出 `assertRolePrivilegeBaseline` 供真实库测试执行生产路径；ACL 断言口径改为「只有 `relkind` 为 `r`/`p` 才预期 data_publisher INSERT」，并新增 `publisherReadOnlyRelations`（`data_release`、`active_data_release` 仅 SELECT，对应 `0001:1317-1320` 的显式 `REVOKE INSERT`），修正了「视图被要求 INSERT」与「显式撤销 INSERT 的表被要求 INSERT」两类误判；`packages/db/src/migrate.ts` 与 `publish-release.ts` 的 COMMIT 失败分类改为保守白名单（仅 `25xxx` 与 `2D000` 视为确定未提交，`40003`、`08xxx`、`57014` 与未枚举码一律判未知），并把迁移表创建与候选创建两处事务外自动提交写入收进既有事务 helper；`scripts/neon-baseline.mjs` 的报告路径改为在任何连接与预检之前以 `open(path,"wx")` 独占预留，路径被占用时零连接即失败且不覆盖已有文件，写入失败不再吞错；`scripts/verify-gate1-isolated.mjs` 的进程终止改为按进程树终止（Windows `taskkill /PID /T /F`，POSIX 进程组）并覆盖超时、停止服务与信号共 6 处；`scripts/neon-baseline.ps1` 只新增 UTF-8 BOM，修复 Windows PowerShell 5.1 在非 UTF-8 控制台代码页下解析中文导致的 `ParserError`。

实测结果：启用 `NEON_BASELINE_TEST_DOCKER=1` 与 `postgres:18.6` 时三个脚本测试文件为 57 passed、0 skipped、退出码 0；`postgres:18.4` 与 18.6 下 baseline + audit 均为 50 passed、0 skipped；无 Docker 为 48 passed、2 skipped。**计数口径更正**：baseline 文件由 37 项增至 40 项，此前文档中的「Docker 46/46」与「无 Docker 46 passed + 1 skipped」作废。项目级：`pnpm test` 95 passed、11 skipped；`pnpm test:coverage` 退出码 0（All files 95.51% stmts / 87.5% branch / 95.66% lines）；`pnpm lint`、`pnpm typecheck`、`pnpm build` 退出码 0。

`pnpm verify:gate1:isolated` 本轮执行 6 次：第 1、3 次退出码 1，第 2、4、5、6 次退出码 0，**第 4、5、6 次为连续三次正常退出**。两次失败必须保留：第 1 次为 Firefox 核心冒烟 1/3 失败——`/attribution?destination=GB` 跳转成功但 5 秒内未出现目标标题，可访问性快照显示页面仍停在「正在加载分析工作台」加载壳；第 3 次为快照集成 `preserves historical release evidence across both Chromium viewports` 在 10 秒轮询内未观测到 4 条快照落库（该次中止早于浏览器套件）。两次失败位于不同步骤且均为轮询/等待超时类，与 2026-09-21 的 6 次（4 次退出码 0、2 次浏览器启动环节异常）同属长期不稳定，根因未定位；**在消除该不稳定前 Gate 1 不得记为稳定通过**，复验必须记录执行次数与每次结果。第 2、4、5、6 次执行后均无 gate1 / acl 容器、卷、网络残留，Chromium 进程 0，Firefox 进程数与运行前一致。

独立审查：2026-09-22 由独立只读子代理（全新上下文、无写入权限）在固定点 `06cccf2` 上判定 PASS、无 P0/P1、列出 6 项 P2；其中 1 项按最小改动收紧（relation ACL 断言显式校验同一 `relname` 的关系类型一致），1 项按既有规则彻底关闭（`scripts/wait-for-server.mjs` 纳入 `executionClosurePaths`，闭包由 24 条增至 25 条，并删除 `neon-baseline.mjs` 内的重复进程树终止实现），其余 4 项为既有问题或文档精度问题（详见 runbook 第 0 节）。本轮修复已提交为 `245dc301…`、随后以 `e03d192…` 记录提交事实；工具 SHA 取 `e03d192ed023699e38df6bc8c12d8ca5cc54892d` 并经用户独立批准。

远程执行（2026-09-22，由用户在本机终端完成）：阶段 A 只读核查未命中任何停止条件——身份为 `neondb_owner`、`server_version` 18.6、三角色属性与严格成员关系（grantor OID 10、`ADMIN=true`/`INHERIT=false`/`SET=false`）全部符合基线、`latest_migration = 0010`、`release_status = VALIDATED`、`active_release = null`；迁移 0001—0010 与 V2 数据包校验和与本地冻结资产逐字一致，2026-09-21 那次 `-Write` 的写入结果未知由此清账。随后两次 validate-only prepare（报告 `neon-baseline-report-20260922-1400.json` 与 `…-1405.json`，经逐字节比对完全相同）均退出码 0，报告字段为 `status = prepared`、`last_completed_stage = permissions_verified`、`write_outcome = known`、`active_release_switch = false`、`release_status = VALIDATED`、`observed_active_release = null`。本任务终点「Neon 准备完成、候选已校验、活动发布保持原状」已经达到；Vercel 部署、数据激活、分支推送、远程 CI 与部署后复验均未执行，第一闸门整体仍不因此关闭。

#### 0.2.1 2026-09-21 轮次（历史证据）

本轮（第二次返工轮次：P1/P2 最小修复）已在最终代码上取得新的实际结果，详细命令与结果见 `docs/neon-vercel-baseline-runbook.md` 第 0 节。基线与 audit：启用 `NEON_BASELINE_TEST_DOCKER=1` 与 `postgres:18.6` 时 `node --test scripts/neon-baseline.test.mjs scripts/neon-permission-audit.test.mjs` 为 46 passed、0 skipped（Neon baseline 36 + 权限 audit 10）。项目级：`pnpm test` 为 85 passed、11 skipped；`pnpm lint`、`pnpm typecheck`、`pnpm test:coverage`、`pnpm build` 退出码均为 0，覆盖率 All files 95.51% stmts / 87.5% branch / 95.66% lines，分包阈值满足。

`pnpm verify:gate1:isolated` 共执行 6 次，4 次退出码 0，覆盖 PostgreSQL 18.4 迁移/V1/V2、发布幂等、显式激活、三角色权限、6 条查询计划（`temp_written_blocks` 全为 0）、生产构建、快照持久化证据 28/28、Chromium 双视口基础 10 passed 与 22 项设计性跳过、Chromium 双视口历史证据 22/22、Firefox 3/3，以及并发 5 的 100 次热查询 P50 23.083ms / P95 38.898ms / P99 42.123ms（第 3 次 P50 23.865ms / P95 42.099ms / P99 44.621ms；第 5 次 P50 23.165ms / P95 43.537ms / P99 47.975ms；第 6 次 P50 22.521ms / P95 40.066ms / P99 45.452ms）。异常的 2 次都发生在浏览器启动环节：第 1 次在“Chromium 双视口历史证据验收”以原生崩溃码 `3221226505` 失败（无用例输出），第 4 次挂起在“Chromium 双视口基础冒烟”（无任何 Chromium 进程存活，等待超过 15 分钟无进展后人工终止并清理隔离环境，不计为通过或失败）。第 5 次在环境净化后通过，第 6 次在为 Docker、构建与浏览器步骤补齐 `timeoutMs`（经用户授权的最小改动，只加超时参数）后通过。无任何用例断言失败，同一批用例在其余执行中通过，判定为环境不稳定而非代码缺陷；在消除该不稳定前，Gate 1 不得记为稳定通过。

本轮修复 P1（Node 与 PowerShell 入口把写入结果未知压成退出码 1）与 P2（写入子进程异常终止被误判为 known_failed），改为退出码 75 与异常终止统一判定为未知写入结果，均先写红灯测试再实现。执行者安排经用户明确变更：原“Luna High 实现 + Sol High 独立复查”改由单一会话模型（DeepSeek V4.1 Flash）完成实现与验证；随后由独立只读子代理（全新上下文、无写入权限）完成复查，判定 PASS，无 P0/P1，列出 6 项 P2，其中 2 项代码问题（`runCli` 中 `parseArguments` 未纳入 `try` 导致原始堆栈输出、`error` 事件未走统一判定函数）已修复并补 1 项回归测试，其余 4 项为文档精度问题并已收窄描述。复查者标注的未验证项包括 ps1 → 真实 Node 的 75 组合链路、真实 signal 退出、Docker 18.6 的 46 passed 与 Gate 1 六次执行结果。

裸执行两个 Node 测试文件 41 项（40 passed、1 项 Docker 条件 skip）、历次 PostgreSQL 18.6 定向验证 41/41、历史 Gate 1 退出码 0（Neon baseline 31/31、权限 audit 10/10、本地 API 5/5、快照持久化 28/28、Chromium 历史证据 22/22、Firefox 3/3、P95 43.954ms）以及 2026-09-20 的 audit 9/9 与独立复查 PASS 全部保留为历史证据，仅覆盖各自当时的范围，不替代本轮最新重跑。

全仓 `pnpm format:check` 仍为退出码 1，失败文件为本轮未改动的 `AGENTS.md` 与根目录 7 份 `neon-baseline-report-*.json` 共 8 个用户资产；本轮只做定向格式检查，未执行全仓 `prettier --write`。候选资产 `0229755a097dff94c8de67954b36ab4f9412c0f5` 未在本轮修改；本轮代码修复已以单次提交提交（`104f4b0f`，15 个文件）并通过独立复查；本段文案修正为紧随其后的独立文档提交，tooling SHA 应取包含该修正的当前 HEAD 且尚未批准；未推送，未连接 Neon，未部署 Vercel。H1 仍只记录为本地 PostgreSQL 机制证据。

### 1.1 第三阶段正式实现闸门

1. 闸门一：完成 Next.js App Router、PostgreSQL 只读发布数据、确定性查询与证据 API、方案 B 桌面页面和已校验固定 AI 示例，并通过 V1.0 契约与核心 9 题验收。正式查询必须从标准化 PostgreSQL 关系表执行；原型 JSON 仅作测试夹具和冻结结果参照。演示数据通过离线、可重复、原子发布流程装载，应用启动不写入业务数据。
2. 闸门二：在闸门一通过后接入真实模型、匿名限流、费用估算与两级熔断、不可变证据快照及固定示例回退；不得放宽闸门一的数字、证据和页面验收标准。

真实模型接入采用供应商中立的 `ModelGateway` 和独立供应商适配器。首个适配器使用 OpenAI，但业务编排、查询证据、限流、费用熔断和页面不得依赖 OpenAI 专有接口；模型按服务器端 `provider + model` 角色配置选择。切换模型或新增供应商必须先通过适配器契约、固定 AI 评估集、数字与证据越界、超时回退、成本及中文输出验收，不允许自动路由到未经验证的模型。

首次数据库迁移仅覆盖闸门一实际需要的发布版本、核心维度、线路、Budget、Actual、Forecast、价格、汇率和分析事实结构；其他结构随对应能力追加。

统一分析事实、固定成本事实和原子归因在发布阶段计算并固化；页面汇总、筛选、排序和证据组装按请求执行，不预存整页结果。

数据库结构由版本化显式 SQL 迁移管理；应用启动和数据库访问工具不得自动同步正式结构。

SQL 只由独立数据访问层执行；界面、路由和查询服务通过稳定领域接口访问数据，不直接依赖物理表结构。

所有页面查询统一归一化为 V1.0 的 `QuestionType + AnalysisScope`，核心 9 题和页面验收共用同一个查询服务。

浏览器查询统一进入 `POST /api/v1/query`；服务端渲染直接复用查询服务函数，不通过内部 HTTP 回环。

确定性查询一次性原子返回完整结果和证据，服务端硬超时 10 秒；超时使用 HTTP 504 独立基础设施错误，不修改 V1.0 业务错误联合类型。正常热请求的 P95 验收目标不超过 1 秒。

筛选或页面状态变化时取消旧查询，并通过请求序号与范围一致性检查阻止过期响应覆盖当前结果。

每次服务端查询生成唯一 `request_id`，通过 `X-Request-Id` 响应头贯穿查询日志与错误；客户端并发序号仅保护页面状态。

查询日志只记录最小必要的结构化运行元数据，禁止记录完整业务响应、证据正文、Cookie、原始 IP 和自然语言问题全文。

请求级查询日志保留 14 天并自动删除；不含请求级标识的匿名聚合性能指标保留 90 天，不长期归档原始日志。

活动版本勾稽或结构兼容性失败立即告警；一般错误率、超时率和 P95 延迟按 D-140 的样本窗口阈值告警。

提供独立的 `/api/health/live` 与 `/api/health/ready`；只有数据库连接、结构版本和活动数据发布均兼容时实例才可接收业务流量。

第一闸门先在可重复本地环境与 CI 临时 PostgreSQL 中从零通过迁移、数据发布、核心 9 题和页面检查，再部署公开测试环境并复验。

本地、CI 和公开环境锁定同一 PostgreSQL 主版本，第一闸门不依赖托管厂商专有扩展；主版本号在核对官方支持周期后确认。

已按 D-144 锁定 PostgreSQL 18，首次实现使用 18.4；后续仅在 18.x 内经回归后升级补丁版本。

公开测试环境采用 Vercel Hobby 托管 Next.js、Neon Free 托管 PostgreSQL 18，仅用于个人非商业作品演示。平台免费额度、冷启动、日志保留和告警缺口必须单独验证，不宣称生产 SLA。

Vercel 服务端函数与 Neon PostgreSQL 必须显式配置在同一地理区域；具体区域代码待核对两平台官方列表后确认。

公开测试环境已按 D-147 固定为 Vercel Singapore `sin1` 与 Neon AWS Singapore `aws-ap-southeast-1`，部署验收必须核对实际区域配置。

Vercel 运行时使用 Neon 池化只读连接；SQL 迁移和数据发布使用隔离的管理直连，管理凭据不进入 Web 应用环境。

数据库权限拆分为 `schema_migrator`、`data_publisher` 和 `app_reader` 三个最小权限角色，公开运行环境只持有 `app_reader`。

Vercel Preview 只能连接隔离的临时 Neon 数据库分支；隔离环境缺失或失败时关闭预览数据访问，禁止回退到公开测试数据库。

每个开放 GitHub Pull Request 最多使用一个 `preview-pr-<编号>` Neon 分支，并行上限为 5；PR 合并或关闭后撤销连接并在 24 小时内删除，超额时保留 CI 但不创建预览数据库。

GitHub Actions 统一编排检查、临时数据库、迁移、数据发布、验证与清理；只有全部前置步骤通过后才触发 Vercel Preview，Vercel 不持有数据库管理凭据。

外部 Fork Pull Request 只运行无密钥检查；任何持有 Neon、Vercel 或发布凭据的工作流均不得执行未经信任的外部代码。

合并 `main` 不自动发布公开测试环境；受保护 Production 工作流必须由人工批准，并绑定已通过检查的具体提交 SHA、迁移清单和数据包校验和。

公开发布按“扩展迁移 → 候选数据校验 → 兼容应用部署 → 健康检查 → 原子激活 → 核心复验”执行，同一发布禁止破坏性删改数据库对象。

第一闸门全部 SQL 迁移只增不减；废弃对象仅标记，待闸门通过和旧部署回滚窗口结束后再单独审批清理。

正式 monorepo 采用 `apps/web`、`packages/contracts`、`packages/domain`、`packages/db`、`database/migrations` 和 `database/releases`；现有原型、数据脚本与文档保持独立。

第一闸门使用包管理器原生 workspace、单一锁文件和根级脚本，不引入 Turborepo、Nx 或其他额外 monorepo 编排器。

包管理器固定为 pnpm 10，并在根 `package.json` 精确锁定版本；全仓库只使用一个 `pnpm-lock.yaml`，CI 与部署均以冻结锁文件安装，内部依赖使用 `workspace:*`。

本地、CI、Vercel 构建和服务端运行时统一使用 `>=24.15.0 <25` 的 Node.js 24.x；低于 24.15.0 时失败，补丁更新先通过完整回归，主版本不得随平台默认值自动跨代。

首版 Web 应用精确锁定 Next.js 16.3.1、React/React DOM 19.2.8 和 TypeScript 7.0.2；禁止版本范围自动漂移，任何升级均作为独立变更完成全套回归后合并。

正式界面使用全局设计令牌、CSS Modules 和少量全局基础样式；第一闸门不引入 Tailwind CSS、第三方组件库或运行时 CSS-in-JS，并以已验收方案 B 复验 1440px 与 1280px 桌面效果。

业务查询和可复现页面状态以经过 V1.0 契约校验的 URL 为唯一权威，瞬时交互使用局部组件状态；第一闸门不引入 Redux、Zustand 等全局状态库，并通过请求范围守卫保证响应与当前地址一致。

月度趋势图和五因素瀑布图使用 React 原生 SVG 与可单测的纯几何函数实现；第一闸门不引入通用图表库，图表数值只消费确定性查询结果，并提供键盘操作和等价可读取明细。

`packages/contracts` 精确锁定 Zod 4.4.3，以运行时模式作为 V1.0 查询、结果、证据和错误结构的唯一来源，并从模式推导 TypeScript 类型；所有边界复用同一模式且不得把高精度十进制值强制转换为 JavaScript `number`。

`packages/db` 精确锁定 node-postgres `pg` 8.23.0 与 `@types/pg` 8.23.1，使用参数化原生 SQL 和进程级小型连接池；第一闸门不引入 ORM、查询构建器或 Neon 专用驱动，PostgreSQL `numeric` 始终以字符串进入精确十进制领域类型。

`packages/domain` 精确锁定 decimal.js 10.6.0，并通过项目专用克隆构造器统一使用 80 位有效数字与 `ROUND_HALF_UP`；权威数值只从十进制字符串构造，中间过程不舍入，汇总后才生成 4 位报告值和 2 位界面值。

TypeScript 单元测试和临时 PostgreSQL 集成测试统一使用精确锁定的 Vitest 4.1.11，覆盖率插件保持同版；第一闸门不并存 Jest，数据库测试执行真实 PostgreSQL 18.4 迁移、发布、查询和权限路径。

DOM 组件测试采用 jsdom 30.0.1，因此 Node.js 24.x 最低版本收紧为 24.15.0；安装、测试和构建均对实际版本执行失败关闭检查。

客户端交互组件使用 React Testing Library 16.3.2、user-event 14.6.5 与 jsdom 30.0.1，以角色、名称、文本、状态和键盘行为断言证据侧栏、下钻、因素选择、演示引导及 SVG 交互；真实布局与跨页行为留给浏览器验收。

真实浏览器端到端测试精确锁定 Playwright Test 1.62.1；可信 PR 在 Chromium 的 1440×900 与 1280×800 两档连接正式构建和临时 PostgreSQL 18.4 完整复验，合并或发布前增加 Firefox 核心冒烟，WebKit 暂不作为第一闸门必过项。

代码检查使用 ESLint 9.39.5、typescript-eslint 8.67.0 与 Next.js 16.3.1 配置，格式化使用 Prettier 3.9.6；ESLint 10 组合已经兼容性验证否决，不引入 Biome 或 eslint-plugin-prettier，CI 分别执行零警告 `lint` 和只读 `format:check`。

全部正式 workspace 继承统一 TypeScript 严格基线，启用索引访问、精确可选属性、覆盖、异常和 switch 贯穿检查；冻结判别联合必须穷尽处理，禁止以无说明的 `any`、双重断言或非空断言绕过边界。

第一闸门剩余工具链已按 D-175 冻结：pnpm 10.34.5、统一 ESM、`skipLibCheck: false`、精确类型依赖、分层 tsconfig、tsx 管理脚本和 TypeScript 7 空白工程兼容性验证；暂不使用 project references 或 Git hooks 工具链。

数据库执行约定已按 D-176 冻结：本地 Docker Compose 只运行 PostgreSQL 18.4；项目迁移执行器使用校验和、advisory lock 和事务；业务表位于 `logiplan` schema。数据发布必须经过候选版本、SHA-256、勾稽和核心 9 题校验后原子激活；Web 连接池初始上限为 2，第一闸门不启用 RLS。

2026-08-20 已完成第一闸门数据库基础与固定数据发布实现：PostgreSQL 18.4 Compose、
三角色初始化、0001—0003 版本化迁移、首批 `logiplan` 结构、候选发布状态机、活动版本
只读视图、退役版本回切及受控结构版本读取均已落地。固定发布器严格校验数据包和生成规则
SHA-256、结构、行数、引用、唯一性、高精度计算、核心 9 题与两种归因勾稽，只发布
Gate 1 支持的 Budget、Actual、Forecast，情景模板保持后续边界。

同日修正生成脚本默认银行家舍入与冻结 `ROUND_HALF_UP` 不一致的两条归因明细，并在
Docker Desktop 4.87.0 的隔离 PostgreSQL 18.4 空库完成 0001—0003 迁移、首次发布、重复
发布幂等、三角色权限、失败候选写保护、退役回切和查询计划验收。两个核心查询均无临时
磁盘写入，单次执行为 1.164 ms 和 0.716 ms。

参数化数据访问层和统一确定性查询服务已完成第一闸门范围内的确定性查询与数据层核心闭环：驾驶舱、国家摘要、归因桥、归因下钻、月度趋势、异常排行、固定成本拆解和诊断指标共用同一套结果与证据生成逻辑，并通过 `POST /api/v1/query` 暴露；下钻父子行仅展示履约变动成本，固定成本不进入目的国归因。仓库差异上下文已补齐公司范围 2026-08 发货仓差异与公司总计。

2026-08-27，第一闸门中的确定性查询与数据层切片、本地隔离空库验证及基础浏览器冒烟已完成。隔离 PostgreSQL 18.4 空库按 `0001`—`0003` → V1 → `0004` → V2 顺序完成迁移、发布和 V2 重复发布幂等验证；三角色权限、高精度数值、不可变发布升级、诊断固定结果与证据、查询计划均通过，诊断查询计划执行时间为 0.750 ms 且无临时磁盘写入。分包覆盖率门槛和诊断核心模块 100% 覆盖要求已通过；现有工程骨架的 Chromium 两档共 6 项验收和 Firefox 3 项核心冒烟通过；并发 5、100 次热查询的 P95 为 50.649 ms。验证创建的临时 Compose 项目与命名卷已清理，未触及持久本地数据库。

2026-09-08，第一闸门本地工程与浏览器收尾复验在锁定的 Node 24.15.0、pnpm 10.34.5 和原生 Windows 入口完成。格式、lint、类型、生产构建及分包覆盖率门槛通过；隔离 PostgreSQL 18.4 按 `0001`—`0003` → V1 → `0004`—`0010` → V2 完成迁移、发布、幂等、三角色权限、不可变升级和查询计划验证。Chromium 1440×900 与 1280×800 共 32 项通过且无跳过，包含问题 6 历史证据矩阵 22 项；Firefox 核心冒烟 3 项通过。并发 5、100 次热查询 P95 为 44.317 ms。V01—V12、核心 9 题、证据历史、axe 严重/致命问题与性能要求已有本地自动化或既有人工验收证据；本地 Gate 1 可以标记为通过。

2026-09-09，基于 `6582887`（`Gate1 Pre Final`）的本任务前历史复验批次完成当时工作区代码的隔离验证。普通 Vitest 为 69 项通过、11 项按隔离环境条件跳过；隔离 PostgreSQL 18.4、真实本地 API 与 Chromium 环境中，`evidence-snapshot.test.ts` 为 28/28 通过，原 11 项全部实际执行。数据库从空库完成 `0001`—`0003` → V1 → `0004`—`0010` → V2、重复发布幂等、结构/精度/三角色权限、不可变发布升级及 6 条查询计划验证。基础 Chromium 双视口为 10/10 通过；无快照凭据的基础命令对历史证据套件按设计跳过 22 项，随后使用仅注入 Playwright 测试进程的隔离凭据单独执行历史证据 Chromium 双视口 22/22 通过，另完成 4 次 axe serious/critical 扫描。Firefox 核心冒烟 3/3 通过并完成 2 次同级 axe 扫描。并发 5、100 次热查询结果为 P50 24.488 ms、P95 45.403 ms、P99 49.567 ms。类型、lint、格式、生产构建及分包覆盖率门槛在同一历史候选基线上通过。一次性 Compose 项目、容器、网络和命名卷均已清理；该批次独立审查初审问题已修复，定向复查 PASS。

2026-09-09，独立审查返工前候选从固定 HEAD `6582887802a5739230f5a38f276099c212312c42` 以 `git archive` 重建，只应用批准的路线图与隔离验证脚本完整差异，并加入本地 API 等待 helper 及其真实 HTTP 回归测试；未复制工作区、环境文件、缓存或其他本地配置。回归测试连续 3 次均为 5/5 通过，普通 Vitest 为 69 项通过、11 项按隔离环境条件跳过，格式、lint、覆盖率门槛与生产构建通过。全新安装后直接类型检查会因 Next 尚未生成 `.next/types` 的两个声明文件而失败；执行冻结工具链的 `next typegen` 后类型检查通过。完整隔离验证首次运行在 `evidence-snapshot.test.ts` 已通过 17 项时出现一次无退出码的 Vitest worker 意外退出，Compose 清理成功；同一候选立即完整重跑后，真实 PostgreSQL/API 测试 28/28、基础 Chromium 10/10、历史证据 Chromium 22/22、Firefox 3/3 均通过，基础命令另有 22 项按无快照凭据设计跳过。该返工前重建性能批次的并发 5、100 次热查询结果为 P50 22.941 ms、P95 39.795 ms、P99 42.508 ms，容器、网络和命名卷均已清理；首次 worker 意外退出仍作为本地稳定性残余风险保留。

2026-09-10，独立审查返工把 Web 工作区类型检查入口改为先执行冻结 Next 工具链的 `next typegen`，再执行 TypeScript 检查。最终候选再次从相同固定 HEAD 隔离重建，只应用 3 个批准的 tracked 文件完整差异并加入 2 个本任务测试文件；冻结安装后未手工执行任何类型生成前置，根级 `pnpm typecheck` 直接生成路由类型并完成 4 个 workspace 检查。真实 HTTP 回归连续 3 次均为 5/5 通过；格式、lint、普通 Vitest 69 项通过及 11 项按环境条件跳过、覆盖率门槛与生产构建均通过。完整隔离验证一次通过：真实 PostgreSQL/API 测试 28/28、基础 Chromium 10/10、历史证据 Chromium 22/22、Firefox 3/3，基础命令另有 22 项按无快照凭据设计跳过；并发 5、100 次热查询结果为 P50 25.437 ms、P95 42.972 ms、P99 53.934 ms。一次性容器、网络和命名卷均已清理；本地 clean reconstruction 类型检查前置缺口已关闭。

上述结果不表示第一闸门整体关闭。Gate 1 GitHub Actions、依赖审查、CodeQL 和 Dependabot 配置已经落地，但 GitHub Actions 远程运行尚未执行，仓库秘密扫描仍待在外部 GitHub 仓库设置中启用并验证；部署后的 Singapore 区域、健康检查、浏览器与性能复验同样未执行。当前不宣称远程 CI、秘密扫描或部署验收通过。

Web 与安全基线已按 D-177 冻结：业务页动态 SSR 且不缓存，正式地址为 `/` 和 `/attribution`，查询接口仅同源 JSON 且限制 16 KiB；首版关闭 React Compiler，不使用 Server Actions、外部 CDN、Cookie、分析埋点、PWA 或 Service Worker，并执行 CSP、HSTS、环境变量分层和禁止不安全 HTML 注入等要求。

2026-09-17，Neon 权限基线本地修复进行中：在一次性 PostgreSQL 18.4 容器中以
`CREATEROLE NOSUPERUSER` 管理角色真实复现三条标准 `pg_auth_members` 管理边，确认
三角色为 parent、管理角色为 member、`ADMIN=true`、`INHERIT=false`、`SET=false`、
grantor OID 10 且为超级用户；旧的零行规则因此确认为误拒。生产校验已改为严格逐条
判定并保留 `assertRoleDefinitions`、完整 `assertRolePrivilegeBaseline`、对象权限、
事务失败未知语义及候选资产/执行闭包保护；另增加纯只读权限诊断入口和 Node 测试。
Node 24 的 Windows 进程互操作在该日会话因 WSL `UtilBindVsockAnyPort` 错误不可用，
因此生产 Node 测试、完整格式/lint/typecheck/test/coverage/build/Gate 1 尚未执行；
PostgreSQL 18.6 定向测试因本地无 `postgres:18.6` 镜像未执行。未进行 Neon、Vercel、
GitHub 或任何真实凭据操作；返工阶段补充了实际加载的 `packages/domain` 与
`packages/contracts` 执行闭包、固定 PostgreSQL 18.6 实连身份校验、迁移/V2 数据包校验和
事实读取、凭据原始/编码/解码脱敏及审计 CLI 成功不创建文件或目录的输出边界；这些均为
本地机制，未宣称 Neon、Vercel 或 GitHub 远程通过，远程核验仍待后续授权和执行。正式
`neon-baseline --report` 文件报告行为不受本任务影响。独立审查和远程准备
仍待阶段 5。

CI 与验收已按 D-178 冻结：工作流固定提交 SHA 并最小授权；启用依赖与代码安全检查；执行分包覆盖率阈值、Playwright axe 无严重问题、并发 5 的 100 次热查询 P95 不超过 1 秒，并按冻结安装到浏览器验收的固定顺序失败关闭。

观测方案已按 D-179 冻结：服务端输出最小 JSON 日志，请求级日志最长保留 14 天；Sentry 只接收不含请求标识和业务内容的服务端聚合指标。D-140 相应窄修订为第三方告警不附带示例 `request_id`，请求标识只在 Vercel 日志可用期内排障。

第二闸门首个模型适配器按 D-180 使用 OpenAI SDK 7.5.0 与 Responses API，但模型仅作为 D-174 服务器端角色配置，业务层保持供应商中立；调用非流式、禁用存储与工具、使用结构化输出、500 字输入上限、内容审核、20 秒超时和一次受限重试。

第二闸门按 D-181 使用 Upstash Redis Free 实现匿名滑动窗口、费用预留与结算，失败时关闭真实模型并保留固定示例；会话快照保存在 `sessionStorage`，模型只能引用服务端证据白名单。供应商、模型、提示词、模式或价格变更后必须重跑完整 20 题评估。

D-182 的技术排除项在首个纵向切片内生效，避免为尚未出现的复杂度引入 ORM、GraphQL、队列、微服务、通用代理框架及其他非必要平台层；后续只有经独立需求和成本验证后才能重评。

依赖冻结流程已按 D-183 改为可执行兼容性闸门：版本调研完成后仅为候选，必须在精确运行时上以严格 peer dependency 安装顺序通过 lint、独立类型检查、单元测试和生产构建后才能确认。2026-08-20 首次验证否决了 TypeScript 7.0.2 直接供 typescript-eslint 使用以及 ESLint 10.8.1 的组合；D-184 修订后，TypeScript 7 CLI、TypeScript 6 API 兼容层、ESLint 9.39.5、Next.js 16.3.1 与其余冻结依赖已通过全部闸门，正式工程基础扩展可以继续。

## 2. 二期范围状态

截至当前决策记录：

- 明确承诺为“二期必做”的项目：**0 项**；
- 明确标记为“第二阶段或后续产品化扩展”的能力包：**1 组，共 5 个功能项**；
- 二期范围尚未正式冻结，不得把所有 MVP 排除项自动视为二期需求。

### 2.1 已进入二期候选池的能力包

承运商合同与容量管理能力包含：

1. 承运商规划容量；
2. 容量利用率；
3. 最低承诺量；
4. 阶梯返利；
5. 合同配额。

该能力包来源于 D-085“承运商容量约束的阶段边界”。原决策表述为“统一留待第二阶段或后续产品化扩展”，因此其当前状态是二期候选，而不是已承诺交付。

若未来纳入二期，应按“月份 × 履约线路”增加容量及合同参数，并在情景模拟中增加软约束、警告或阻止规则；不得修改现有履约线路主结构和第一版成本口径。

## 3. 已预留但未排入二期的扩展方向

以下方向已有兼容设计或扩展接口，但尚未确定开发阶段、优先级和验收标准：

- 订单级事实层、订单追踪、单票审计和订单—包裹关联；
- 原币页面切换及完整多币种交互；
- 仓租、一线作业基础人工、仓库管理人工和系统费用的固定成本驱动模型；
- Forecast 持久化编辑及受保护的管理模式；
- 按异常配送事件类型下钻；
- 包裹级合同阶梯、最低收费和重量进位引擎；
- 将退货物流有效单价拆分为逆向运输和仓内退货处理；
- 历史反事实复盘交互页面；
- 新增承运商或重大线路改造时的一次性实施成本、实施周期和投资回收期模型；
- 英文界面、英文管理分析模板及独立英文 AI 评估集。
- 手机和平板端的响应式布局、移动端下钻表和移动端证据面板。

这些内容属于扩展候选池，只有在二期规划中再次确认后，才能转为二期交付范围。

## 4. 二期冻结规则

二期规划时，每个候选项目至少需要明确：

- 解决的业务问题和目标用户；
- 与第一版数据模型和指标口径的关系；
- 输入数据是否真实可获得；
- 页面、接口和计算规则；
- 验收标准及测试样本；
- 开发成本、部署成本和优先级；
- 是否会改变第一版已经冻结的业务定义。

只有完成上述确认并写入决策记录的项目，才计为“二期必做”。

## 5. 当前统计口径

```text
二期必做：0 项
二期候选：1 个能力包，5 个功能项
其他未来扩展：已有方向记录，但未排入二期
```
