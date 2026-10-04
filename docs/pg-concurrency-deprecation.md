# `pg` 并发弃用告警归因（S2 结论）

版本：V1.0
日期：2026-09-28
状态：**归因结论仍然成立（`pg@9` 未发布，D-183 闸门当前无可执行对象）；修复已于 2026-10-02 落地并通过真实库验证；并发判定目标已于 2026-10-04 显式类型化为 `QueryTarget`（唯一工厂 + 模块私有 nominal brand），第 6 节第 1 条的类型层面缺口随之实质闭合**（第 1—7 节为 2026-09-28 的原始结论文本，原文保留不改；本次**已修改**生产代码 `packages/db/src/query-service.ts`——落地位置、对应第 6 节四条建议的覆盖情况与验证证据见第 8 节；2026-10-04 的重构与证据见第 8.2、8.3、8.6 节的更新注记）
依据：本地 `pg@8.23.0` 源码、仓库静态路径分析、2026-09-27 E1 激活的真实运行日志、npm registry 版本查询。

---

## 1. 结论

**判定：需先修，但不阻塞当前任何已计划的动作。**

| 问题                               | 结论                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 该告警是否为 `pg@9` 升级的阻塞项？ | **在升级动作发生前必须消除，但现在不阻塞任何计划**——`pg` 尚无 9.x 版本发布（npm 最新 `8.23.0`，无任何 `9.*`），因此 D-183 的兼容性闸门当前没有可执行对象 |
| 触发条件是否确认？                 | **已确认**（源码级 predicate + 仓库路径定位 + 真实日志证据）                                                                                             |
| 是否已在真实数据库上最小复现？     | **未完成**。沙箱无 PostgreSQL、无 Docker、无到数据库的出网路径；只做了 predicate 级复现与静态分析。不得表述为"已在真实库复现"                            |

---

## 2. 触发条件（源码级，确定性证据）

`pg@8.23.0` 在 `lib/client.js:761` 处发该通知：

```js
if (this._queryQueue.length > 0 && !this.pipeline) {
  queryQueueLengthDeprecationNotice();
}
this._queryQueue.push(query);
```

- 通知文本（`lib/client.js:36`）：**"Calling client.query() when the client is already executing a query is
  deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."**
- 判定条件是**同一 `Client` 实例**上提交查询时"待执行队列非空"，与 `Pool` 无关。
- `Pool.query()` 不经过该分支：`pg-pool/index.js:467` 在拿到**已空闲**的 client 后才调用 `client.query`，
  且 client 在 `_pulseQueryQueue` 中会把执行中的查询从队列 `shift` 出去（`lib/client.js:622`）。
  **因此池化并发本身不是触发源**——触发源是"把同一个 client 当并发执行目标"。

---

## 3. 仓库内的触发点（静态定位）

`packages/db/src/query-service.ts` 的 `QueryDatabase = Pick<Pool, "query">`（第 22 行）只用结构约束，
因此**裸 `Client` 也能作为 `QueryDatabase` 传入**。以下三处用 `Promise.all` 同时提交多个查询：

| 位置                    | 函数                       | 并发查询数 |
| ----------------------- | -------------------------- | ---------- |
| `query-service.ts:257`  | `validateVariableCoverage` | 2          |
| `query-service.ts:1111` | `dashboard`                | 最多 6     |
| `query-service.ts:1251` | `bridge`                   | 3          |

它们通过两条路径拿到**单个 client**：

1. **Web 路径**：`runDeterministicQuery` 对 V1.1 且需持久证据的请求先 `await pool.connect()`（第 2053 行），
   再把该 client 传给 `executeQuery(client, …)`（第 2064 行）→ 上述 `Promise.all` 全部落在**同一个 client** 上。
2. **CLI / 脚本路径**：`activate-release.ts`、`publish-release.ts`、`verify-query-plans.ts` 等直接 `new Client()`，
   再把它作为 `QueryDatabase` 传入 → 同样落在单个 client 上。

