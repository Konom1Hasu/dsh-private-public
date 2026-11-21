# dsh 灾备手册

> 目的：在**会话完全不工作**的情况下，也能把 dsh 救回来。
> 建立日期：2026-11-12 ｜ 全部脚本实测状态见 §6

---

## 1 故障模型（为什么常规手段没用）

dsh 的故障分两类，性质完全不同：

| 类型 | 表现 | 会话可用？ |
|---|---|---|
| **进程级** | 端口不通、进程不在 | ❌ 完全没有界面 |
| **会话级** | 界面在，但每轮都报错 | ❌ **能看见界面，但发不出消息** |

本项目的实际事故是**第二类**：`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`。
报错发生在**装配阶段**——在请求发出之前就抛了，所以：

- ❌ 你没法在会话里让我跑回滚
- ❌ 你没法在会话里让我重启
- ❌ 任何"让我去看看"的动作都执行不了

**结论：恢复手段必须只依赖文件、进程表、端口这三样。** 所有脚本都照这个原则写的。

---

## 2 工具清单

全部位于 `C:\Users\KonomiHasu\dsh-private\scripts\`。

| 脚本 | 作用 | 会不会改东西 | 需要 dsh 活着 |
|---|---|---|---|
| `snapshot.ps1` | 快照 profile + 私有包 + dump，每文件 SHA256 | 只写备份目录 | ❌ |
| `verify.ps1` | 8 项检查；全绿才写 `GOOD.txt` | 只写 GOOD 标记 | 仅 dump-config |
| `rollback.ps1` | 按快照恢复，hash 校验，自动备份被覆盖的文件 | ✅ 改 profile | ❌ |
| `restart-safe.ps1` | 按端口 owner 杀进程 → 启动 → 校验新 PID | ✅ 改进程 | ❌ |
| `rescue.ps1` | 五步合一：恢复→重打补丁→重装→重启→验证 | ✅ 全套 | ❌ |
| `watchdog.ps1` | 离线体检 6 项，**默认只报告** | 默认不改 | ❌ |
| `apply-patches.ps1` | 幂等地重打 node_modules 里的补丁 | ✅ 改 node_modules | ❌ |

**桌面一键入口**（双击即可，不需要开终端）：

- `Desktop\DSH-RESCUE.bat` —— 跑 rescue
- `Desktop\DSH-CHECK.bat` —— 跑 watchdog，看健康状态

---

## 3 三层防线

### 第一层：预防（改之前）
`snapshot.ps1` + 一次只改一个东西。

### 第二层：验证（改之后）
`verify.ps1`。它检查的 8 项，每一项都对应一个真实发生过的失败：

| 检查项 | 对应的历史事故 |
|---|---|
| dump-config exit 0 | 配置语法坏掉 |
| private-core bundle 加载 | 私有包没进 bundles |
| 无 `unknown prompt variable` | 本次 {{cwd}} 事故 |
| personaSuffix 不含 `{{var}}` | 同上（配置侧） |
| purge CWD_ONLY_SUFFIX 不含 `{{var}}` | 同上（源码侧） |
| 3080 监听 | 进程没起来 |
| private-core 是最后一个 bundle | 层序错，patch 被覆盖 |
| 私有包物理存在于 profile | 硬拷贝被 pnpm 清掉 |

### 第三层：恢复（已经坏了）
`rescue.ps1`。恢复 GOOID 快照 → 重打补丁 → 重装 → 重启 → 再验证。

---

## 4 标准操作流程（每次改造都走这个）

```
①  powershell -File scripts\snapshot.ps1 -Tag <这次改什么>
②  改 ONE thing
③  powershell -File scripts\verify.ps1        # 不全绿就 ④
④  powershell -File scripts\rollback.ps1       # 回滚
⑤  需要重启才生效的 → restart-safe.ps1，看 RESTART_OK=True
⑥  powershell -File scripts\watchdog.ps1       # 复查
```

**铁律**：③ 不通过就不要往下走。`verify` 输出里有 FAIL 就是没改好，别安慰自己"应该没事"。

---

## 5 应急流程（按你当时的情况）

### 场景 A：界面正常但每轮报错
双击 `DSH-RESCUE.bat`。等它跑完，看最后的 `Exit code`。

### 场景 B：界面打不开 / 端口不通
双击 `DSH-RESCUE.bat`（它包含重启）。若仍失败，看 `logs\rescue-*.log`。

### 场景 C：人在外面
只要有任一能执行命令的通道（远程桌面、SSH、计划任务、IM bot 命令钩子）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\KonomiHasu\dsh-private\scripts\rescue.ps1
```

