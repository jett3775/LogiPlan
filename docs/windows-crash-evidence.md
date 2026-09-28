# Windows 侧 `3221226505` 取证与崩溃转储配置

版本：V1.0
日期：2026-09-28
状态：**待用户在本机执行**（机器级配置改动，需单独批准）。本文件只给步骤与判据，未在沙箱执行任何操作。
依据：D-188（稳定性权威证据来源与本地 Windows 环境限制）、`docs/handoff-2026-09-25.md` §T6 的既有分析、
路线图 §0 遗留项 6。

---

## 0. 一句话目标

把 `3221226505`（十进制，= `0xC0000409`）从"未定位"推进到"已定性"，并回答 T6 的唯一关键问题：
**崩溃进程是 Playwright worker、Chromium/Firefox 浏览器进程，还是 Node 宿主**——三者缓解路径完全不同。

## 1. 只读取证（**该轮已于 2026-09-25 执行完毕，不要重复**）

**已完成的那一轮**（经用户授权，仅读事件日志与 WER 报告，无任何启动参数或代码改动）结论见 **D-188**：

- Application 日志 Id=1000/1001 共 **400 条**（覆盖 2026-09-18 → 09-25），匹配 `c0000005` 的为 **0 条**；
  Id=1000 仅 42 条，故障应用均为与本项目无关的系统或驱动组件。
- `ReportArchive` 中**没有** node.exe / chrome.exe / firefox.exe / playwright 的任何报告；
  Playwright 的 Chromium profile 下**没有** Crashpad 报告；WER 未被禁用。
- 该机器确有一份浏览器转储（2026-09-21，`firefox.exe`），但其 profile、URL 与模块显示是**用户自己的 Firefox**，
  与 Playwright 捆绑构建（`firefox-1538`）无关，D-188 已明确不得计入本项目证据。

**因此本节剩下的唯一用途**：在**采集到新的崩溃之后**再查一次同源记录，确认这次是否终于留下现场。
查询命令与字段提取方式如下（同时覆盖两个致命代码，见 §1.1 的精度说明）：

### 1.1 查询 Windows 事件日志

以**管理员** PowerShell 执行（只读）：

```powershell
# Application 日志中最近的 WER 报告事件（1000 = 应用崩溃，1001 = WER 报告）
Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001} -MaxEvents 40 |
  Where-Object { $_.Message -match '0xc0000409|3221226505|0xc0000005|chrome|firefox|node' } |
  Select-Object TimeCreated, Id, ProviderName, @{n='Msg';e={$_.Message}} |
  Format-List
```

**要提取的三个字段**：`Faulting application name`、`Faulting module name`、`Exception code`。
`Exception code` **以实测值为准**（预期落在 `0xc0000409` 或 `0xc0000005` 之一）。

> **⚠️ 十进制/十六进制精度问题（D-188 与本文件此前均已受累）**：
> `3221226505`（十进制）换算为 **`0xC0000409`**（`STATUS_STACK_BUFFER_OVERRUN`，通常由 fail-fast / `__fastfail`
> 触发）；而 **`0xC0000005`** 是 `STATUS_ACCESS_VIOLATION`，其十进制是 `3221225477`。
> D-188 第 1 行把 `3221226505` 与 `0xC0000005` 写作同一码，属**文档精度问题**，不改其三条决策结论。
> 这对诊断有实际影响：**fail-fast 崩溃通常不以 Id=1000「应用程序错误」的形式留下 WER 记录**，
> 这与 D-188「Windows 层面无任何可归因记录」的观察一致。因此本节命令**同时覆盖两个代码**，
> 复现后**以实测到的 Exception code 为准**，并据此选择 §3 的后续路径。

### 1.2 检查 WER 报告目录（只读）

```powershell
Get-ChildItem 'C:\ProgramData\Microsoft\Windows\WER\ReportArchive','C:\ProgramData\Microsoft\Windows\WER\ReportQueue' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 20 LastWriteTime, Name
```

打开与崩溃时间最接近的报告目录里的 `Report.wer`，其中 `AppName`/`AppPath`/`Sig[3]`（异常代码）
即可回答 §0 的关键问题。

**若 §1.1–§1.2 已能给出 Faulting module 结论，就不必进入 §2**——那是最小代价路径。

