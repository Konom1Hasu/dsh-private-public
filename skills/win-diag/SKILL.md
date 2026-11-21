---
name: win-diag
description: Use on Windows for process/port/service diagnosis in one command instead of hand-writing Get-NetTCPConnection 和 Get-CimInstance 组合 — 谁占了端口、进程树、命令行全文、监听清单、按端口安全杀进程。当用户说「端口被占了」「谁在监听 3080」「这个进程的完整命令行」「帮我看看这个服务」时用。不用于性能调优。
---

# win-diag — Windows 进程/端口/服务诊断

脚本：`C:\Users\KonomiHasu\.dsh\skills\win-diag\diag.ps1`

## 为什么单独做一个 skill

这些诊断每次都要手写 `Get-NetTCPConnection | Select-Object OwningProcess` 再 `Get-CimInstance` 反查，五个命令拼一遍。而且踩过两次坑：

- `Get-NetTCPConnection -LocalPort X` **有时查不到**（IPv6 绑定、TIME_WAIT 残留），`netstat -ano` 能查到
- 按命令行正则杀进程**不可靠**：`dsh\\lib\\bin\.js` 匹配不到 `.../dsh/lib/bin.js`（正斜杠）

所以脚本里端口用 netstat 兜底，杀进程只认 PID。

## 命令

```powershell
$D = "C:\Users\KonomiHasu\.dsh\skills\win-diag\diag.ps1"

powershell -File $D port 3080          # 谁占了 3080（含完整命令行）
powershell -File $D ports 3080 3081    # 批量查
powershell -File $D listen             # 全部监听端口（按端口排序）
powershell -File $D proc node          # 某名字的进程树
powershell -File $D tree 8280          # 某 PID 的父子链
powershell -File $D killport 3081      # 按端口杀（会先打印目标，再确认）
```

## 机制要点（别踩）

- 端口查询**先 Get-NetTCPConnection，查不到回退 netstat -ano**。两者结果不一致时以 netstat 为准。
- 杀进程**只按 PID**，不用命令行匹配。匹配用宽松正则 `bin[\\/]+js` 同时容纳正反斜杠。
- `Get-CimInstance Win32_Process` 的 `CommandLine` 在某些权限下为空，这时退回 `Get-Process | Select Path`。
- 进程树用 `CreationDate` 排序，父进程通常创建更早；不要假设 PID 大小顺序。

## 已知限制

- 需要相应权限才能看到其他用户进程的命令行（管理员更好）。
- 不解析 Windows 服务状态（用 `Get-Service` 更直接）。
- `killport` 是破坏性的：会先打印要杀的进程，再要求确认；加 `-Force` 才免确认。
