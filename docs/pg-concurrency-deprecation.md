# `pg` 并发弃用告警归因（S2 结论）

版本：V1.0
日期：2026-09-28
状态：**结论文档，未修改任何生产代码**（本次仅新增本文件与 `docs/current-plan.md` 的状态更新）
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
