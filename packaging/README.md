# dsh-private 打包说明

把散落的改造收敛成「一条命令可复现」的一套。

## 目录

```
dsh-private/
  bootstrap.ps1                 一键部署到新 profile
  packaging/
    profile-template/
      cordis.patch.yml          通用层（可分发）
    local/
      cordis.patch.yml.example  私有层样例（provider/密钥，不可分发）
  packages/dsh-private-core/    私有插件（工具 + prompt 段）
  scripts/                      灾备脚本（snapshot/verify/rescue/...）
  docs/                         技术文档与手册
```

## 快速开始

```powershell
# 1. 先看计划，不动任何文件
powershell -File bootstrap.ps1 -DryRun

# 2. 部署到新 profile（默认名 private，绝不碰 web）
powershell -File bootstrap.ps1

# 3. 启动
dsh --profile private
```

可选参数：

| 参数 | 作用 |
|---|---|
| `-ProfileName test` | 换 profile 名 |
| `-WithPurge` | 同时安装 dsh-purge |
| `-Force` | 允许覆盖已存在的 profile |
| `-NoVerify` | 跳过 dump-config 验证 |

## 两层配置必须分开

这是整个打包设计的核心。

| 层 | 文件 | 能否分发 | 放什么 |
|---|---|---|---|
| 通用层 | `profile-template/cordis.patch.yml` → `<profile>/cordis.patch.yml` | ✅ | 身份安全值、压缩阈值、心跳、会话检索 |
| 私有层 | `local/cordis.patch.yml.example` → 手动放置 | ❌ | provider、baseURL、apiKeyEnv、私有模型名 |

**为什么不能混**：私有层里有你的网关地址和密钥变量名，混进模板就等于分发时把入口暴露了。

放在哪里有两个选择：

- **只想影响单个 profile** → 并进 `<profile>/cordis.patch.yml`
- **想让所有 profile 共用** → 复制到 `$DSH_HOME/cordis.patch.yml`

⚠️ **后者是全局层，排在每个 profile 的 patch 之后，会覆盖你在用的 web profile。**

## 两个编码陷阱（都真实踩过）

### 1. `.ps1` 必须有 UTF-8 BOM

PowerShell 5.1 读无 BOM 的 UTF-8 脚本时会按 ANSI(GBK) 解码，中文注释的某个字节序列被解成 `}`，语法直接崩。

```
At script.ps1:17 char:1
+ } catch {
Unexpected token '}' in expression or statement.
```

文件内容完全正确，报错行号也对不上——这就是 BOM 缺失的典型症状。

### 2. `package.json` 必须无 BOM

dsh 用 `JSON.parse` 读 profile manifest，BOM 会让它直接失败：

```
SyntaxError: Unexpected token '﻿', "﻿{" is not valid JSON
    at readProfileManifest (dsh-app-boot/lib/index.js:913)
```

**两者要求相反**，bootstrap 里已经处理：

```powershell
# .ps1 → 带 BOM
[System.IO.File]::WriteAllText($ps1, $c, (New-Object System.Text.UTF8Encoding($true)))
# package.json → 无 BOM
[System.IO.File]::WriteAllText($json, $text, (New-Object System.Text.UTF8Encoding($false)))
```

新增或手改脚本后自检：

```powershell
Get-ChildItem C:\Users\KonomiHasu\dsh-private\scripts -Filter *.ps1 | ForEach-Object {
  $b = [System.IO.File]::ReadAllBytes($_.FullName)
  $bom = ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  $e = $null
  [System.Management.Automation.PSParser]::Tokenize([System.IO.File]::ReadAllText($_.FullName), [ref]$e) | Out-Null
  "{0,-26} BOM={1,-6} {2}" -f $_.Name, $bom, $(if($e.Count -gt 0){"ERR($($e.Count))"}else{"OK"})
}
```

## 部署后验证

```powershell
# bootstrap 自己会做，也可以手动跑
$dshBin = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $dshBin --profile private --dump-config | Select-String 'private-core'
```

看到 `private-core` 且没有 `unknown prompt variable`，才算装上。

## 与灾备体系的关系

bootstrap 只负责**新建**。改坏了的恢复靠 `scripts/`：

```powershell
powershell -File scripts\snapshot.ps1 -Tag before-change
powershell -File scripts\verify.ps1
powershell -File scripts\rescue.ps1
```

完整说明见 [../docs/DISASTER-RECOVERY.md](../docs/DISASTER-RECOVERY.md)。