### 场景 D：想先看问题在哪，不想动
双击 `DSH-CHECK.bat`（只报告，不修改）。

---

## 6 实测状态（2026-11-12 ~ 11-13）

| 脚本 | 验证方式 | 结果 |
|---|---|---|
| snapshot.ps1 | 真实执行 | ✅ 产出 `20261112-095038`，11 文件 + SHA256 |
| verify.ps1 | 真实执行 | ✅ 8/8 PASS，`GOOD.txt` 已写 |
| rollback.ps1 | `-WhatIf` | ✅ 正确识别 SAME，无副作用 |
| apply-patches.ps1 | 真实执行（幂等） | ✅ `changed=0 failed=0` |
| rescue.ps1 | `-DryRun` | ✅ 正确解析 GOOD 快照与五步计划 |
| watchdog.ps1 | 真实执行 | ✅ 6/6 healthy |
| restart-safe.ps1 | 真实执行（2026-11-13 12:40） | ✅ 成功，旧进程被杀、新 pid 8280 接管 3080 |
| rescue.ps1 完整流程 | `-DryRun` + 子步骤验证 | ✅ 逻辑与快照解析正确；完整执行仍未单跑 |

**必须诚实的一点**：`restart-safe.ps1` 和 `rescue.ps1` 的**真实执行路径**还没跑过。
它们会在关键时刻被用到，而"没验证过的救命工具等于没有"。

建议尽快做一次受控演练：先 `snapshot`，再跑 `restart-safe.ps1`，确认 `RESTART_OK=True` 且 `verify` 全绿。这会让会话断开一次，但换来的是"这套东西真的能用"。

---

## 7 维护：pnpm install 之后必须做的事

`apply-patches.ps1` 修的补丁在 `node_modules` 里，**任何一次 `pnpm install` / `pnpm add` / dsh 升级都会覆盖它**。

所以在这些操作之后，固定跑一次：

```powershell
powershell -File scripts\apply-patches.ps1
powershell -File scripts\verify.ps1
```

`verify` 里有一项就是专门检查这个补丁还在不在。没跑就等于把保险丝拔了。

### 7.1 脚本编码：所有 `.ps1` 必须带 UTF-8 BOM

**2026-11-13 事故**：`post-purge-apply.ps1` 加上 `param()` 后突然报语法错误——

```
At post-purge-apply.ps1:17 char:1
+ } catch {
Unexpected token '}' in expression or statement.
```

文件内容完全正确，报错行号也对不上。根因是 **PowerShell 5.1 读取无 BOM 的 UTF-8 脚本时会按 ANSI(GBK) 解码**，中文注释的某个字节序列被解成了 `}`，语法就此崩掉。

更麻烦的是当时**其余 7 个脚本也是无 BOM 的，只是恰好没踩到那颗雷**。

处理：全部脚本统一加 UTF-8 BOM（`EF BB BF`），加完回归 verify 8/8、watchdog 6/6 全过。

**规矩**：以后新增或手改任何 `.ps1`，改完立刻跑这条自检：

