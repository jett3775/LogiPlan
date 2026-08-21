# Gate 1 数据库运行说明

## 1. 当前边界

本地数据库固定使用 PostgreSQL 18.4。Docker Compose 只运行数据库，Node.js 24.15.0
和 pnpm 10.34.5 在宿主机运行。首迁移覆盖发布版本、维度与线路、Budget、Actual、
Forecast、价格、汇率、统一分析事实、固定成本事实和归因查询结构，不包含情景会话、
真实模型、限流或费用结构。

业务对象位于 `logiplan` schema。迁移记录位于
`public._schema_migrations`，每个迁移保存版本和 SHA-256；已执行迁移的内容发生变化时，
执行器会失败关闭。

## 2. 本地启动

1. 安装并启动 Docker Desktop，确认 `docker compose version` 可用。
2. 从仓库根目录复制 `.env.example` 为 `.env`。示例密码只适用于本机开发，不得用于
   CI、Preview 或公开环境。
3. 依次执行：

```bash
pnpm db:up
pnpm db:migrate
pnpm db:publish
pnpm db:verify
pnpm db:verify-release
pnpm db:verify-plans
```

`db:publish` 会校验固定数据包及生成规则 SHA-256、严格结构、行数、引用、唯一性、
高精度计算、核心 9 题和归因勾稽，全部通过后才原子激活。`db:verify` 核对结构、精度和
三角色权限；`db:verify-release` 验证退役版本回切；`db:verify-plans` 使用 `app_reader`
执行核心查询的 `EXPLAIN (ANALYZE, BUFFERS)` 验收。`db:up` 和 `db:down` 会先探测当前
终端的 Docker；若 WSL 套接字在 Docker Desktop 重启后尚未恢复，则自动使用 Windows
Docker Desktop 客户端，Linux 和 CI 仍使用标准 `docker`。

停止本地数据库：

```bash
pnpm db:down
```

`db:down` 保留命名卷中的数据。项目不提供自动破坏性 down 或 reset；需要清除本地卷时
必须单独确认目标和影响。

## 3. 三类角色

- `schema_migrator`：执行版本化 SQL，管理结构；Web 不得持有该凭据。
- `data_publisher`：读取候选基础表并新增候选业务行；不能直接新增或更新发布控制记录，
  不能更新或删除历史业务事实，只能通过受控函数登记、校验和激活发布。
- `app_reader`：只能查询 `active_*` 视图；不能读取候选基础表，也没有写权限。

活动版本切换由 `logiplan.activate_data_release(text)` 完成。该函数使用事务级 advisory
lock，并由唯一活动状态约束和单行活动指针共同保护；同一发布版本重复激活为幂等操作，
已退役且通过完整校验的版本可通过同一函数安全回切。
全部发布数据表还使用统一写入守卫：只有关联发布处于 `CANDIDATE` 状态时才能写入，
一旦进入 `VALIDATED`、`ACTIVE`、`RETIRED` 或 `FAILED` 即不可再追加或修改业务行。

## 4. 迁移规则

- 文件名使用四位递增版本，例如 `0001_gate1_schema.sql`。
- 已执行迁移不可改写；后续修订必须新增迁移。
- 每项迁移在独立事务中执行；并发执行器由 advisory lock 串行化。
- 第一闸门只允许向后兼容的增加式迁移，不提供自动 down。
- PostgreSQL enum 不进入首版，冻结代码使用 `text + CHECK`。
- 月份保存为月初 `date`，时间点保存为 `timestamptz`。

## 5. 真实环境验收状态

2026-08-20 已在 Docker Desktop 4.87.0 的 PostgreSQL 18.4 容器完成首轮验证：

- [x] 从空卷执行首迁移，再次执行并确认幂等跳过；
- [x] 修改已执行迁移后确认 SHA-256 不一致会失败；
- [x] 并发激活两个已校验候选，最终只有一个活动状态和一个活动指针；
- [x] 使用三类实际凭据运行 `pnpm db:verify`；
- [x] 候选版本可写、已校验版本不可追加业务行，运行角色不能读取候选基础表；
- [x] 重叠有效期线路被 PostgreSQL 排斥约束拒绝；
- [x] 从隔离空库导入固定数据包、运行核心 9 题、原子激活并重复发布确认幂等；
- [x] 验证候选失败关闭边界、退役版本事务回切和应用只见唯一活动版本；
- [x] 保存两个核心查询的 `EXPLAIN (ANALYZE, BUFFERS)` 基线；两次执行均无临时磁盘
      写入，隔离空库实测分别为 1.164 ms 和 0.716 ms。

基线文件位于 `database/query-plans/gate1-core-baseline.json`。这些单次结果只用于结构和
明显退化检查，不能替代查询服务完成后的并发 5、100 次热查询 P95 验收。

## 6. Docker Desktop 4.87 临时通信文件故障

本机若在 Docker 停止后再次启动时出现 `file cannot be accessed by the system`，并指向
`sailor-ingest.sock`、`dockerInference` 或 `docker-secrets-engine/engine.sock`，属于
Docker Desktop 的本地运行时通信文件残留，不是数据库卷或项目迁移损坏。不要选择
“Reset to factory defaults”。应先强制停止 Docker Desktop，把以下纯临时目录改名保留
为带时间戳的备份，再创建空目录并重新启动：

- `%LOCALAPPDATA%\Docker\run`
- `%LOCALAPPDATA%\docker-secrets-engine`

该操作不处理 `%LOCALAPPDATA%\Docker\wsl`、Docker volumes 或项目目录。恢复后先确认
Docker 状态为 `running`、`logiplan-postgres-1` 为 `healthy`，再执行迁移或发布命令。
