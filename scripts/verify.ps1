# verify.ps1 -- assert the profile is in a known-good state.
# Prints one line per check, exits 1 if any FAIL.
#
# Every check here corresponds to a failure that actually happened in this project,
# so a green run means those specific failures are absent -- not that everything is fine.

$ErrorActionPreference = 'Continue'
$node = "C:\Program Files\nodejs\node.exe"
$bin = "C:\Users\KonomiHasu\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
$pw = "$env:USERPROFILE\.dsh\profiles\web"
$dump = Join-Path $env:TEMP ("dsh-verify-" + (Get-Date -Format 'HHmmss') + ".yml")

$fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { "{0,-42} PASS  {1}" -f $name, $detail }
    else { "{0,-42} FAIL  {1}" -f $name, $detail; $script:fail++ }
}

& $node $bin --profile web --dump-config > $dump 2>&1
$dumpExit = $LASTEXITCODE
$dumpText = Get-Content $dump -Raw -ErrorAction SilentlyContinue

Check "dump-config exits 0" ($dumpExit -eq 0) "exit=$dumpExit"

$hasPrivate = $dumpText -match 'private-core'
Check "private-core bundle loaded" $hasPrivate "searched dump-config"

$hasBadVar = $dumpText -match 'unknown prompt variable'
Check "no 'unknown prompt variable'" (-not $hasBadVar) "scanned dump stderr"

$spLine = Select-String -Path $dump -Pattern '^- id: system-prompt' -ErrorAction SilentlyContinue | Select-Object -First 1
$suffixBad = $false
$suffixVal = '(not found)'
if ($spLine) {
    $block = Get-Content $dump | Select-Object -Skip ($spLine.LineNumber) -First 5
    $sfx = $block | Where-Object { $_ -match 'personaSuffix' } | Select-Object -First 1
    if ($sfx) { $suffixVal = $sfx.Trim(); if ($sfx -match '\{\{') { $suffixBad = $true } }
}
Check "system-prompt personaSuffix has no {{var}}" (-not $suffixBad) $suffixVal

$idf = Join-Path $pw "node_modules\dsh-purge\lib\identity.js"
$idfBad = $true
$idfDetail = 'file missing'
if (Test-Path $idf) {
    $line = Select-String -Path $idf -Pattern 'CWD_ONLY_SUFFIX =' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) {
        $idfBad = ($line.Line -match '\{\{')
        $idfDetail = $line.Line.Trim()
    }
}
Check "purge CWD_ONLY_SUFFIX has no {{var}}" (-not $idfBad) $idfDetail

$listen = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$listenDetail = 'none'
if ($null -ne $listen) { $listenDetail = "pid=$($listen.OwningProcess)" }
Check "port 3080 listening" ($null -ne $listen) $listenDetail

$pkg = Get-Content (Join-Path $pw "package.json") -Raw | ConvertFrom-Json
$lastBundle = $pkg.dsh.profile.bundles[-1]
Check "private-core is last bundle" ($lastBundle -eq '@yg/dsh-private-core') "last=$lastBundle"

$pkgCopy = Join-Path $pw "node_modules\@yg\dsh-private-core\lib\index.js"
Check "package physically copied into profile" (Test-Path $pkgCopy) $pkgCopy

""
if ($fail -eq 0) {
    # Mark the snapshot that rescue.ps1 should fall back to.
    $bkRoot = "C:\Users\KonomiHasu\dsh-private\backups"
    $latestFile = Join-Path $bkRoot "LATEST.txt"
    if (Test-Path $latestFile) {
        $latest = (Get-Content $latestFile -Raw).Trim()
        Set-Content (Join-Path $bkRoot "GOOD.txt") -Value $latest -Encoding UTF8
        "GOOD marker set to snapshot: $latest"
    }
    "ALL CHECKS PASSED"
    exit 0
}
"$fail CHECK(S) FAILED"
exit 1