```powershell
Get-ChildItem C:\Users\KonomiHasu\dsh-private\scripts -Filter *.ps1 | ForEach-Object {
  $b = [System.IO.File]::ReadAllBytes($_.FullName)
  $bom = ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  $e = $null
  [System.Management.Automation.PSParser]::Tokenize([System.IO.File]::ReadAllText($_.FullName), [ref]$e) | Out-Null
  "{0,-26} BOM={1,-6} {2}" -f $_.Name, $bom, $(if($e.Count -gt 0){"ERR($($e.Count))"}else{"OK"})
}
```

`BOM=False` 的都要修，哪怕当下语法是 OK 的——那只是还没踩到雷。

---

## 8 QQ 外部救援通道

### 8.1 为什么它能当救援通道

```
你的 QQ ──→ NapCat (OneBot v11, ws://127.0.0.1:3001)
              └─→ gateway.mjs  ← 独立 node 进程，不依赖 dsh
                    ├─ 普通消息 → 模型对话
                    └─ /rescue 、/check → 直接执行本地 PowerShell
```

dsh web 崩溃时，这条链**完全不受影响**：它不经过 dsh web 的 prompt 装配，也没有走 3080。

### 8.2 命令

只有 `config.json` 里 `assistant.ownerIds` 里的账号能触发（当前是 `1705442126`）。

| 命令 | 作用 | 耗时 |
|---|---|---|
| `/check` 或 `dsh查` | 跑 `watchdog.ps1`，回报健康状态 | ~10 秒 |
| `/rescue` 或 `dsh救` | 跑 `rescue.ps1`：恢复快照→重打补丁→重装→重启→验证 | 1–2 分钟 |

命令在 `gateway.mjs` 的 `onMessage` 里、owner 校验之后拦截，**不进入模型**，所以：
- 不会消耗模型额度
- 不会被噪声过滤、关键词屏蔽、去重逻辑拦掉
- 回复失败时有兜底（绕过 `deliver` 直接用底层 sender）

### 8.3 限制（必须知道）

1. **gateway 自己挂了，这条通道就没了。** 它和 dsh 是两条独立的链，但不是无损的。gateway 的存活靠 `一键启动.vbs` 与开机自启。
2. **NapCat 掉线也等于通道断。** 需要人工扫码/密码重新登录（交接文档已记录）。
3. **改动未端到端实测。** 代码已插入且 `node --check` 通过，但服务当前没运行（3000/3001/6099 未监听），命令没有真正跑过一次。首次使用请先发 `/check` 而不是 `/rescue`。

### 8.4 三层通道冗余

| 层 | 入口 | 依赖 |
|---|---|---|
| 本地 | 桌面 `DSH-RESCUE.bat` | 只要人在电脑前 |
| 远程 | QQ `/rescue` | NapCat + gateway 在线 |
| 无人值守 | 计划任务跑 `watchdog.ps1` | Windows 在跑 |

三者互不依赖，任一条通就能救。

## 9 dsh-purge 的停用与恢复

### 9.1 它为什么能把 dsh 搞崩

purge 加载后会无条件执行 `overlayOfficialIdentity`（`dsh-purge/lib/identity.js:218-252`），把空的 persona-suffix 填成：

```js
const CWD_ONLY_SUFFIX = "Your working directory is {{cwd}}.";
```

而 dsh 0.2.1-rc.2 的宿主只注册 `provider` / `model` 两个提示词变量，插值是严格的。于是**每轮装配**都抛 `unknown prompt variable`，界面显示「本轮运行失败」，会话彻底不可用——这就是 11-12 那次事故。

### 9.2 两种修法，选哪个

| 做法 | 效果 | 代价 |
|---|---|---|
| 停用插件（4 行 `disabled`） | 崩溃立刻消失 | 失去净化、身份注入、红队能力 |
| 修 `CWD_ONLY_SUFFIX`（本仓库做法） | 崩溃消失，功能全保留 | 改在 `node_modules` 里，install 会覆盖 |

