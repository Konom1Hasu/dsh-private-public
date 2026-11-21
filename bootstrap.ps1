# bootstrap.ps1 -- 把 dsh-private 这套改造部署到一个 profile
#
# 设计原则：
#   1. 默认新建 profile（名字 private），绝不碰 web 等现有 profile
#   2. -DryRun 只打印计划，不动任何文件
#   3. 已存在的 profile 必须显式 -Force
#   4. 每一步都可以单独复跑，不具备破坏性
#
# 用法：
#   powershell -File bootstrap.ps1 -DryRun              # 先看计划
#   powershell -File bootstrap.ps1                      # 部署到 profile "private"
#   powershell -File bootstrap.ps1 -ProfileName test    # 换名字
#   powershell -File bootstrap.ps1 -WithPurge           # 同时装 dsh-purge
#
# 结束后跑：
#   dsh --profile private
#
# 退出码：0 成功 / 1 前置缺失 / 2 profile 已存在 / 3 安装失败 / 4 验证失败

param(
    [string]$ProfileName = "private",
    [switch]$DryRun,
    [switch]$Force,
    [switch]$WithPurge,
    [switch]$NoVerify,
    # 该 profile 的默认模型（provider 名来自全局层的 llm-pi-ai / llm-deepseek）
    [string]$Provider = "",
    [string]$Model = "",
    # 把 packaging\global 的 provider 定义装到 $DSH_HOME\cordis.patch.yml（全局层）
    [switch]$InstallGlobal
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot                          # 本脚本就在 dsh-private 根目录
$pkgDir = Join-Path $root "packages\dsh-private-core"
$tplDir = Join-Path $root "packaging\profile-template"
$localTpl = Join-Path $root "packaging\local\cordis.patch.yml.example"
$dshHome = Join-Path $env:USERPROFILE ".dsh"
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir ("bootstrap-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
$utf8 = New-Object System.Text.UTF8Encoding($false)

function L($m) {
    $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    try { [System.IO.File]::AppendAllText($log, $line + "`r`n", $utf8) } catch { }
    Write-Output $line
}

L "=== bootstrap begin (profile=$ProfileName dryrun=$DryRun) ==="

# ---- 1. 前置检查 -----------------------------------------------------------
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { L "FAIL: 找不到 node"; exit 1 }

$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) { L "FAIL: 找不到 pnpm"; exit 1 }

if (-not (Test-Path $pkgDir)) { L "FAIL: 私有包目录缺失 $pkgDir"; exit 1 }
if (-not (Test-Path $tplDir)) { L "FAIL: 模板目录缺失 $tplDir"; exit 1 }

$dshBin = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path $dshBin)) { L "FAIL: 找不到 dsh 安装 $dshBin"; exit 1 }

L "ok: 前置齐全 (node/pnpm/pkg/template/dsh)"

# ---- 2. profile 冲突检查 ----------------------------------------------------
if ((Test-Path $profileDir) -and -not $Force) {
    L "ABORT: profile 已存在 $profileDir （要覆盖请加 -Force）"
    exit 2
}
L "ok: 目标 profile 可用 $profileDir"

$ProvHint = ""
if ($Provider -or $Model) { $ProvHint = "，默认模型 $Provider/$Model" }

if ($DryRun) {
    L "--- 计划 ---"
    L "创建目录      $profileDir"
    L "写 package.json（bundles: base + web-app + private-core）"
    L "写 pnpm-workspace.yaml（nodeLinker: hoisted）"
    L "写 cordis.patch.yml（来自 profile-template${ProvHint}）"
    L "pnpm add file:$pkgDir"
    if ($WithPurge) { L "pnpm add dsh-purge" }
    if ($InstallGlobal) { L "安装全局 provider 层 -> $dshHome\cordis.patch.yml（会覆盖所有 profile 的同名配置）" }
    else { L "不动 home patch（需要全局 provider 才加 -InstallGlobal）" }
    if (-not $NoVerify) { L "验证：--dump-config 检查 private-core" }
    L "=== bootstrap end (dry run) ==="
    exit 0
}

# ---- 3. 建目录与清单 --------------------------------------------------------
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

$pkgPath = Join-Path $pkgDir -ChildPath ""        # file: 用正斜杠
$fileSpec = "file:" + ($pkgDir -replace '\\', '/')

$bundles = @(
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app"
)
if ($WithPurge) { $bundles += "dsh-purge" }
$bundles += "@yg/dsh-private-core"

$pkgJson = [ordered]@{
    name    = "dsh-profile-$ProfileName"
    private = $true
    dependencies = [ordered]@{
        "@yg/dsh-private-core" = $fileSpec
    }
    dsh     = [ordered]@{
        profile = [ordered]@{
            bundles = $bundles
        }
    }
}
# package.json 必须**无 BOM**：dsh 用 JSON.parse 读它，BOM 会直接 SyntaxError。
# （.ps1 脚本相反，必须有 BOM 否则 PowerShell 5.1 按 ANSI 解析中文。两者要求相反。）
$jsonText = $pkgJson | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $profileDir "package.json"), $jsonText, (New-Object System.Text.UTF8Encoding($false)))
L "ok: package.json 写入（无 BOM）"

