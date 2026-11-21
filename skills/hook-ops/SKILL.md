---
name: hook-ops
description: Use for dynamic instrumentation with Frida on local processes — attach 进程、trace 函数调用与返回值、dump 内存、调用进程内函数、绕过反调试/反虚拟机检测。当用户说「hook 这个函数」「跟一下调用」「dump 内存」「把反调试过掉」「动态看一下」时用。静态分析用 bin-arsenal。
---

# hook-ops — Frida 动态插桩

脚本：`C:\Users\KonomiHasu\dsh-private\skills\hook-ops\hookops.py`
依赖：`frida 17.26.3`（已装）

**实测**：启动目标进程 → attach → 执行 JS → 拿模块列表 → detach，全链路通。

## 命令

```powershell
$H = "C:\Users\KonomiHasu\dsh-private\skills\hook-ops\hookops.py"

python $H list   [--filter 名字片段]        # 列进程
python $H info   <pid或进程名>              # 架构/模块/主模块基址
python $H trace  <pid|名> --func NAME [--module DLL] [--count N] [--timeout S]
python $H dump   <pid|名> --addr 0x... --size N [--out 文件]
python $H call   <pid|名> --func NAME [--module DLL] [--args '0,0,0']
python $H bypass <pid|名> [--profile anti-debug|anti-vm|all] [--timeout S]
python $H js     <pid|名> --file 脚本.js     # 跑自定义 Frida JS
```

## 三种 attach 方式

| 方式 | 用途 | 命令 |
|---|---|---|
| attach 到已运行进程 | 最常见 | `trace 1234 --func X` |
| 按名字 attach | 免查 pid | `trace notepad.exe --func X` |
| spawn 后立即注入 | 抓启动阶段 | `js --spawn 程序.exe --file hook.js` |

## trace 怎么用

```powershell
# hook KERNEL32 的 CreateFileW，打印路径
python $H trace 1234 --func CreateFileW --count 20

# hook 自己 DLL 里的函数
python $H trace 1234 --module mylib.dll --func decrypt --count 50
```

输出：

```
[CreateFileW] #1
  0x1 arg0 = 0x7ff...  (宽字符串)
  → 返回 0x1a4
```

**看什么**：
- 参数里的**字符串指针**（自动尝试按 ASCII/UTF-16 解）
- 返回值异常（`-1` / `0` / `NULL` = 失败）
- 调用频率（循环解密会有几百次）

## dump 内存

```powershell
python $H dump 1234 --addr 0x140000000 --size 0x10000 --out mem.bin
```

**脱壳用法**：壳解压完在内存里是明文，dump 出来就是脱壳后的镜像。

找 OEP 的笨办法：
1. `hook VirtualProtect`（改内存属性 = 解压完成）
2. 或者 `hook` 到 `.text` 节首地址，看什么时候变成可执行

## call 调用函数

```powershell
python $H call 1234 --func MessageBoxW --args '0,0,0,0'
```

用 `NativeFunction` 在目标进程里直接调用导出函数。用于：
- 解密函数直接喂输入
- 验证校验逻辑（绕过 UI 直接问「这个 key 对不对」）

## bypass 反调试 / 反虚拟机

```powershell
python $H bypass 1234 --profile anti-debug   # 只过反调试
python $H bypass 1234 --profile all          # 反调试 + 反 VM
```

**覆盖的检测点**：

| 检测 | 手法 |
|---|---|
| `IsDebuggerPresent` | 强制返回 0 |
| `CheckRemoteDebuggerPresent` | 输出参数写 0 |
| `NtQueryInformationProcess` | ProcessDebugPort(7)/Flags(0x1f)/ObjectHandle(0x1e) 全部返回「无调试」 |
| `OutputDebugString` | 空操作（有些程序用它探测） |
| `NtSetInformationThread` | 拦 HideFromDebugger 反而暴露，直接放行 |
| `GetTickCount` / `QueryPerformanceCounter` | 时间差抹平（单步/防沙箱） |
| `CPUID` hypervisor 位 | 清掉 ECX bit 31 |
| 窗口类名 / 进程枚举 | 可选：隐藏常见调试器名字 |

## 常见失败原因（先看这个，别乱试）

| 现象 | 原因 |
|---|---|
| `Failed to attach: access denied` | 权限不足 → 管理员运行；或目标有保护 |
| **`Unable to allocate target memory`** | **同一目标被连续 attach 太多次**（实测第 3 次起必现）。换个目标，或等一会儿，或重启目标 |
| attach 成功但 hook 不生效 | **位数不匹配**：x64 Python 只能注入 x64 进程 |
| 目标直接退出 | 有反调试，先跑 `bypass` 再 attach |
| hook 到了但没输出 | 函数没被调用；或该函数不在任何导出表里（内联/静态函数 hook 不到） |
| `access violation accessing 0x...` | **地址无效**——ASLR 让每次运行基址不同，用 `info` 现查，别复用旧地址 |
| `ProcessNotFoundError` | 按名字 attach 时目标还没启动 |
| 命令卡住不动 | frida C 层错误不抛异常。脚本有 watchdog（timeout+25s）会掐断并退出码 3 |

## 实测记录（2026-11-13）

| 操作 | 结果 |
|---|---|
| `info` | 3.9s，42 个模块，关键模块地址正确 |
| `trace Sleep` | **抓到调用**，`arg0 = 0x14` = 20ms 正确，`返回 0x0` |
| `dump` | 成功写出 64 字节 |
| 连续 attach 同一目标 | 第 1、2 次成功，**第 3 次报 allocate 错误** |
| 注入自身子进程 | 全链路通（attach→JS→模块枚举→detach） |

frida 本身很快：`import 0.10s` / `attach 0.18s` / `enumerate 1.75s`。
如果你觉得慢，多半是 PowerShell 管道 `\| Select-Object` 在等其他进程退出。

## 已知限制

- **只能注入同位数进程**（x64 Python → x64 进程）。32 位目标需要 32 位 Python + 32 位 frida
- 有内核级保护的进程（反作弊、EDR）注入会失败或蓝屏，**不要在带反作弊的游戏上试**
- frida-server 远程注入需要目标机器上有对应版本
- `bypass` 只覆盖用户态常见检测，内核级检测过不了
- trace 大量调用会严重拖慢目标（每次 hook 都有开销），加 `--count` 限流

## 底线

- 只在自己拥有的程序/本地样本上做
- 注入前先记录目标进程的 pid 和命令行，出事能定位
- 不要在系统关键进程（`csrss.exe` / `winlogon.exe` / `services.exe`）上实验
- 需要执行样本时用独立虚拟机