**不构成触发点**：`checkReadiness(pool)`（第 2121 行的 `Promise.all` 走真实 `Pool`，两条查询分属不同 client）；
`verify-schema.ts:85` 与 `verify-release-workflow.ts:72` 的 `Promise.all` 是并发**建立不同连接**，不是在同一 client 上并发查询。

**实测证据**：2026-09-27 E1 激活（`pnpm db:activate-release`，走 CLI 路径）的运行日志中真实出现该通知——
与第 2 项的 CLI 路径结论一致（激活链路会执行 `dashboard` / `bridge` / `validateVariableCoverage` 的查询计划与物化）。

---

## 4. 复现尝试与已知限制（供后续复核）

- **predicate 级复现（完成）**：以 `pg@8.23.0` 构造 `Client`，在同一 tick 内提交 2 个 `query()`，
  可观察到该 `DeprecationWarning`；该通知由 `nodeUtils.deprecate` 包装，**每进程只发一次**，
  因此"次数"不是有效指标，只能做**二值判定**（触发/未触发）。
- **"已连接且空闲"模拟（不可信，已弃用）**：以桩连接（`_queryable=true`、伪造 `connection`）模拟已连接状态时，
  实测观察到首个查询**并未离开队列**（`queue=1, active=无`），说明桩环境不满足 `_pulseQueryQueue` 的真实前置，
  由此得到的计数是**桩伪影**，不得作为"2 个并发即触发"的证据。
- **真实库端到端复现（未完成）**：沙箱无 PostgreSQL 服务、无 Docker、无法连接受管数据库，
  因此"在真实数据库上执行该并发模式是否必然触发"仍**未经实测确认**。
  若要补做，需在具备本地 PostgreSQL 的环境执行：单 client 上 `Promise.all` 发起 2–6 条真实查询，
  以 `--trace-deprecation` 记录调用栈，即可确定触发阈值与栈顶位置。

---

## 5. `pg@9` 现状与升级判定

- npm registry 查询结果：`pg` 最新版本 **`8.23.0`**，**不存在任何 `9.*` 版本**。
- 因此：**当前没有可升级的目标**，D-183 要求的"可执行兼容性闸门"无法执行，本告警不阻塞任何计划中的动作。
- 但通告文本明确该行为 **"will be removed in pg@9.0"**：一旦 9.x 发布，这三处并发提交点将成为升级闸门的
  **必过项**；9.x 的具体新语义（报错还是需显式排队）以届时发布说明为准，本文不作推断。

---

## 6. 处置建议（本文不实施）

1. **把"目标是否支持并发"显式化**：在类型层面区分"可并发的池"与"必须串行的单连接"，
   避免裸 `Client` 以结构类型静默满足 `QueryDatabase`。
2. **保留池级并发，串行化单 client 路径**：Web 路径的 `pool.connect()` 分支（第 2053—2064 行）
   与三个 CLI 脚本应改为串行执行这三处聚合查询；`Pool` 路径可继续用 `Promise.all`，
   因为池并行正是 `max: 2` 的预期用法。
3. **回归防线**：新增一条"不得在同一 client 上并发提交"的行为测试，
   或在测试中以 `--trace-deprecation` 捕获该通知并失败（当前测试不会因该通知失败，因此它是静默的）。
4. **升级前置**：把第 1—3 项列为 `pg@9` 兼容性闸门的入口条件，与 D-183 的升级流程绑定。

---

## 7. 验收（对应 S2 要求）

| 要求                | 结果                                                              |
| ------------------- | ----------------------------------------------------------------- |
| 最小复现该告警      | predicate 级完成；真实库端到端**未完成**，原因与补做方法见第 4 节 |
| 确认触发条件        | 完成（源码 predicate + 仓库路径 + 真实日志三方一致）              |
| 判定是否阻塞 `pg@9` | 完成：**需先修，但不阻塞当前计划**（9.x 未发布）                  |
| 不修改生产代码      | 满足：本次仅新增本文档并更新 `docs/current-plan.md` 的状态行      |

