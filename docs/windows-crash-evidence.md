# Windows 侧 `3221226505` 取证与崩溃转储配置

版本：V1.4
日期：2026-10-08
状态：**取证已执行一轮、未命中（2026-10-08）——结论：仍未定性，维持 D-188**。
本文件曾于 2026-09-28 挂起（理由「当前无可用 Windows 机器」）；**2026-10-08 用户确认当前主力开发机为
Windows**（`DESKTOP-1UIFBM1`，win32 / x64，Windows 10.0.26200），macOS 27.0 / 26A428（arm64）
**仅在非工作时间段可能用于开发** ⇒ 挂起理由不再成立。同日经用户指示「执行取证」，推进如下：
§1 只读取证已复跑（**仍无任何可归因记录**，见 §1 的 2026-10-08 段）；§2.1 的 LocalDumps 已按
**实测**映像名配置；**§2.2 已由用户在本机终端执行一次完整 Gate 1——全绿、未命中崩溃**（见 §2.2 的
2026-10-08 段），因此**没有产生任何转储**；按 §3 判据表落在「仍未定性」一行，**维持 D-188 现状、
不新增决策**。
**⚠️ 未关闭**：§2.3 的清理命令在**非提权**终端下会**静默失败**，2026-10-08 实测四个子键**仍在注册表内**
（处置见 §2.3 的陷阱说明）。
恢复口径已记入 `docs/current-plan.md` §6 第 3 项（**不新增决策**，D-188 正文不改）。
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

**2026-10-08 复跑（同一台机器，只读）**：本机 `LastBootUpTime` = **2026-09-24 18:41**，即 09-21 / 09-22 /
09-24 三轮崩溃与本次取证是**同一台机器**（此前文档未记录这一点）。复跑结果与 2026-09-25 一致，
**仍无任何可归因记录**：

- Application 日志 Id=1000/1001 最近 15 条**全为 1001**（`Windows Error Reporting`），时间集中在
  2026-10-08 12:02—12:58；以 `0xc0000409|3221226505|0xc0000005|chrome|firefox|node|playwright`
  过滤最近 60 条，**匹配 0 条**。
- `ReportArchive` / `ReportQueue` 最近 20 项为 `Kernel_*`（LiveKernelEvent）、`NonCritical_Update`、
  `AppCrash_ipf_helper.exe`（2026-09-24 19:24）、`AppHang_Microsoft.OneDri`；**没有** node / chrome /
  firefox / playwright 的任何报告。
- WER 未被禁用（`Disabled` / `LoggingDisabled` / `DontShowUI` 三项均未设置）。
- 本机 `LocalDumps` 原有一条**与本项目无关**的既有配置：`WeaselServer.exe`（用户输入法，`DumpType=0`、
  `DumpCount=10`、目录 `%TEMP%\rime.weasel`）——**不得改动或删除**。
- 与 §1.1 的精度说明自洽：fail-fast（`0xC0000409`）通常**不**留下 Id=1000 事件，故「无记录」不能
  反证未发生崩溃。

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

LocalDumps 支持在 `LocalDumps\<image name>` 子键下按**单个映像名**配置。**先用仓库自带命令拿到本机实际路径与可执行文件名，不要凭记忆猜**：

```powershell
pnpm exec playwright install --dry-run
```

输出会逐个列出各浏览器的安装位置（形如 `%USERPROFILE%\AppData\Local\ms-playwright\firefox-<rev>\firefox\firefox.exe`）。
需要覆盖的映像名取决于你要复跑的模式：

| 复跑模式                                                  | 参与的浏览器进程             | 建议配置的映像名                                                                                               |
| --------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `LOGIPLAN_GATE1_TARGET=firefox`（定向重复）               | 仅 Playwright 捆绑的 Firefox | `firefox.exe`、`plugin-container.exe`（Firefox 内容进程）                                                      |
| `LOGIPLAN_GATE1_TARGET=snapshot`                          | 不启动浏览器                 | 不需要转储                                                                                                     |
| full（不设 TARGET，含 Chromium 双视口冒烟与历史证据验收） | Firefox + Chromium           | `firefox.exe`、`plugin-container.exe`，以及 Chromium 的 `chrome.exe`；无头模式另需 `chrome-headless-shell.exe` |