$wsYaml = @"
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
"@
[System.IO.File]::WriteAllText((Join-Path $profileDir "pnpm-workspace.yaml"), $wsYaml, $utf8)
L "ok: pnpm-workspace.yaml 写入"

Copy-Item (Join-Path $tplDir "cordis.patch.yml") (Join-Path $profileDir "cordis.patch.yml") -Force

# 按 -Provider / -Model 改写 agent-default-model 段（只动这一段，不碰其他地方）
if ($Provider -or $Model) {
    $patchDst = Join-Path $profileDir "cordis.patch.yml"
    $pt = [System.IO.File]::ReadAllText($patchDst)
    if ($Provider) { $pt = [regex]::Replace($pt, '(?s)(- id: agent-default-model.*?provider:\s*)\S+', ('${1}' + $Provider), 1) }
    if ($Model) { $pt = [regex]::Replace($pt, '(?s)(- id: agent-default-model.*?model:\s*)\S+', ('${1}' + $Model), 1) }
    [System.IO.File]::WriteAllText($patchDst, $pt, $utf8)
    L "ok: 默认模型设为 provider=$Provider model=$Model"
}
L "ok: cordis.patch.yml 写入"

# ---- 4. 装依赖 --------------------------------------------------------------
L "step: pnpm install in $profileDir"
Push-Location $profileDir
& pnpm install --reporter=append-only 2>&1 | ForEach-Object { L "  $_" }
$installExit = $LASTEXITCODE
Pop-Location
L "pnpm install exit=$installExit"
if ($installExit -ne 0) { L "FAIL: 依赖安装失败"; exit 3 }

if ($WithPurge) {
    Push-Location $profileDir
    & pnpm add dsh-purge --reporter=append-only 2>&1 | ForEach-Object { L "  $_" }
    L "pnpm add dsh-purge exit=$LASTEXITCODE"
    Pop-Location
}

# 装完确认私有包真的落在 profiles 树内（不能是 symlink）
$installed = Join-Path $profileDir "node_modules\@yg\dsh-private-core\lib\index.js"
if (Test-Path $installed) { L "ok: 私有包已落地 $installed" }
else { L "WARN: 私有包未落地，检查 pnpm 输出" }

# ---- 5. 全局 provider 层 ----------------------------------------------------
# $DSH_HOME/cordis.patch.yml 是**全局层**，排在每个 profile 的 patch 之后，
# 对所有 profile 生效。2026-11-13 曾经自动生成它，把正在用的 web profile 的
# agent-default-model 一起改掉——所以这里必须显式 -InstallGlobal 才动它，
# 而且动之前一定备份。
$homePatch = Join-Path $dshHome "cordis.patch.yml"
$globalTpl = Join-Path $root "packaging\global\cordis.patch.yml"

if ($InstallGlobal) {
    if (-not (Test-Path $globalTpl)) { L "FAIL: 缺全局模板 $globalTpl"; exit 3 }
    if (Test-Path $homePatch) {
        $bak = $homePatch + ".bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item $homePatch $bak -Force
        L "ok: 已备份现有 home patch -> $bak"
    }
    Copy-Item $globalTpl $homePatch -Force
    L "ok: 全局 provider 层已安装 -> $homePatch"
    L "注意: 这层会覆盖所有 profile 的同 id 配置。装完必须验证："
    L "      dsh --profile web --dump-config 对比 llm-pi-ai 的 provider 列表"
}
elseif (Test-Path $homePatch) {
    L "注意: 已存在 home patch $homePatch （未改动，它会作用于所有 profile）"
}
else {
    L "提示: provider 定义放哪里，两种选择："
    L "      a) 只影响本 profile -> 并进 $profileDir\cordis.patch.yml"
    L "      b) 所有 profile 共用 -> 加 -InstallGlobal，装 packaging\global\cordis.patch.yml"
    L "         注意 (b) 会覆盖 web 等同名配置，装完要验证"
}

# ---- 6. 验证 ----------------------------------------------------------------
if (-not $NoVerify) {
    L "step: verify via dump-config"
    $dump = Join-Path $env:TEMP ("bootstrap-dump-" + $ProfileName + ".yml")
    & $node $dshBin --profile $ProfileName --dump-config > $dump 2>&1
    $dumpExit = $LASTEXITCODE
    L "dump-config exit=$dumpExit"
    if ($dumpExit -ne 0) {
        L "FAIL: dump-config 失败，看 $dump"
        exit 4
    }
    $hit = Select-String -Path $dump -SimpleMatch -Pattern 'private-core' -ErrorAction SilentlyContinue
    if ($hit) { L "ok: private-core 出现在配置树中" }
    else { L "FAIL: private-core 未出现"; exit 4 }
    $bad = Select-String -Path $dump -SimpleMatch -Pattern 'unknown prompt variable' -ErrorAction SilentlyContinue
    if ($bad) { L "FAIL: 存在 unknown prompt variable"; exit 4 }
    else { L "ok: 无未知提示词变量" }
}

L "=== bootstrap end: 成功 ==="
L "启动：node `"$dshBin`" --profile $ProfileName"
exit 0
