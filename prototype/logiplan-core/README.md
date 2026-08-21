# LogiPlan AI 核心桌面原型

> PROTOTYPE：此目录是用于选择信息结构的可丢弃代码，不是生产应用。

## 运行

在项目根目录执行：

```powershell
python -m http.server 4173
```

打开：

```text
http://localhost:4173/prototype/logiplan-core/
```

原型已固定为方案 B“分析工作台侧轨”。可附加 `?view=dashboard` 或 `?view=attribution` 分享具体页面。

## 原型目标

验证方案 B 是否能够稳定贯通“全年风险 → 英国异常 → 五因素归因 → 多维下钻 → AI 管理分析 → 数字证据”。

所有方案读取同一个 `prototype-data.json`。该快照由 `scripts/generate_prototype_snapshot.py` 从已审计演示数据生成，并已通过 E01、E04、E05—E10、E20 共 9 项基线校验。

该 JSON 仅用于可丢弃原型和正式实现的测试对照，不是正式应用运行数据源。正式核心纵向切片按 D-127 从标准化 PostgreSQL 关系表执行查询并生成证据。

## 验收结论

- 选定方案：`B · 分析工作台侧轨`；
- 保留结构：左侧固定导航与范围摘要、主分析区、横向五因素命令带、右侧持续可见的 AI 分析记录、全宽多维归因表；
- 吸收的其他方案元素：无；
- 原因：优先支持高频异常识别、范围核对、因素切换、逐层下钻和证据复核，并持续保留分析上下文。

A/C 方案和原型切换功能已经移除。人工视觉与核心交互验收通过后，按冻结契约重新实现正式页面。

人工验收结果记录在 `docs/prototype-validation.md`。1440px 与 1280px 两档均完成复验前，不冻结查询与证据契约。
