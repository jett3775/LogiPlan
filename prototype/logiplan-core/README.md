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

三个结构方案使用同一路径，通过查询参数切换：

- `?variant=A`：经营驾驶舱分栏；
- `?variant=B`：分析工作台侧轨；
- `?variant=C`：管理简报画布。

可继续附加 `&view=dashboard` 或 `&view=attribution` 分享具体页面。底部切换条和左右方向键只用于原型比较。

## 原型问题

哪种桌面信息结构最适合贯通“全年风险 → 英国异常 → 五因素归因 → 多维下钻 → AI 管理分析 → 数字证据”？

所有方案读取同一个 `prototype-data.json`。该快照由 `scripts/generate_prototype_snapshot.py` 从已审计演示数据生成，并已通过 E01、E04、E05—E10、E20 共 9 项基线校验。

## 验收结论

待用户选择方案后记录：

- 选定方案：`待填写`；
- 保留结构：`待填写`；
- 吸收的其他方案元素：`待填写`；
- 原因：`待填写`。

确认后应删除未选方案和原型切换条，并按冻结契约重新实现正式页面。
