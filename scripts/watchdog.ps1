# watchdog.ps1 -- offline health check that does NOT use dsh or any session.
#
# Purpose: the failure mode in this project is "session cannot send a message",
# so every check here reads FILES and the PROCESS TABLE only. It works while
# dsh web is completely unusable.
#
# Default behaviour is DETECT-ONLY: it writes a verdict to the log and exits.
# It never silently rewrites config, because an intentional edit would look
# identical to a mistake from the outside.
#
# Usage:
#   .\watchdog.ps1                  # check, log, exit (0 healthy / 1 unhealthy)
#   .\watchdog.ps1 -AutoRescue      # on failure, run rescue.ps1 (destructive)
#   .\watchdog.ps1 -Verbose         # also print each check
#
# Task Scheduler example (every 5 minutes, no console window):
#   schtasks /create /tn "dsh-watchdog" /sc minute /mo 5 /f ^
#     /tr "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\KonomiHasu\dsh-private\scripts\watchdog.ps1"

param(
    [switch]$AutoRescue,
    [switch]$Verbose
)

$ErrorActionPreference = 'Continue'
$root = "C:\Users\KonomiHasu\dsh-private"
$pw = "$env:USERPROFILE\.dsh\profiles\web"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir "watchdog.log"

$issues = @()

function Note($msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding UTF8
    if ($Verbose) { Write-Output $line }
}

function Bad($msg) {
    $script:issues += $msg
    Note "FAIL: $msg"
}

function Good($msg) {
    Note "ok: $msg"
}

# ---- 1. profile patch must not carry an unregistered prompt variable ---------
$patch = Join-Path $pw "cordis.patch.yml"
if (Test-Path $patch) {
    $hits = Select-String -Path $patch -Pattern 'persona(Prefix|Suffix)' -ErrorAction SilentlyContinue |
        Where-Object { $_.Line -match '\{\{' }
    if ($hits) {
        foreach ($h in $hits) { Bad "profile patch has {{var}} in persona field: $($h.Line.Trim())" }
    }
    else { Good "profile patch persona fields contain no {{var}}" }
}
else { Bad "profile cordis.patch.yml missing" }

# ---- 2. purge identity constant must not carry {{var}} -----------------------
$idf = Join-Path $pw "node_modules\dsh-purge\lib\identity.js"
if (Test-Path $idf) {
    $line = Select-String -Path $idf -Pattern 'CWD_ONLY_SUFFIX =' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line -and $line.Line -match '\{\{') { Bad "purge CWD_ONLY_SUFFIX still contains {{var}}" }
    else { Good "purge CWD_ONLY_SUFFIX clean" }
}
else { Note "dsh-purge not installed (skipped)" }

# ---- 3. private package present and syntactically loadable -------------------
$pk = Join-Path $pw "node_modules\@yg\dsh-private-core"
$pkIdx = Join-Path $pk "lib\index.js"
if (Test-Path $pkIdx) {
    Good "private-core package present in profile"
    $node = "C:\Program Files\nodejs\node.exe"
    & $node --check $pkIdx 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Bad "private-core lib/index.js has a syntax error" }
    else { Good "private-core lib/index.js parses" }
}
else { Bad "private-core missing from profile node_modules" }

# ---- 4. bundles list ends with the private bundle ----------------------------
$pkgJson = Join-Path $pw "package.json"
if (Test-Path $pkgJson) {
    try {
        $j = Get-Content $pkgJson -Raw | ConvertFrom-Json
        $last = $j.dsh.profile.bundles[-1]
        if ($last -ne '@yg/dsh-private-core') { Bad "bundles last entry is '$last', expected '@yg/dsh-private-core'" }
        else { Good "bundles last entry correct" }
    }
    catch { Bad "package.json is not valid JSON: $($_.Exception.Message)" }
}
else { Bad "profile package.json missing" }

# ---- 5. web listener alive --------------------------------------------------
$listen = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $listen) { Bad "nothing listening on 3080 (dsh web down)" }
else {
    $proc = Get-Process -Id $listen.OwningProcess -ErrorAction SilentlyContinue
    if ($null -ne $proc -and $proc.ProcessName -eq 'node') { Good "3080 served by node pid=$($listen.OwningProcess)" }
    else { Bad "3080 owned by non-node process" }
}

# ---- verdict ----------------------------------------------------------------
if ($issues.Count -eq 0) {
    Note "VERDICT: healthy"
    exit 0
}

Note "VERDICT: unhealthy ($($issues.Count) issue(s))"
foreach ($i in $issues) { Note "  - $i" }

if ($AutoRescue) {
    Note "AutoRescue enabled -> running rescue.ps1"
    $rescue = Join-Path $root "scripts\rescue.ps1"
    if (Test-Path $rescue) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rescue 2>&1 | ForEach-Object { Note "  rescue: $_" }
        Note "rescue exit=$LASTEXITCODE"
    }
    else { Note "rescue.ps1 missing, cannot auto-rescue" }
}

exit 1
