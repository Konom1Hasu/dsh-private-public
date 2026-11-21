# rollback.ps1 -- restore the profile to a snapshot taken by snapshot.ps1.
#
# Usage:
#   .\rollback.ps1                 # use backups\LATEST.txt
#   .\rollback.ps1 -Snapshot 20261112-095038
#   .\rollback.ps1 -WhatIf         # show what would be restored, touch nothing
#
# What it restores:
#   profile-package.json    -> profiles\web\package.json
#   profile-cordis.patch.yml-> profiles\web\cordis.patch.yml
#   profile-pnpm-lock.yaml  -> profiles\web\pnpm-lock.yaml
#   purge-identity.js       -> profiles\web\node_modules\dsh-purge\lib\identity.js
#
# What it does NOT do: pnpm install (dependency tree may differ), restart dsh.
# Both are printed as required follow-up steps.

param(
    [string]$Snapshot = "",
    [switch]$WhatIf,
    [switch]$AlsoRestoreSource
)

$ErrorActionPreference = 'Continue'
$root = "C:\Users\KonomiHasu\dsh-private\backups"
$pw = "$env:USERPROFILE\.dsh\profiles\web"

if ([string]::IsNullOrWhiteSpace($Snapshot)) {
    $latestFile = Join-Path $root "LATEST.txt"
    if (-not (Test-Path $latestFile)) { "ABORT: no LATEST.txt and no -Snapshot given"; exit 2 }
    $Snapshot = (Get-Content $latestFile -Raw).Trim()
}

$snap = Join-Path $root "$Snapshot\snapshot"
if (-not (Test-Path $snap)) { "ABORT: snapshot dir missing: $snap"; exit 2 }

$logDir = "C:\Users\KonomiHasu\dsh-private\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir ("rollback-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
function L($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 }

$modeTxt = 'APPLY'
if ($WhatIf) { $modeTxt = 'WHATIF (no writes)' }
"snapshot: $Snapshot"
"mode: $modeTxt"
""

$map = @(
    @{ Src = "profile-package.json";     Dst = (Join-Path $pw "package.json");                              Name = "profile package.json" },
    @{ Src = "profile-cordis.patch.yml"; Dst = (Join-Path $pw "cordis.patch.yml");                          Name = "profile cordis.patch.yml" },
    @{ Src = "profile-pnpm-lock.yaml";   Dst = (Join-Path $pw "pnpm-lock.yaml");                            Name = "profile pnpm-lock.yaml" },
    @{ Src = "purge-identity.js";        Dst = (Join-Path $pw "node_modules\dsh-purge\lib\identity.js");    Name = "purge identity.js" }
)

$restored = 0
foreach ($m in $map) {
    $src = Join-Path $snap $m.Src
    if (-not (Test-Path $src)) { "SKIP  {0}: not in snapshot" -f $m.Name; continue }
    $srcHash = (Get-FileHash $src -Algorithm SHA256).Hash
    $dstHash = ""
    if (Test-Path $m.Dst) { $dstHash = (Get-FileHash $m.Dst -Algorithm SHA256).Hash }

    if ($srcHash -eq $dstHash) {
        "SAME  {0} (already identical)" -f $m.Name
        continue
    }

    if ($WhatIf) {
        "WOULD {0}: {1} -> {2}" -f $m.Name, $dstHash.Substring(0, 8), $srcHash.Substring(0, 8)
        continue
    }

    $bak = "$($m.Dst).pre-rollback-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    if (Test-Path $m.Dst) { Copy-Item $m.Dst $bak -Force }
    Copy-Item $src $m.Dst -Force
    $newHash = (Get-FileHash $m.Dst -Algorithm SHA256).Hash
    $verified = ($newHash -eq $srcHash)
    "DONE  {0}: restored, hash_match={1}, backup={2}" -f $m.Name, $verified, (Split-Path $bak -Leaf)
    L ("rollback {0} hash_match={1}" -f $m.Name, $verified)
    if (-not $verified) { "ERROR: hash mismatch after copy for {0}" -f $m.Name; exit 3 }
    $restored++
}

if ($AlsoRestoreSource -and -not $WhatIf) {
    $srcPkg = Join-Path $snap "packages"
    if (Test-Path $srcPkg) {
        Copy-Item (Join-Path $srcPkg "*") "C:\Users\KonomiHasu\dsh-private\packages" -Recurse -Force
        "DONE  private package source restored"
        L "restored package source"
    }
}

""
"restored files: $restored"
if (-not $WhatIf) {
    ""
    "REQUIRED FOLLOW-UP:"
    "  1) cd $pw ; pnpm install          # lock may differ from installed tree"
    "  2) powershell -File C:\Users\KonomiHasu\dsh-private\scripts\restart-safe.ps1"
    "  3) powershell -File C:\Users\KonomiHasu\dsh-private\scripts\verify.ps1"
}
L "rollback done restored=$restored"
exit 0