> **2026-10-02 注**：上表是 2026-09-28 当时的验收口径，**原文保留**。修复已于同日落地并修改了生产代码，
> 追加记录见第 8 节。

---

## 8. 修复落地与验证（2026-10-02）

本节是**追加记录**：第 1—7 节为 2026-09-28 的原始结论，原文一字未改。其中第 1 节的判定（`pg@9` 未发布 ⇒
D-183 闸门无可执行对象）与第 5 节仍**完全成立**，本节不改写它们，只记录「告警本身已被消除」这一新增事实。

### 8.1 对 `docs/development-roadmap.md` §0 遗留项 5 归因的修正

该条目把候选来源记为 `packages/db/src/query-service.ts` 的三处并发 `pool.query()`（`:257` / `:1111` / `:1251`）
配合 `packages/db/src/index.ts:4` 的 `max: 2`。**该归因已被证伪**，理由即第 2 节已写明的源码事实：判定对象是
**单个 `Client` 实例**的 `_queryQueue`，而 `pg-pool` 的 `Pool.query` 每次先 `this.connect()` 取**一条独占** client、
发一条查询后立即 `release`，故并发 `pool.query()` 在任何并发度、任何 `max` 下都**结构上不可能**触发该通知。
第 3 节的三处行号本身没错，但它们只是**潜在**触发点——只有当单个 `Client`／事务连接被当作 `QueryDatabase`
传入时（第 3 节列出的两条路径）才成立。

因此本文与 roadmap 长期不一致，本次修正后二者一致；roadmap 侧以 dated 注记形式追加，未改写原文。

### 8.2 修复位置与形态

**2026-10-04 更新（修复形态已重构为唯一工厂 `createQueryTarget(source, concurrency)`，`serializeQueries` 不再作为独立函数存在）**：本节下方原文按约定**原文保留不改**，它描述的是提交 `7e089efb`（2026-10-02）的形态。模块私有函数 `serializeQueries(db)` **现已不存在**（`grep -c 'function serializeQueries'` = 0）：其全部逻辑已**并入唯一工厂** `createQueryTarget(source: QueryDatabase, concurrency: "pool" | "single"): QueryTarget`（同文件，**未导出**）的 **`"single"` 分支**——在同一条连接上把查询串成一条 promise 链，每次 `query()` 排在上一条之后。下方 8.2 的每一条要点（`values` 透传、接收者恒为 `db`、错误以同一对象抛出、失败不永久阻断、对外签名仍为完整重载集、**进程级抑制 `unhandledRejection`**、「所有调用点必须 `await`/`.catch`」的清单、rejection handler 是链不中断的必要条件）**逐条迁入工厂注释，语义未变**。`"pool"` 分支不做任何包装，`db` 就是传入对象本身。注入点仍是那两个「单连接判定点」，只是改为 `createQueryTarget(client, "single")`。

新增模块私有函数 `serializeQueries(db)`（`packages/db/src/query-service.ts`，**未导出**）：在同一条连接上把查询
串成一条 promise 链，每次 `query()` 排在上一条之后。

- **`(text, values?)` 原样透传**；缺省 `values` 时不补第二个实参（`verify-query-plans.ts` 依赖 `values` 捕获查询计划）。
- 每条语句都写成 `db.query(...)` 的方法调用，接收者恒为 `db`（解构成裸函数会丢失 `this`，`pg` 的
  `Client.prototype.query` 依赖接收者）。
- 链中某条查询失败时，错误以**同一对象**抛给该次调用方，不替换为通用错误、不吞错。
- 失败**不永久阻断**后续查询：链在每次失败后仍继续排队。
- 对外签名仍是完整的 `QueryDatabase["query"]`（`@types/pg` 把 `Pool#query` 声明为 7 个重载，只能断言一次），
  所有调用点的参数校验强度与包裹前完全一致。

**只注入两个「单连接判定点」**：

1. `runDeterministicQuery` 的 `await pool.connect()` 之后（Web 路径的 V1.1 单连接事务分支）；
2. `materializeEvidenceSnapshots` 函数首行（发布物化路径）。

