# restart-dsh-safe.ps1 -- restart dsh web with a verifiable outcome.
#
# Two lessons baked in (both were real failures in this project):
#   1. Kill by PORT OWNER, never by command-line regex.
#      A regex 'dsh\\lib\\bin\.js' missed '.../dsh/lib/bin.js' (forward slashes),
#      so the script killed nothing and silently started a doomed second instance.
#   2. Success = NEW pid owns the port AND differs from the old pid.
#      The old version reported "port listening: True" purely because the OLD
#      process still held the socket.
#
# Exit codes: 0 ok, 1 new listener missing, 2 target is not node, 3 port not released

param(
    [int]$Port = 3080,
    [string]$WorkDir = "C:\Users\KonomiHasu\.dsh",
    [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Continue'
$node = "C:\Program Files\nodejs\node.exe"
$bin = "C:\Users\KonomiHasu\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
$logDir = "C:\Users\KonomiHasu\dsh-private\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir ("restart-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")

function L($m) {
    Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8
}

L "=== restart begin ==="
L "target port=$Port workdir=$WorkDir"

$oldPid = 0
$oldConn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($oldConn) { $oldPid = [int]$oldConn.OwningProcess; L "old listener pid=$oldPid" }
else { L "no listener on port $Port" }

if ($oldPid -ne 0) {
    $p = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($null -eq $p) {
        L "old pid vanished"
    }
    elseif ($p.ProcessName -eq 'node') {
        L "killing pid=$oldPid name=node"
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    }
    else {
        L "ABORT: pid=$oldPid is '$($p.ProcessName)', refusing to kill a non-node process"
        exit 2
    }
}

$released = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $c) { $released = $true; break }
}
L "port released=$released"
if (-not $released) { L "ABORT: port still held after 15s"; exit 3 }

Start-Process -FilePath $node -ArgumentList @($bin, "web") -WorkingDirectory $WorkDir -WindowStyle Hidden
L "spawned: node bin.js web (cwd=$WorkDir)"

$newPid = 0
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { $newPid = [int]$c.OwningProcess; break }
}
L "new listener pid=$newPid"

$ok = $false
if ($newPid -ne 0 -and $newPid -ne $oldPid) {
    $np = Get-Process -Id $newPid -ErrorAction SilentlyContinue
    if ($null -ne $np -and $np.ProcessName -eq 'node') { $ok = $true }
}
L "RESTART_OK=$ok (old=$oldPid new=$newPid)"
if (-not $ok) {
    L "=== restart FAILED: check $logDir for a startup-*.log with the real error ==="
    exit 1
}
L "=== restart end ==="
exit 0
