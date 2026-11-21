# ui-theme.ps1 -- 开放式的 UI 主题旋钮
#
# 设计立场：不代替你决定审美。这个脚本只做三件事：
#   1. 告诉你哪些变量能调（12 个关键旋钮，不是 184 个）
#   2. 给几套现成参考色板（B站/GitHub/Nord/Solarized）
#   3. 把你调好的值写进前端 index.html
#
# 配置存在 dsh-private\ui\theme.json，可手工编辑，也可用 set 逐项改。
# 应用后刷新页面即生效，不用重启 dsh。
#
# 用法：
#   powershell -File ui-theme.ps1 list                 # 列关键旋钮 + 当前值
#   powershell -File ui-theme.ps1 preset bilibili      # 套用参考色板
#   powershell -File ui-theme.ps1 set "--dsw-alias-brand-primary=#ff6b9d"
#   powershell -File ui-theme.ps1 show                 # 看当前配置
#   powershell -File ui-theme.ps1 apply                # 写入前端
#   powershell -File ui-theme.ps1 reset                # 恢复官方外观
#
# 默认目标：C:\dsh-lab 的前端（只影响 private/3081）。
# 要改全局 web（3080）加 -Target global —— 升级会覆盖，慎用。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$uiDir = Join-Path $root "ui"
$cfgPath = Join-Path $uiDir "theme.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$DIST_LAB = "C:\dsh-lab\node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html"
$DIST_GLOBAL = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html"

# ---- 12 个关键旋钮 ----
$KNOBS = [ordered]@{
    "--dsw-alias-bg-base"                = "主背景"
    "--dsw-alias-bg-layer-1"             = "卡片/面板层"
    "--dsw-alias-bg-layer-2"             = "更高一层"
    "--dsw-alias-brand-primary"          = "品牌主色（按钮/强调）"
    "--dsw-alias-label-primary"          = "主文字"
    "--dsw-alias-label-secondary"        = "次要文字"
    "--dsw-alias-label-dimmed"           = "弱化文字/占位"
    "--dsw-alias-border-l1"              = "主边框"
    "--dsw-alias-border-l2"              = "次边框/分隔线"
    "--dsw-alias-state-error-primary"    = "错误色"
    "--dsw-alias-state-success-primary"  = "成功色"
    "--dsh-font-family-text"             = "正文字体"
    "--dsh-font-family-code"             = "等宽字体"
}

# ---- 参考色板（不是我的审美，是抄现成的）----
$PRESETS = @{
    bilibili = [ordered]@{
        "--dsw-alias-bg-base"               = "#f6f7f8"
        "--dsw-alias-bg-layer-1"            = "#ffffff"
        "--dsw-alias-bg-layer-2"            = "#f1f2f3"
        "--dsw-alias-brand-primary"         = "#fb7299"
        "--dsw-alias-label-primary"         = "#18191c"
        "--dsw-alias-label-secondary"       = "#61666d"
        "--dsw-alias-label-dimmed"          = "#9499a0"
        "--dsw-alias-border-l1"             = "#e3e5e7"
        "--dsw-alias-border-l2"             = "#f1f2f3"
        "--dsw-alias-state-error-primary"   = "#f56c6c"
        "--dsw-alias-state-success-primary" = "#00a1d6"
    }
    'github-dark' = [ordered]@{
        "--dsw-alias-bg-base"               = "#0d1117"
        "--dsw-alias-bg-layer-1"            = "#161b22"
        "--dsw-alias-bg-layer-2"            = "#21262d"
        "--dsw-alias-brand-primary"         = "#2f81f7"
        "--dsw-alias-label-primary"         = "#e6edf3"
        "--dsw-alias-label-secondary"       = "#8b949e"
        "--dsw-alias-label-dimmed"          = "#6e7681"
        "--dsw-alias-border-l1"             = "#30363d"
        "--dsw-alias-border-l2"             = "#21262d"
        "--dsw-alias-state-error-primary"   = "#f85149"
        "--dsw-alias-state-success-primary" = "#3fb950"
    }
    nord = [ordered]@{
        "--dsw-alias-bg-base"               = "#2e3440"
        "--dsw-alias-bg-layer-1"            = "#3b4252"
        "--dsw-alias-bg-layer-2"            = "#434c5e"
        "--dsw-alias-brand-primary"         = "#88c0d0"
        "--dsw-alias-label-primary"         = "#eceff4"
        "--dsw-alias-label-secondary"       = "#d8dee9"
        "--dsw-alias-label-dimmed"          = "#7b88a1"
        "--dsw-alias-border-l1"             = "#4c566a"
        "--dsw-alias-border-l2"             = "#434c5e"
        "--dsw-alias-state-error-primary"   = "#bf616a"
        "--dsw-alias-state-success-primary" = "#a3be8c"
    }
    'solarized-dark' = [ordered]@{
        "--dsw-alias-bg-base"               = "#002b36"
        "--dsw-alias-bg-layer-1"            = "#073642"
        "--dsw-alias-bg-layer-2"            = "#0a4453"
        "--dsw-alias-brand-primary"         = "#268bd2"
        "--dsw-alias-label-primary"         = "#93a1a1"
        "--dsw-alias-label-secondary"       = "#839496"
        "--dsw-alias-label-dimmed"          = "#586e75"
        "--dsw-alias-border-l1"             = "#073642"
        "--dsw-alias-border-l2"             = "#0a4453"
        "--dsw-alias-state-error-primary"   = "#dc322f"
        "--dsw-alias-state-success-primary" = "#859900"
    }
}

