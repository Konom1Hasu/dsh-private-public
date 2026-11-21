# post-purge-apply.ps1 -- 净化之后的收尾序列（脱离 dsh 进程树执行）
#
# 顺序是有原因的：
#   1. apply-patches 必须在重启前跑。purge_apply 会重写宿主 lib/*.js，
#      很可能把我对 dsh-purge/lib/identity.js 的 CWD_ONLY_SUFFIX 修复覆盖掉。
#      不重打就重启 → {{cwd}} 崩溃立刻回来。
#   2. 重启让 86 个 patch 生效。
#   3. verify 判定结果，写 GOOD 标记。
#
# 由 WMI 创建（父进程 WmiPrvSE），所以重启 dsh 不会杀死本脚本。

param([switch]$LogOnly)

$ErrorActionPreference = 'Continue'
$root = "C:\Users\KonomiHasu\dsh-private"
$logDir = Join-Path $root "logs"
$log = Join-Path $logDir ("post-purge-apply-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 2026-11-13 事故：Add-Content 在 WMI 创建的无控制台会话里整体静默失败，
# 这份日志完全没落地，当时只能靠子步骤日志反推流程是否走完。
# 改成 .NET 直接写 + 初始化自检 + 每条失败都打到 stderr，不再静默。
try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    [System.IO.File]::AppendAllText($log, "[init] " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " log opened`r`n", $utf8)
} catch {
    [Console]::Error.WriteLine("FATAL: cannot create log at $log : $($_.Exception.Message)")
}
if (-not (Test-Path $log)) { [Console]::Error.WriteLine("FATAL: log file missing after init: $log") }

function L($m) {
    $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    try { [System.IO.File]::AppendAllText($log, $line + "`r`n", $utf8) }
    catch { [Console]::Error.WriteLine("LOGFAIL: $line -- $($_.Exception.Message)") }
}

L "=== post purge_apply sequence begin ==="
L "log: $log"

if ($LogOnly) {
    L "log self-test ok"
    Write-Output "log self-test ok -> $log"
    exit 0
}

# --- 1. 重打 node_modules 补丁 ---
L "step 1/3 apply-patches"
$ap = Join-Path $root "scripts\apply-patches.ps1"
if (Test-Path $ap) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ap 2>&1 | ForEach-Object { L "  $_" }
    L "  apply-patches exit=$LASTEXITCODE"
} else { L "  MISSING apply-patches.ps1" }

# --- 2. 重启 dsh web ---
L "step 2/3 restart"
$rs = Join-Path $root "scripts\restart-safe.ps1"
if (Test-Path $rs) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rs 2>&1 | ForEach-Object { L "  $_" }
    L "  restart exit=$LASTEXITCODE"
} else { L "  MISSING restart-safe.ps1" }

# --- 3. 验证 ---
L "step 3/3 verify"
$vf = Join-Path $root "scripts\verify.ps1"
if (Test-Path $vf) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vf 2>&1 | ForEach-Object { L "  $_" }
    L "  verify exit=$LASTEXITCODE"
} else { L "  MISSING verify.ps1" }

L "=== end. log: $log ==="

# 留一个显眼的结果文件给会话读
$summary = Join-Path $root "logs\post-purge-apply.LATEST.txt"
Copy-Item $log $summary -Force