## 2. 需要更完整现场时：启用 LocalDumps（机器级配置，需批准）

### 2.1 只针对目标可执行文件，不要全系统采集

LocalDumps 支持在 `LocalDumps\<image name>` 子键下按**单个映像名**配置。Playwright 的浏览器位于：

- Chromium：`%USERPROFILE%\AppData\Local\ms-playwright\chromium-<rev>\chrome-win\chrome.exe`
- Firefox：`%USERPROFILE%\AppData\Local\ms-playwright\firefox-<rev>\firefox\firefox.exe`

镜像名分别为 `chrome.exe` 与 `firefox.exe`。**建议先只对当前复跑使用的那个目标启用**，
以免一次采集把磁盘写满（完整转储通常是数百 MB 级，且每次崩溃都会写一份）。

```powershell
# 以管理员执行；DumpType=2 为完整转储，DumpCount 限制份数
$root = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
$dump = "$env:USERPROFILE\Desktop\logiplan-crashdumps"
New-Item -Path $dump -ItemType Directory -Force | Out-Null

New-Item -Path "$root\chrome.exe" -Force | Out-Null
Set-ItemProperty -Path "$root\chrome.exe" -Name DumpFolder -Value $dump -Type ExpandString
Set-ItemProperty -Path "$root\chrome.exe" -Name DumpType   -Value 2 -Type DWord
Set-ItemProperty -Path "$root\chrome.exe" -Name DumpCount  -Value 3 -Type DWord
```

Firefox 目标把子键名换成 `firefox.exe` 重复一次即可。

### 2.2 复现

按仓库既有口径复跑（runbook §0 记录的编排变量）：

```powershell
$env:LOGIPLAN_GATE1_TARGET = 'firefox'   # 或 'chromium'
$env:LOGIPLAN_GATE1_REPEAT = '20'
pnpm verify:gate1:isolated
Remove-Item Env:LOGIPLAN_GATE1_TARGET, Env:LOGIPLAN_GATE1_REPEAT
```

命中率约 20%/次，因此需要重复若干轮；**命中时保留现场，不重跑掩盖**（D-188 的重试政策）。

### 2.3 清理（采集完立刻做）

```powershell
Remove-Item -Path 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\chrome.exe' -Recurse -Force
# firefox.exe 同理
```

保留转储文件至结论写入文档后再删除；若转储体积过大，先只保留最小必要的一份。

## 3. 判据与结论去向

| 观察结果                                                      | 结论            | 后续                                                                                  |
| ------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| Faulting application 是 `chrome.exe` / `firefox.exe`          | 浏览器进程崩溃  | 属可缓解项，按 T6 第 2 步提**最小改动方案**并单独申请批准（不得擅自改浏览器启动参数） |
| Faulting application 是 `node.exe`，module 指向第三方原生模块 | Node 宿主崩溃   | 另立排查项，与浏览器无关                                                              |
| 事件日志与 WER 均无对应记录                                   | 采集不足        | 进入 §2 启用 LocalDumps 后复跑                                                        |
| 仍未定性                                                      | 维持 D-188 现状 | 不新增决策；本地 Windows 仍记为已接受的环境限制                                       |

**结论落盘位置**：路线图 §0 遗留项 6（Faulting module 结论）与 `docs/decisions.md`（若需新增或修订决策）。

**按 Exception code 分流**：

- **`0xc0000409`（fail-fast）**：WER 通常**不会**为 fail-fast 生成 Id=1000「应用程序错误」事件，
  因此必须走 §2 的 LocalDumps 路径才能取到现场；同时注意 fail-fast 可能由控制流保护/栈保护等
  安全缓解触发，与"普通内存错误"的排查方向不同。
- **`0xc0000005`（访问违例）**：优先从 §1.2 的 WER 报告里取 `Faulting module`，通常无需转储即可定性。

## 4. 边界（不得越线）

- 本流程**只做取证**：**不改浏览器启动参数**、不改并发度、不改测试断言（D-188 与既有授权边界）。
- 注册表改动属机器级配置，执行前需你明确批准；本文件不代替该批准。
- 采集的转储可能包含内存中的页面内容与凭据片段，**不得提交进仓库**，也不得贴进对话。
