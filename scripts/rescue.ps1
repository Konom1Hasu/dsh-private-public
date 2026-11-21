# rescue.ps1 -- the channel that works when the session does not.
#
# Designed for the exact failure this project hit: the GUI session cannot send a
# message because prompt assembly throws before any request goes out. Anything
# that requires the session to work is useless there, so rescue touches only:
#   files on disk, the process table, and the port.
#
# Run it from ANY terminal, a desktop shortcut, Task Scheduler, or a remote shell.
# No dsh, no agent, no session required.
#
# Usage:
#   .\rescue.ps1                      # restore last GOOD snapshot, restart, verify
#   .\rescue.ps1 -Snapshot 2026...    # restore a specific snapshot
#   .\rescue.ps1 -DryRun              # show the plan, change nothing
#   .\rescue.ps1 -NoRestart           # restore files only
#
# Exit codes: 0 rescued and verified, 4 verify failed after rescue, 5 no snapshot

param(
    [string]$Snapshot = "",
    [switch]$DryRun,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
$root = "C:\Users\KonomiHasu\dsh-private"
$bkRoot = Join-Path $root "backups"
$scripts = Join-Path $root "scripts"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir ("rescue-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")

function L($m) {
    $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Output $line
}

L "=== rescue begin ==="
L "dryrun=$DryRun norestart=$NoRestart"

# ---- pick the snapshot -------------------------------------------------------
$chosen = $Snapshot
if ([string]::IsNullOrWhiteSpace($chosen)) {
    $goodFile = Join-Path $bkRoot "GOOD.txt"
    if (Test-Path $goodFile) {
        $chosen = (Get-Content $goodFile -Raw).Trim()
        L "snapshot source: GOOD.txt -> $chosen"
    }
    else {
        $latestFile = Join-Path $bkRoot "LATEST.txt"
        if (Test-Path $latestFile) {
            $chosen = (Get-Content $latestFile -Raw).Trim()
            L "snapshot source: LATEST.txt (no GOOD marker) -> $chosen"
        }
    }
}
if ([string]::IsNullOrWhiteSpace($chosen)) {
    L "FAIL: no snapshot available, nothing to restore"
    exit 5
}

$snapDir = Join-Path $bkRoot "$chosen\snapshot"
if (-not (Test-Path $snapDir)) {
    L "FAIL: snapshot dir missing: $snapDir"
    exit 5
}
L "using snapshot: $chosen"

if ($DryRun) {
    $restartPlan = 'yes, via restart-safe.ps1'
    if ($NoRestart) { $restartPlan = 'skipped' }
    L "--- plan ---"
    L "restore: profile package.json / cordis.patch.yml / pnpm-lock.yaml / purge identity.js"
    L "restart: $restartPlan"
    L "verify:  yes"
    L "=== rescue end (dry run) ==="
    exit 0
}

# ---- restore files -----------------------------------------------------------
$rb = Join-Path $scripts "rollback.ps1"
if (-not (Test-Path $rb)) { L "FAIL: rollback.ps1 missing"; exit 5 }
L "step 1/5 restore files"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rb -Snapshot $chosen 2>&1 | ForEach-Object { L "  $_" }

# ---- re-apply patches that live in node_modules ------------------------------
# Identity patch lives in dsh-purge/lib/identity.js, which pnpm install overwrites.
# Re-apply it BEFORE restart so the restored state is actually the safe one.
L "step 2/5 re-apply node_modules patches"
$ap = Join-Path $scripts "apply-patches.ps1"
if (Test-Path $ap) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ap 2>&1 | ForEach-Object { L "  $_" }
    L "  apply-patches exit=$LASTEXITCODE"
}
else { L "  WARN apply-patches.ps1 missing" }

# ---- reinstall deps if lock changed -----------------------------------------
L "step 3/5 pnpm install (lock may differ from installed tree)"
$pw = "$env:USERPROFILE\.dsh\profiles\web"
Push-Location $pw
& pnpm install --reporter=append-only 2>&1 | Select-Object -Last 4 | ForEach-Object { L "  $_" }
Pop-Location

# ---- restart ----------------------------------------------------------------
if ($NoRestart) {
    L "step 4/5 restart skipped (-NoRestart)"
}
else {
    L "step 4/5 restart"
    $rs = Join-Path $scripts "restart-safe.ps1"
    if (-not (Test-Path $rs)) { L "FAIL: restart-safe.ps1 missing"; exit 5 }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rs 2>&1 | ForEach-Object { L "  $_" }
    $restartCode = $LASTEXITCODE
    L "restart exit=$restartCode"
    if ($restartCode -ne 0) { L "WARNING: restart reported failure, continuing to verify anyway" }
}

# ---- verify -----------------------------------------------------------------
L "step 5/5 verify"
$vf = Join-Path $scripts "verify.ps1"
if (-not (Test-Path $vf)) { L "FAIL: verify.ps1 missing"; exit 5 }
$verifyOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vf 2>&1
$verifyCode = $LASTEXITCODE
$verifyOut | ForEach-Object { L "  $_" }

L "=== rescue end: verify exit=$verifyCode ==="
L "log: $log"
if ($verifyCode -eq 0) { exit 0 }
exit 4