**V1.0 纯 Pool 分支与那三处 `Promise.all` 刻意保持不变**——它们走真实 `Pool`，池级并发正是 `max: 2` 的预期用法
（第 6 节第 2 条的处置口径）。这也意味着**后续维护者不得再去改那三处 `Promise.all`**：改了既无收益，又会摧毁
池级并发。

**已知取舍（已写入代码注释，非本次新发现）**：`chain = pending.then(noop, noop)` 会给 `pending` 挂 rejection
handler，副作用是**进程级抑制** `unhandledRejection`——调用方一旦丢弃本函数返回的 promise，Node 不再为它发出
`unhandledRejection`。当前全部调用点都显式 `await` 或 `.catch`，今天无影响，但**新增调用点必须遵守该约定**，
否则错误会被静默丢弃。同一个 rejection handler 同时是「链不中断」的必要条件。

### 8.3 第 6 节四条处置建议的落地对应关系

| 第 6 节建议                                         | 落地情况（2026-10-02）                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 类型层面区分「可并发的池」与「必须串行的单连接」 | **部分落地**：`QueryDatabase = Pick<Pool, "query">` 的结构约束**未变**（改为在类型层面区分会触及全部调用点与公共边界）。以「注释披露 + 签名收窄 + 接收者用例」形式替代：`serializeQueries` 的注释显式写明 `QueryDatabase` 可能是 `Pool` 也可能是单个 `Client`，包装层保证接收者恒为 `db`，对外签名仍为完整重载集。**裸 `Client` 仍能静默满足 `QueryDatabase` 这一缺口尚未闭合。** |
| 2. 保留池级并发，串行化单 client 路径               | **已落地**：两个单连接判定点全部改走 `serial`；`Pool` 路径与三处 `Promise.all` 逐字未改                                                                                                                                                                                                                                                                                           |
| 3. 回归防线（不得在同一 client 上并发提交）         | **已落地**：新增 6 个行为测试。`pnpm test` = 15 文件 **128 passed / 11 skipped（139）**（基线 122 / 11 / 133，净 +6）；`query-service.ts` 覆盖率 **94.06 / 93.68 / 84.94**（基线 93.75 / 93.38 / 84.10，三项均上升）                                                                                                                                                              |
| 4. 升级前置（列为 `pg@9` 闸门入口条件）             | **回归防线已就位**（即第 3 条的 6 个测试）。闸门**仍不可执行**：`pg@9` 未发布，第 5 节判定不变，本轮不新建闸门绑定                                                                                                                                                                                                                                                                |

代码改动已通过独立审查。

**2026-10-04 更新（上表第 1 条的状态由「部分落地」更新为「已落地」；第 2、3 条的计数随之更新）**：上表原文按约定**原文保留不改**，其状态以本注记为准，完整证据见 8.6 节。