**2026-10-08 实测更正（原表格有两处错误，勿再沿用）**：

- 无头 Chromium 的进程名是 **`chrome-headless-shell.exe`**，**不是** `headless_shell.exe`（后者不存在）。
- Firefox 的内容进程是 **`plugin-container.exe`**：`0ms` 失败、无用例输出这一形态很可能落在内容进程上，
  只配 `firefox.exe` 会漏掉它。
- 本机实测路径（`node_modules/@playwright/test/cli.js install --dry-run`）：Firefox 153.0 →
  `%LOCALAPPDATA%\ms-playwright\firefox-1538\firefox\firefox.exe`；Chromium 151.0.7922.34 →
  `…\ms-playwright\chromium-1234\chrome-win64\chrome.exe`；无头 shell →
  `…\ms-playwright\chromium_headless_shell-1234\chrome-headless-shell-win64\chrome-headless-shell.exe`。
- 本机 `LocalDumps` 下已有一条**与本项目无关**的既有子键 `WeaselServer.exe`（用户输入法），
  **不要动它**，§2.3 的清理也不得把它删掉。

**先只对你要复跑的那一个模式启用**，以免一次采集把磁盘写满（完整转储通常是数百 MB 级，每次崩溃写一份）。

```powershell
# 以管理员执行；DumpType=2 为完整转储，DumpCount 限制份数
$root = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
$dump = "$env:USERPROFILE\Desktop\logiplan-crashdumps"
New-Item -Path $dump -ItemType Directory -Force | Out-Null

# 本机 2026-10-08 实际配置的就是这四条
foreach ($image in @('firefox.exe','plugin-container.exe','chrome.exe','chrome-headless-shell.exe')) {
  New-Item -Path "$root\$image" -Force | Out-Null
  Set-ItemProperty -Path "$root\$image" -Name DumpFolder -Value $dump -Type ExpandString
  Set-ItemProperty -Path "$root\$image" -Name DumpType   -Value 2 -Type DWord
  Set-ItemProperty -Path "$root\$image" -Name DumpCount  -Value 3 -Type DWord
}
```

### 2.2 复现（并自动留痕）

`LOGIPLAN_GATE1_TARGET` **只接受 `firefox` 与 `snapshot`**（没有 `chromium`）；
设了 `TARGET` 或 `REPEAT > 1` 时，脚本会**自动开启时间线埋点**，逐行写 JSON 记录
`iteration / event / at_ms / detail`——这正是逐次退出码与失败阶段的机器可读记录，无需手工誊抄。
默认落在 `%TEMP%\logiplan-gate1-timeline-<pid>.jsonl`；建议显式指定到工作目录。

复现命令用**平台中立的包装器**（Windows 与 macOS 同一条命令，见 runbook §0.3 的跨平台口径），
因此不需要手工设置/清理环境变量；`--timeline` 缺省即工作目录下的 `gate1-timeline.jsonl`：

```powershell
node scripts/run-gate1.mjs --target firefox --repeat 20 2>&1 | Tee-Object -FilePath "$PWD\gate1-run.log"
```

命中率约 20%/次，因此需要重复若干轮；**命中时保留现场，不重跑掩盖**（D-188 的重试政策）。
命中后先做 §1 的只读取证，再原样重跑，两次都要如实记录。

**2026-10-08 执行记录（未命中）**：用户在本机终端执行 `pnpm install --frozen-lockfile`（466 包、
1m51.9s，**锁文件未变**）后运行完整 `pnpm verify:gate1:isolated`，**退出码 0、全阶段通过**：
数据库集成四条腿 `44/44`、`44/44`、`10/10`、`7/7`（零 fail，skipped 与声明一致）；隔离 PostgreSQL 18.4 上
`0001—0003` → V1 → `0004—0010` → V2 校验/激活/幂等；`db:verify`、`db:verify-release`、`db:verify-plans`
（6 条计划 `temp_written_blocks` 全 0）；生产构建；快照集成 `28/28`；Chromium 双视口基础
`24 passed / 22 skipped`；Chromium 历史证据 `22/22`；**Firefox 核心冒烟 `3/3`**；并发 5 × 100 热查询
`p50 27.399ms / p95 49.877ms / p99 56.911ms`（P95 预算 1 s）；隔离容器、卷、网络全部移除。
**全程未出现 `3221226505`，转储目录为空**——即**本轮未命中**（历史命中率约 20%/次，一轮未命中
不构成任何反证）。本次运行同时充当闸门二切片 1b 的 AC1.1 / AC1.11 本机验收证据。

