# start-lab.ps1 -- 用 C:\dsh-lab 那份独立安装启动 profile
#
# 与 scripts\restart-safe.ps1 的区别：
#   restart-safe  管的是**全局安装**（web 主力环境）
#   start-lab     管的是**lab 独立安装**（实验环境，随便改）
#
# lab 的宿主代码与全局物理隔离，改 C:\dsh-lab\node_modules\@deepseek-ai\**
# 不会影响 web 用的那份。这是"激进改造"的安全边界。
#
# 用法：
#   powershell -File start-lab.ps1                  # profile private, 端口 3081
#   powershell -File start-lab.ps1 -Port 3082
#   powershell -File start-lab.ps1 -Profile web     # 用 lab 的 dsh 跑 web 配置（对照实验）

param(
    [string]$Profile = "private",
    [int]$Port = 3081,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Continue'
$bin = "C:\dsh-lab\node_modules\@deepseek-ai\dsh\lib\bin.js"

if (-not (Test-Path $bin)) {
    Write-Error "lab 安装不存在: $bin`n先执行: cd C:\dsh-lab ; npm i @deepseek-ai/dsh@0.2.1-rc.2"
    exit 1
}

# 端口占用检查：避免起一个注定失败的第二实例（这个坑踩过）
$holder = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($holder) {
    Write-Output "端口 $Port 已被 pid=$($holder.OwningProcess) 占用。"
    Write-Output "换一个端口：-Port $($Port + 1)"
    Write-Output "或先停掉占用者再启动。"
    exit 2
}

# 双保险：显式告诉 dsh-purge 宿主在哪。
# 它本来会从 process.argv[1]（即 lab 的 bin.js）自动推断到 C:\dsh-lab，
# 但显式设置可以避免将来它的检测逻辑变化时误判到全局安装、反过来污染 web。
$env:DSH_BASE = "C:\dsh-lab\node_modules\@deepseek-ai"

$argv = @($bin, "--profile", $Profile, "--port", "$Port")
if ($NoOpen) { $argv += "--no-open" }

Write-Output "启动: node $bin --profile $Profile --port $Port"
Write-Output "（第一行输出里带 ?token=... 的 URL 就是入口，token 每次启动都会变）"
Write-Output ""

& node @argv