- **第 1 条（类型层面区分「可并发的池」与「必须串行的单连接」）现为「已落地」。** 落地形态：新增并发判定点的唯一入口类型 `type QueryTarget = { readonly db: QueryDatabase; readonly concurrency: "pool" | "single"; readonly [queryTargetBrand]: true }`，其中 `const queryTargetBrand: unique symbol = Symbol("logiplan.queryTarget")` 是**模块私有的 nominal brand**（`QueryTarget` 与 `queryTargetBrand` 均不对外导出），带 brand 的 `QueryTarget` **只能由 `createQueryTarget` 构造**。7 个会把多条查询并发提交的函数改签名收 `target: QueryTarget`（`validateVariableCoverage`、`dashboard`、`bridge`、`monthlyCostTrend`、`topAdverseAnomalies`、`evidenceLookup`、`executeQuery`）；只发单条查询的函数仍收 `QueryDatabase`，调用处传 `target.db`。**三处并发点的 `Promise.all` 逐字未改**，只把接收者换成 `target.db`——并发决策完全由 `db` 的构造决定。原先「`QueryDatabase` 的结构约束未变、以注释披露 + 签名收窄 + 接收者用例替代」这一状态**已不再成立**。
- **缺口闭合的真实边界（不得夸大）**：**已闭合**——裸 `Client`、`Pick<Client, "query">`、包装对象、字面量 `{}` 在编译期被拒绝，**手写字面量 `{ db, concurrency }` 同样被拒绝**（缺 `[queryTargetBrand]`），因此**无法伪造**一个「自称已串行化但实际未串行化」的并发目标；「裸 `Client` 仍能静默满足 `QueryDatabase`」这一缺口**已实质闭合**。**仍存在的一层（不得宣称已闭合）**——类型系统只证明「对象出自本工厂」，**不证明 `concurrency` 实参传对了**：若对单连接误传 `concurrency: "pool"`，类型仍然成立但不会串行化。这一层由**既有行为测试（单连接在飞计数探测）兜底，不是类型系统解决的**。
- **第 2 条**维持「已落地」，实现形态由独立包装函数改为工厂的 `"single"` 分支（`"pool"` 分支无包装，保留池级并发）；**第 3 条**的回归测试由 6 个增至**累计 8 个**；**第 4 条不变**：`pg@9` 未发布，第 1 节与第 5 节判定不变，闸门仍不可执行。

### 8.4 验证证据（2026-10-02，本机 macOS，真实 `postgres:18.4`）

- **`pnpm verify:gate1:isolated` 在真实 PostgreSQL 18.4 上以 `NODE_OPTIONS=--trace-deprecation` 完整跑完**，
  **全程零 `DeprecationWarning`、零 `already executing a query`**。
- 其中「显式激活 V2 并原子物化固定证据」步骤确实执行（输出「活动发布已原子切换为 `LOGIPLAN_2026_DEMO_V2`，
  固定证据已物化」）⇒ `materializeEvidenceSnapshots` 由真实 `Client` 走过，**即第 3 节所引 2026-09-27 E1 激活时
  告警真实出现的那条路径**（这同时**关闭了第 4 节「真实库端到端复现未完成」这一缺口**）。
- Gate 1 其余阶段全部通过：DB 集成四腿 `44/44`、`44/44`、`10/10`、`7/7`（零 fail，`skipped=2` 与显式声明一致）；
  迁移 `0001—0003` → V1 → `0004—0010` → V2 校验 → 激活；结构/精度/三角色权限；不可变发布升级与核心查询；
  6 条核心查询计划 `temp_written_blocks` 全 0；生产构建；快照集成 **28/28**；Chromium 双视口基础
  10 passed / 22 skipped；Chromium 双视口历史证据 **22/22**。
- **唯一失败是 `Firefox 核心冒烟`**，签名与 2026-09-30 已收口的 macOS 27.0 / 26A428 预发布版本地环境限制完全一致
  （`0ms` 失败、用例体未执行、零断言失败）⇒ **非本次改动引入的回归**。

**三段反向对照**（真实 `postgres:18.4`，独立进程；因该通知每进程只发一次，故三段分开跑）：

| 对照 | 形态                                                      | 结果                                  |
| ---- | --------------------------------------------------------- | ------------------------------------- |
| A    | 同一 `Client` 上并发 3 条 `query()`                       | **告警出现**（证明探针有效）          |
| B    | 同样 3 条查询走 promise 链（`serializeQueries` 等价形态） | **零告警**                            |
| C    | 真实 `Pool` `max: 2` 上并发 6 条 `pool.query()`           | **零告警**（独立证实第 8.1 节的证伪） |

**对照 B 表中的「`serializeQueries` 等价形态」指的就是 8.2 节所述的同连接 promise 链包装**；按 2026-10-04 的形态，它即 `createQueryTarget(source, "single")` 的 `"single"` 分支（`serializeQueries` 作为独立函数已不存在）。上表与 8.4 节的记录对应提交 `7e089efb`，**原文保留不改**。