### 2.3 清理（采集完立刻做）

```powershell
# 必须以**管理员** PowerShell 运行；只删本项目配置的四条，
# 不得动 WeaselServer.exe（用户输入法，既有配置）
if (-not ([Security.Principal.WindowsPrincipal]::new(
      [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
  throw '需要管理员权限：非提权运行时 Remove-Item 会因 Access Denied 失败'
}
foreach ($image in @('firefox.exe','plugin-container.exe','chrome.exe','chrome-headless-shell.exe')) {
  $path = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\$image"
  if (Test-Path $path) { Remove-Item -Path $path -Recurse -Force }   # 不吞错
}
# 回读确认：删干净时应只剩 WeaselServer.exe
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps' |
  Select-Object -ExpandProperty PSChildName
```

> **⚠️ 陷阱（2026-10-08 实测）**：本节原命令带 `-ErrorAction SilentlyContinue`，在**非提权**终端下
> `Remove-Item` 对 `HKLM` 会报 Access Denied 而**被静默吞掉**——命令看起来执行成功，四个子键其实
> 一个都没删（实测结果：四个子键仍在）。**判据不能看命令有没有报错，只能回读子键列表**
> （上面最后一条）。清理后必须只剩 `WeaselServer.exe`。

保留转储文件至结论写入文档后再删除；若转储体积过大，先只保留最小必要的一份。

**转储文件名即崩溃进程名**（WER 以映像名 + 进程号命名，如 `firefox.exe.12345.dmp`）——
仅凭文件名就能回答 §0 的关键问题"崩溃的是谁"，不装调试器也能推进到结论；
进一步要 `Faulting module`，再用 WinDbg 打开转储执行 `!analyze -v`（可选，非必需）。

## 3. 判据与结论去向

| 观察结果                                                      | 结论            | 后续                                                                                  |
| ------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| Faulting application 是 `chrome.exe` / `firefox.exe`          | 浏览器进程崩溃  | 属可缓解项，按 T6 第 2 步提**最小改动方案**并单独申请批准（不得擅自改浏览器启动参数） |
| Faulting application 是 `node.exe`，module 指向第三方原生模块 | Node 宿主崩溃   | 另立排查项，与浏览器无关                                                              |
| 事件日志与 WER 均无对应记录                                   | 采集不足        | 进入 §2 启用 LocalDumps 后复跑                                                        |
| 仍未定性                                                      | 维持 D-188 现状 | 不新增决策；本地 Windows 仍记为已接受的环境限制                                       |

**结论落盘位置**：路线图 §0 遗留项 6（Faulting module 结论）与 `docs/decisions.md`（若需新增或修订决策）。

**2026-10-08 结论**：按本表落在**「仍未定性」**一行——本轮完整 Gate 1 全绿且未出现 `3221226505`，
**没有现场可供定性**；因此**维持 D-188 现状、不新增决策**，本地 Windows 仍记为已接受的环境限制
（CI 为稳定性权威证据）。后续若要继续追，需在**下一次**运行前重新执行 §2.1，并注意 §2.3 的提权要求。

**按 Exception code 分流**：

- **`0xc0000409`（fail-fast）**：WER 通常**不会**为 fail-fast 生成 Id=1000「应用程序错误」事件，
  因此必须走 §2 的 LocalDumps 路径才能取到现场；同时注意 fail-fast 可能由控制流保护/栈保护等
  安全缓解触发，与"普通内存错误"的排查方向不同。
- **`0xc0000005`（访问违例）**：优先从 §1.2 的 WER 报告里取 `Faulting module`，通常无需转储即可定性。

## 4. 边界（不得越线）

- 本流程**只做取证**：**不改浏览器启动参数**、不改并发度、不改测试断言（D-188 与既有授权边界）。
- 注册表改动属机器级配置，执行前需你明确批准；本文件不代替该批准。
- 采集的转储可能包含内存中的页面内容与凭据片段，**不得提交进仓库**，也不得贴进对话。