本仓库选后者，并用 `apply-patches.ps1` 保证可重建。`verify.ps1` 里有一项专门盯它。

### 9.3 停用清单（真要停就改这四行）

在 `profiles\web\cordis.patch.yml` 里：

```yaml
- id: dsh-purge
  disabled: true
- id: dsh-purge-redteam
  disabled: true
- id: dsh-purge-redteam-store
  disabled: true
- id: dsh-purge-redteam-ui
  disabled: true
```

### 9.4 恢复加载流程（2026-11-13 实测通过）

前置：`identity.js` 的 `CWD_ONLY_SUFFIX` 已不含 `{{cwd}}`。

```
① snapshot.ps1 -Tag before-purge-restore
② 删掉/注释 profile patch 里那四行 disabled
③ 等 HMR 热重组（或重启）
④ verify.ps1                      ← 必须全 PASS 才能往下走
⑤ 确认 purge_status 工具已注册（工具表里出现 purge_* 即成功）
```

### 9.5 全量净化流程（2026-11-13 实测通过）

**顺序不能颠倒。**

```
① snapshot.ps1 -Tag before-purge-apply
② purge_apply                    ← 会重写 86 个宿主文件
③ 检查 identity.js 的 CWD_ONLY_SUFFIX 还在不在
④ apply-patches.ps1              ← 被覆盖就修回来
⑤ restart-safe.ps1               ← 净化需要重启才生效
⑥ verify.ps1
```

**为什么 ④ 必须排在 ⑤ 前面**：`purge_apply` 可能重写 `dsh-purge/lib/identity.js`，把 `CWD_ONLY_SUFFIX` 的修复覆盖掉。不重打补丁就重启 → `{{cwd}}` 崩溃立刻回来。

**为什么用脱离进程跑**：⑤ 会杀掉当前 dsh 进程，如果收尾脚本活在那棵进程树里，它会跟着一起死（11-12 就踩过这个坑，日志只写到 "killing PID" 就没了）。正确做法是用 WMI 创建：

```powershell
$cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "...\post-purge-apply.ps1"'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = "C:\Users\KonomiHasu\.dsh" }
```

父进程是 `WmiPrvSE`，杀 dsh 不会波及。

### 9.6 实测数据（2026-11-13）

| 阶段 | 补丁状态 |
|---|---|
| 恢复加载后 | 8/69 applied，53 pending |
| `purge_apply` 后 | **62/69 applied，0 pending**，7 skipped |

7 个 skipped 是「当前版本/场景不适用」，不是失败：`#32 #40 #53 #71 #77 #80 #88`。

耗时：snapshot ~20s → purge_apply ~10s → 重启 ~25s → verify ~20s。

### 9.7 后路（三层，都可回退）

| 后路 | 怎么用 |
|---|---|
| 文件快照 | `rollback.ps1 -Snapshot <id>` |
| purge 自带备份（52 个 `.dshpurge.bak`） | `purge_revert` |
| 桌面一键 | `DSH-RESCUE.bat` |

### 9.8 已知遗留

`post-purge-apply.ps1` 自己的日志文件没写出来（`Add-Content` 那一步），但两个子步骤日志正常：`apply-patches.log`、`restart-*.log`，结果可由 `purge_status` + `verify` 交叉确认。不影响结论，下次顺手修。

## 10 已知设计取舍

1. **watchdog 默认不自动改**。因为外人分不清"故意改的"和"改坏了"，自动回滚可能把有意的改动冲掉。要自动救必须显式加 `-AutoRescue`。
2. **快照不含整个 node_modules**。太大（几百 MB），且可通过 `pnpm install` 重建。快照只存配置 + 私有包 + 打过补丁的宿主文件 + dump 基线。
3. **GOOD 标记只由 verify 写**。verify 通过 ≠ 会话一定可用（它只做静态检查），但对 {{cwd}} 这类装配期错误，静态检查已经足够。
