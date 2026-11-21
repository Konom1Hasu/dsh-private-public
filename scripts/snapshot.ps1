# snapshot.ps1 -- capture the current profile state before any change.
#
# Always run this BEFORE touching config, node_modules or the private package.
# Writes backups\<timestamp>\snapshot.zip + manifest.txt (size + SHA256 per file)
# and updates backups\LATEST.txt.
#
# Exit codes: 0 ok, 1 dump-config failed

param(
    [string]$Tag = ""
)

$ErrorActionPreference = 'Continue'
$node = "C:\Program Files\nodejs\node.exe"
$bin = "C:\Users\KonomiHasu\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
$pw = "$env:USERPROFILE\.dsh\profiles\web"
$root = "C:\Users\KonomiHasu\dsh-private\backups"

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$label = $ts
if (-not [string]::IsNullOrWhiteSpace($Tag)) { $label = "$ts-$Tag" }

$bk = Join-Path $root $label
$snap = Join-Path $bk "snapshot"
New-Item -ItemType Directory -Path $snap -Force | Out-Null

$copied = 0
function Grab($src, $dstName) {
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $snap $dstName) -Force -ErrorAction SilentlyContinue
        $script:copied++
    }
    else {
        Write-Output ("missing (skipped): $src")
    }
}

Grab (Join-Path $pw "package.json") "profile-package.json"
Grab (Join-Path $pw "cordis.patch.yml") "profile-cordis.patch.yml"
Grab (Join-Path $pw "pnpm-lock.yaml") "profile-pnpm-lock.yaml"
Grab (Join-Path $pw "node_modules\dsh-purge\lib\identity.js") "purge-identity.js"

if (Test-Path "C:\Users\KonomiHasu\dsh-private\packages") {
    Copy-Item "C:\Users\KonomiHasu\dsh-private\packages" (Join-Path $snap "packages") -Recurse -Force -ErrorAction SilentlyContinue
    $copied++
}
if (Test-Path "C:\Users\KonomiHasu\dsh-private\harness") {
    Copy-Item "C:\Users\KonomiHasu\dsh-private\harness" (Join-Path $snap "harness") -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path "C:\Users\KonomiHasu\dsh-private\docs") {
    Copy-Item "C:\Users\KonomiHasu\dsh-private\docs" (Join-Path $snap "docs") -Recurse -Force -ErrorAction SilentlyContinue
}

$dumpPath = Join-Path $snap "dump-config.yml"
& $node $bin --profile web --dump-config > $dumpPath 2>&1
$dumpExit = $LASTEXITCODE

Get-ChildItem $snap -Recurse -File | ForEach-Object {
    $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    "{0}|{1}|{2}" -f $_.FullName.Replace($snap, ''), $_.Length, $h
} | Set-Content (Join-Path $bk "manifest.txt") -Encoding UTF8

Compress-Archive -Path (Join-Path $snap "*") -DestinationPath (Join-Path $bk "snapshot.zip") -Force
Set-Content (Join-Path $root "LATEST.txt") -Value $label -Encoding UTF8

"snapshot:      $bk"
"files copied:  $copied"
"dump-config:   exit=$dumpExit"
"size:          " + [math]::Round((Get-Item (Join-Path $bk "snapshot.zip")).Length / 1KB, 1) + " KB"
"latest marker: $label"

if ($dumpExit -ne 0) { "WARNING: dump-config failed, snapshot may describe a broken state"; exit 1 }
exit 0
