# diag.ps1 -- Windows 端口/进程诊断（不用每次手拼五个命令）
#
# 设计要点（都是踩过的坑）：
#   1. Get-NetTCPConnection 有时查不到端口（IPv6 绑定、TIME_WAIT 残留），
#      所以查不到时回退 netstat -ano。
#   2. 杀进程只按 PID。用命令行正则匹配过两次失败：
#      'dsh\\lib\\bin\.js' 匹配不到 '.../dsh/lib/bin.js'（正斜杠）。
#   3. 进程树的父子关系用 ParentProcessId 精确取，不靠 PID 大小猜。

# 刻意不用 param + ValueFromRemainingArguments：
# `powershell -File script.ps1 port 3080` 这种调用方式下，ValueFromRemainingArguments
# 不会被填充，导致位置参数全丢、switch 落到默认分支、命令静默不执行。
# 直接读 $args 是唯一可靠的写法。
$allArgs = @($args)
$Force = $false
if ($allArgs -contains '-Force') {
    $Force = $true
    $allArgs = @($allArgs | Where-Object { $_ -ne '-Force' })
}
$Cmd = 'help'
if ($allArgs.Count -ge 1) { $Cmd = [string]$allArgs[0] }
$Rest = @()
if ($allArgs.Count -ge 2) { $Rest = @($allArgs[1..($allArgs.Count - 1)]) }

$ErrorActionPreference = 'Continue'

function Find-PortOwner([int]$Port) {
    # 先精确查，查不到回退 netstat
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
    $line = netstat -ano | Select-String ":$Port\s+.*LISTENING" | Select-Object -First 1
    if ($line) {
        $parts = ($line.Line -split '\s+') | Where-Object { $_ }
        return [int]$parts[-1]
    }
    return 0
}

function Show-Proc([int]$ProcId) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
    if (-not $p) {
        $gp = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
        if ($gp) { Write-Host ("  pid={0}  name={1}  (CommandLine 不可读)" -f $ProcId, $gp.ProcessName) }
        else { Write-Host "  pid=$ProcId  已不存在" }
        return
    }
    $cmdLine = $p.CommandLine
    if (-not $cmdLine) { $cmdLine = "(不可读，可能需要管理员)" }
    Write-Host ("  pid={0}  name={1}" -f $p.ProcessId, $p.Name)
    Write-Host ("  start={0}" -f $p.CreationDate)
    Write-Host ("  cmd={0}" -f $cmdLine)
}

function Cmd-Port([string]$PortStr) {
    $port = 0
    if (-not [int]::TryParse($PortStr, [ref]$port)) { Write-Host "端口必须是数字"; return 1 }
    $owner = Find-PortOwner $port
    if ($owner -eq 0) { Write-Host "端口 $port 无人监听"; return 0 }
    Write-Host "端口 $port 占用者："
    Show-Proc $owner
    return 0
}

function Cmd-Ports([string[]]$List) {
    foreach ($s in $List) { Cmd-Port $s; Write-Host "" }
    return 0
}

function Cmd-Listen() {
    $rows = @()
    $c = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
    if ($c) {
        $rows = $c | Select-Object LocalAddress, LocalPort, OwningProcess
    }
    else {
        $rows = netstat -ano | Select-String "LISTENING" | ForEach-Object {
            $p = ($_.Line -split '\s+') | Where-Object { $_ }
            [pscustomobject]@{ LocalAddress = $p[1]; LocalPort = [int]($p[1] -split ':')[-1]; OwningProcess = [int]$p[-1] }
        }
    }
    $rows | Sort-Object LocalPort | ForEach-Object {
        $name = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        "{0,-6} {1,-22} {2}" -f $_.LocalPort, $_.LocalAddress, ("pid={0} {1}" -f $_.OwningProcess, $name)
    }
    return 0
}

function Cmd-Proc([string]$Name) {
    $ps = Get-CimInstance Win32_Process -Filter "Name='$Name.exe'" -ErrorAction SilentlyContinue
    if (-not $ps) { $ps = Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*$Name*" } }
    if (-not $ps) { Write-Host "没找到匹配 '$Name' 的进程"; return 0 }
    foreach ($p in $ps) { Show-Proc $p.ProcessId; Write-Host "" }
    return 0
}

function Cmd-Tree([string]$PidStr) {
    $target = 0
    if (-not [int]::TryParse($PidStr, [ref]$target)) { Write-Host "PID 必须是数字"; return 1 }
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $chain = @()
    $cur = $target
    $guard = 0
    while ($cur -and $guard -lt 20) {
        $node = $all | Where-Object { $_.ProcessId -eq $cur } | Select-Object -First 1
        if (-not $node) { break }
        $chain = @($node) + $chain
        $cur = [int]$node.ParentProcessId
        $guard++
    }
    Write-Host "父子链（根 -> 叶）："
    foreach ($n in $chain) {
        $indent = "  " * [array]::IndexOf($chain, $n)
        Write-Host ("{0}pid={1} {2}" -f $indent, $n.ProcessId, $n.Name)
    }
    $kids = $all | Where-Object { $_.ParentProcessId -eq $target }
    if ($kids) {
        Write-Host "子进程："
        foreach ($k in $kids) { Write-Host ("  pid={0} {1}" -f $k.ProcessId, $k.Name) }
    }
    return 0
}

function Cmd-KillPort([string]$PortStr) {
    $port = 0
    if (-not [int]::TryParse($PortStr, [ref]$port)) { Write-Host "端口必须是数字"; return 1 }
    $owner = Find-PortOwner $port
    if ($owner -eq 0) { Write-Host "端口 $port 无人占用"; return 0 }
    $name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
    Write-Host "准备结束：端口 $port -> pid=$owner ($name)"
    Show-Proc $owner
    if (-not $Force) {
        $ans = Read-Host "确认结束这个进程？(y/N)"
        if ($ans -ne 'y' -and $ans -ne 'Y') { Write-Host "已取消"; return 0 }
    }
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    $still = Find-PortOwner $port
    if ($still -eq 0) { Write-Host "已结束，端口 $port 释放" }
    else { Write-Host "仍有进程占用端口 $port（pid=$still）" }
    return 0
}

# 用 if/elseif 而不是 switch：switch 里 `exit (Func ...)` 的写法在 -File 模式下
# 会把函数输出连同退出码一起吞掉，表现是"命令跑了但什么都不打印"。分开写最稳。
$exitCode = 0
$verb = $Cmd.ToLower()

if ($verb -eq 'port') {
    $exitCode = Cmd-Port $Rest[0]
}
elseif ($verb -eq 'ports') {
    $exitCode = Cmd-Ports $Rest
}
elseif ($verb -eq 'listen') {
    $exitCode = Cmd-Listen
}
elseif ($verb -eq 'proc') {
    $exitCode = Cmd-Proc $Rest[0]
}
elseif ($verb -eq 'tree') {
    $exitCode = Cmd-Tree $Rest[0]
}
elseif ($verb -eq 'killport') {
    $exitCode = Cmd-KillPort $Rest[0]
}
else {
    Write-Host "用法: diag.ps1 <port|ports|listen|proc|tree|killport> [args] [-Force]"
    Write-Host "  port 3080           谁占了 3080"
    Write-Host "  ports 3080 3081     批量"
    Write-Host "  listen              所有监听端口"
    Write-Host "  proc node           按名字找进程"
    Write-Host "  tree 8280           PID 的父子链"
    Write-Host "  killport 3081       按端口杀（会先确认）"
}

exit $exitCode