**权威证据（2026-10-03，CI）**：改动已提交为 `7e089efb`（`fix(db)`），文档为 `6c828dc9`，`.gitignore` 为
`94f1caf7`，三者推送至 `main`（`b3a62b4c..94f1caf7`）。CI run **`37088307553`**（head = `94f1caf7`）**全绿**：
`Gate 1 deterministic validation`（ubuntu-latest，含完整 `pnpm verify:gate1:isolated`，**Firefox 核心冒烟腿真跑并通过**，
本机 macOS 27.0 无法运行该腿）3m55s success；`Cross-platform checks` 的 ubuntu / macOS / windows 三个矩阵 job
全部 success；`CodeQL JavaScript and TypeScript` success；`Pull request dependency review` 按设计 skipped（仅 PR 触发）。
按 **D-188**，CI `ubuntu-latest` 为 Gate 1 稳定性的**权威证据来源**，故本次修复的稳定性主张以该 run 为准，
本节 8.4 的本机记录为与之**分别记录、不得合并**的本地证据。

### 8.5 结论

告警本身已消除，触发面已被串行化并由回归测试锁定。第 1 节与第 5 节的判定**不变**：`pg` 最新版本仍为 `8.23.0`、
无任何 `9.*`，D-183 的兼容性闸门**当前仍无可执行对象**。一旦 9.x 发布，第 8.3 节表中的第 1 条缺口（裸 `Client`
静默满足 `QueryDatabase`）与闸门入口条件需要在升级动作前正式处置。

**2026-10-04 更新**：上句所列「第 8.3 节表中的第 1 条缺口」**已实质闭合**（见 8.3 节更新注记与 8.6 节），不再是升级动作前的
待处置项；`pg@9` 升级动作的入口条件**仍只包含回归防线**（不得在同一 client 上并发提交，已由测试锁定）。第 1 节与第 5 节的判定
**不变**。

### 8.6 2026-10-04 更新（`QueryTarget` 类型显式化，类型层面缺口实质闭合）

**落地形态**：`serializeQueries` 的串行化逻辑已并入唯一工厂 `createQueryTarget(source: QueryDatabase, concurrency: "pool" | "single"): QueryTarget`；`QueryTarget` 带**模块私有**的 `unique symbol` nominal brand `queryTargetBrand`，只有本工厂能产出。`"pool"` → `db` 为传入对象本身（真实 `Pool`，或 `verify-query-plans.ts` 用来采集查询计划 `values` 的 `Proxy`），**保留真并发**；`"single"` → `db` 为同连接 promise 链包装。因此**并发决策完全由 `db` 的构造决定**，三处并发点的 `Promise.all` 无需改动、逐字未改，只把接收者换成 `target.db`。7 个并发判定点改收 `target: QueryTarget`，只发单条查询的函数仍收 `QueryDatabase`（调用处传 `target.db`）。

**缺口闭合的真实边界**：

- **已闭合**：裸 `Client`、`Pick<Client, "query">`、包装对象、字面量 `{}` 在编译期被拒绝；**手写字面量 `{ db, concurrency }` 同样被拒绝**（缺 `[queryTargetBrand]`）⇒ **无法伪造**一个「自称已串行化但实际未串行化」的并发目标。上一轮记录的「裸 `Client` 仍能静默满足 `QueryDatabase`，这一缺口尚未闭合」**已被本轮改动推翻**。
- **仍存在的一层（不得宣称已闭合）**：类型系统只证明「对象出自本工厂」，**不证明 `concurrency` 实参传对了**。若对单连接误传 `concurrency: "pool"`，类型仍然成立但不会串行化——这一层由**既有行为测试（单连接在飞计数探测）兜底，不是类型系统解决的**。

**验证证据（2026-10-04）**：

