# apply-patches.ps1 -- re-apply host/plugin patches that live in node_modules.
#
# WHY THIS EXISTS
# The fix for the `unknown prompt variable "{{cwd}}"` crash is a one-line edit to
# dsh-purge/lib/identity.js. That file lives in node_modules, so `pnpm install`,
# `pnpm add`, or a dsh upgrade silently overwrites it and the crash comes back.
# This script re-applies the edit idempotently, so the safety net survives
# dependency churn.
#
# Safe to run any time, as many times as you like. It only reports when nothing
# needs changing.
#
# Exit codes: 0 ok (patched or already correct), 1 could not patch

param(
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$pw = "$env:USERPROFILE\.dsh\profiles\web"
$logDir = "C:\Users\KonomiHasu\dsh-private\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir "apply-patches.log"

function Say($m) {
    Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
    if (-not $Quiet) { Write-Output $m }
}

$changed = 0
$failed = 0

# ---- patch 1: dsh-purge CWD_ONLY_SUFFIX must not reference {{cwd}} -----------
$idf = Join-Path $pw "node_modules\dsh-purge\lib\identity.js"
if (Test-Path $idf) {
    $text = [System.IO.File]::ReadAllText($idf)
    $badLinePattern = 'const CWD_ONLY_SUFFIX = .*\{\{'
    $line = Select-String -Path $idf -Pattern 'CWD_ONLY_SUFFIX =' -ErrorAction SilentlyContinue | Select-Object -First 1

    if (-not $line) {
        Say "FAIL dsh-purge: CWD_ONLY_SUFFIX not found (upstream changed?), patch not applied"
        $failed++
    }
    elseif ($line.Line -match '\{\{') {
        $old = $line.Line.Trim()
        $safe = 'const CWD_ONLY_SUFFIX = "Your working directory is provided by the session runtime context."; // [lcs] unregistered prompt variable removed'
        $newText = $text.Replace($old, $safe)

        if ($newText -eq $text) {
            Say "FAIL dsh-purge: replacement did not take effect"
            $failed++
        }
        else {
            Copy-Item $idf "$idf.lcspatch.bak" -Force
            $enc = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($idf, $newText, $enc)

            $node = "C:\Program Files\nodejs\node.exe"
            & $node --check $idf 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Copy-Item "$idf.lcspatch.bak" $idf -Force
                Say "FAIL dsh-purge: patched file failed syntax check, rolled back"
                $failed++
            }
            else {
                Say "PATCHED dsh-purge identity.js (backup: identity.js.lcspatch.bak)"
                $changed++
            }
        }
    }
    else {
        Say "ok dsh-purge identity.js already safe"
    }
}
else {
    Say "skip dsh-purge: not installed"
}

# ---- patch 2: profile patch persona fields must not carry {{var}} -----------
$patchFile = Join-Path $pw "cordis.patch.yml"
if (Test-Path $patchFile) {
    $hits = Select-String -Path $patchFile -Pattern 'persona(Prefix|Suffix)' -ErrorAction SilentlyContinue |
        Where-Object { $_.Line -match '\{\{' }
    if ($hits) {
        Say "WARN profile cordis.patch.yml has {{var}} in persona fields -- NOT auto-fixed, review manually:"
        foreach ($h in $hits) { Say "     line $($h.LineNumber): $($h.Line.Trim())" }
        $failed++
    }
    else {
        Say "ok profile cordis.patch.yml persona fields clean"
    }
}

# ---- patch 3: private package still physically present ----------------------
$pkIdx = Join-Path $pw "node_modules\@yg\dsh-private-core\lib\index.js"
if (-not (Test-Path $pkIdx)) {
    Say "WARN @yg/dsh-private-core missing from profile node_modules -- run: cd profiles\web ; pnpm install"
    $failed++
}
else {
    Say "ok @yg/dsh-private-core present"
}

Say "SUMMARY changed=$changed failed=$failed"
if ($failed -gt 0) { exit 1 }
exit 0