# ---- 用 $args（-File 模式下最可靠）----
$allArgs = @($args)
$target = "lab"
for ($i = 0; $i -lt $allArgs.Count; $i++) {
    if ($allArgs[$i] -eq '-Target' -and $i + 1 -lt $allArgs.Count) { $target = $allArgs[$i + 1] }
}
$pos = @($allArgs | Where-Object { $_ -notmatch '^-Target$' })
# 去掉 -Target 的值本身
$clean = @()
$skip = $false
foreach ($a in $allArgs) {
    if ($skip) { $skip = $false; continue }
    if ($a -eq '-Target') { $skip = $true; continue }
    $clean += $a
}
$action = 'list'
if ($clean.Count -ge 1) { $action = $clean[0] }
$rest = @()
if ($clean.Count -ge 2) { $rest = $clean[1..($clean.Count - 1)] }

$distPath = if ($target -eq 'global') { $DIST_GLOBAL } else { $DIST_LAB }

function Read-Cfg {
    if (Test-Path $cfgPath) {
        try { return Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { }
    }
    return [pscustomobject]@{ preset = ''; vars = [pscustomobject]@{} }
}
function Save-Cfg($obj) {
    if (-not (Test-Path $uiDir)) { New-Item -ItemType Directory -Path $uiDir -Force | Out-Null }
    [System.IO.File]::WriteAllText($cfgPath, ($obj | ConvertTo-Json -Depth 6), $utf8NoBom)
}

function Show-List {
    $cfg = Read-Cfg
    Write-Host "关键旋钮（当前生效值）："
    Write-Host ""
    Write-Host ("  {0,-38} {1,-22} {2}" -f "变量", "说明", "你的值")
    Write-Host ("  " + ("-" * 96))
    foreach ($k in $KNOBS.Keys) {
        $cur = ''
        if ($cfg.vars -and $cfg.vars.PSObject.Properties.Name -contains $k) { $cur = $cfg.vars.$k }
        Write-Host ("  {0,-38} {1,-22} {2}" -f $k, $KNOBS[$k], $cur)
    }
    Write-Host ""
    Write-Host ("可选色板: " + (($PRESETS.Keys | Sort-Object) -join ', '))
    if ($cfg.preset) { Write-Host "当前色板: $($cfg.preset)" }
    Write-Host "配置: $cfgPath"
}

function Apply-Preset([string]$name) {
    if ($name -eq 'reset') {
        if (Test-Path $distPath) {
            $bak = "$distPath.bak-lcs"
            if (Test-Path $bak) { Copy-Item $bak $distPath -Force; Write-Host "已恢复官方外观（从 $bak）" }
            else { Write-Host "没有备份文件，无法恢复。请重装 dsh 或手动还原 $distPath" }
        }
        if (Test-Path $cfgPath) { Remove-Item $cfgPath -Force }
        Write-Host "已清除主题配置"
        return
    }
    if (-not $PRESETS.ContainsKey($name)) {
        Write-Host ("没有色板 '$name'。可选: " + (($PRESETS.Keys | Sort-Object) -join ', ') + " 或 reset")
        return
    }
    $vars = [ordered]@{}
    foreach ($k in $PRESETS[$name].Keys) { $vars[$k] = $PRESETS[$name][$k] }
    Save-Cfg ([pscustomobject]@{ preset = $name; vars = [pscustomobject]$vars })
    Write-Host "已套用色板: $name"
    Apply-To-Dist
}

function Set-Var([string]$assignment) {
    $eq = $assignment.IndexOf('=')
    if ($eq -lt 1) { Write-Host "格式应为 --变量名=值，例如 --dsw-alias-brand-primary=#ff6b9d"; return }
    $k = $assignment.Substring(0, $eq).Trim()
    $v = $assignment.Substring($eq + 1).Trim()
    $cfg = Read-Cfg
    $vars = [ordered]@{}
    if ($cfg.vars) { foreach ($p in $cfg.vars.PSObject.Properties) { $vars[$p.Name] = $p.Value } }
    $vars[$k] = $v
    Save-Cfg ([pscustomobject]@{ preset = ($cfg.preset + ' (custom)').Trim(); vars = [pscustomobject]$vars })
    Write-Host "已设置 $k = $v"
    Apply-To-Dist
}

function Apply-To-Dist {
    $cfg = Read-Cfg
    if (-not $cfg.vars -or -not $cfg.vars.PSObject.Properties) { Write-Host "没有配置可应用"; return }
    if (-not (Test-Path $distPath)) { Write-Host "找不到前端: $distPath"; return }

    $lines = @()
    foreach ($p in $cfg.vars.PSObject.Properties) {
        $lines += ("  {0}: {1};" -f $p.Name, $p.Value)
    }
    $block = "<style id=""lcs-custom-theme"">`r`n:root {`r`n" + ($lines -join "`r`n") + "`r`n}`r`n</style>"

    $html = [System.IO.File]::ReadAllText($distPath)
    # 已有块则替换，否则注入到 </head> 前
    if ($html -match '(?s)<style id="lcs-custom-theme">.*?</style>') {
        $html = [regex]::Replace($html, '(?s)<style id="lcs-custom-theme">.*?</style>', $block)
    }
    else {
        $html = $html -replace '</head>', ($block + "`r`n</head>")
    }
    [System.IO.File]::WriteAllText($distPath, $html, $utf8NoBom)
    Write-Host "已写入 $distPath"
    Write-Host "刷新页面即生效（$target）"
}

switch ($action.ToLower()) {
    'list'   { Show-List }
    'show'   { $c = Read-Cfg; $c | ConvertTo-Json -Depth 6 }
    'preset' { Apply-Preset $rest[0] }
    'set'    { Set-Var $rest[0] }
    'apply'  { Apply-To-Dist }
    'reset'  { Apply-Preset 'reset' }
    default  { Write-Host "用法: ui-theme.ps1 <list|show|preset|set|apply|reset> [-Target lab|global]" }
}