- 代码已通过**三轮独立审查**，最终判 **PASS**；期间独立审查者以**仓库外副本**做了 20+ 组变异实验。
- `pnpm test` = 15 文件 **136 passed / 11 skipped / 147**（`pg` 修复前基线 122 / 11 / 133）。
- `query-service.ts` 覆盖率 **93.76 / 85.02 / 94.23 / 94.13**（`pg` 修复前 93.68 / 84.94 / 94.23 / 94.06，三项均未下降）。
- `pnpm typecheck`（4 个 workspace）、`pnpm lint`、`pnpm format:check`、`pnpm build` 均**退出码 0**。
- 回归测试累计 **8 个**（本轮新增）：串行性、池级并发保留、参数与元数透传、`REPEATABLE READ` 校验保留、接收者绑定、失败语义与链不中断、V1.0 池级目标即传入 `Pool` 本身（复现 `verify-query-plans` 的 `Proxy` 拦截并核对接收者）、brand 与守卫识别前提。**既有 6 个串行化回归用例一行未改且仍通过**（`git diff` 删除行数为 0），证明重构行为等价。
- 编译期断言取自**真实 tsc 输出**：手写字面量伪造 → `error TS2741: Property '[queryTargetBrand]' is missing in type '{ db: QueryDatabase; concurrency: "single"; }' but required in type 'QueryTarget'`；裸 `Client` 传入 → `error TS2739: Type 'Client' is missing the following properties from type 'QueryTarget': db, concurrency, [queryTargetBrand]`；移除 brand → `error TS2578: Unused '@ts-expect-error' directive`。
- **进行中、尚未完成（不得表述为已通过）**：`pnpm verify:gate1:isolated`（真实 `postgres:18.4` + `--trace-deprecation` 的端到端复验）由主 Agent 在合并前执行。8.4 节的 2026-10-02 本机记录与 2026-10-03 的 CI 权威证据**继续有效**，但对应的是提交 `7e089efb` 的形态，**不得当作本轮重构的端到端证据**。
- **（2026-10-04 更新：上述端到端复验已完成，上条「进行中」状态作废）** 本轮重构（`54dce871`，HEAD `6a9f72d8`）的两项端到端证据均已取得：

  1. **本机（macOS，真实 `postgres:18.4`，`NODE_OPTIONS=--trace-deprecation`）**：`pnpm verify:gate1:isolated` 走完全部 18 个阶段，**全程零 `DeprecationWarning`、零 `already executing a query`**。其中「显式激活 V2 并原子物化固定证据」确实执行（输出「活动发布已原子切换为 LOGIPLAN_2026_DEMO_V2，固定证据已物化」），即 `createQueryTarget` 的 `"single"` 分支由真实 `Client` 走过——**正是 2026-09-27 E1 激活时该告警真实出现的位置**。其余：DB 集成四腿 `44/44`、`44/44`、`10/10`、`7/7`（零 fail，`skipped=2` 与显式声明一致）；迁移 `0001—0003` → V1 → `0004—0010` → V2 校验 → 激活 → 重复发布幂等；结构/精度/三角色权限；不可变发布升级与核心查询；**6 条核心查询计划 `temp_written_blocks` 全 0**；生产构建；快照集成 **28/28**；Chromium 双视口基础 10 passed / 22 skipped；Chromium 双视口历史证据 **22/22**。**唯一失败是 `Firefox 核心冒烟`**，签名（`0ms`、用例体未执行、零断言失败）与本文件相关章节及 `docs/current-plan.md` §5.7 的 2026-09-30 收口逐字一致，即 macOS 27.0 预发布版的**已记录本地环境限制**，非本次重构引入的回归。运行后清理了 Firefox 腿失败导致的孤儿 `next-server`，复核容器/卷/端口/进程均为 0。
  2. **CI（权威证据来源，按 D-188）**：run **`37167407079`**（head = `6a9f72d8`）**全绿**。`Gate 1 deterministic validation`（ubuntu-latest，3m29s）success，其中 `Run isolated Gate 1 validation` 步骤 success——**该步骤内含 Firefox 腿**（本机失败会使其退出码 1），故 **ubuntu 上 Firefox 腿真跑并通过**；`Cross-platform checks` 的 ubuntu / macOS / windows 三个矩阵 job 全部 success；`CodeQL JavaScript and TypeScript` success；`Pull request dependency review` 按设计 skipped。
