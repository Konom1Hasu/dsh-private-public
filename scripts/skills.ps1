# skills.ps1 -- 按需挂载 dsh-private 的 skill 库
#
# 为什么不放全局：
#   全局 ~/.dsh/skills 走 skill-filesystem 的 includeDefaultRoots，
#   会被**每个 profile、每个会话**扫描。skill 的 description 常驻系统提示，
#   装多了是每轮固定开销。
#
# 做法：skill 全部放 dsh-private\skills（库），需要时给某个 profile 挂
# customSkillDirs 指向它。挂载靠 profile 的 cordis.patch.yml，HMR 热生效。
#
# 用法：
#   powershell -File skills.ps1 list                    # 看库里有什么
#   powershell -File skills.ps1 status                  # 看各 profile 挂没挂
#   powershell -File skills.ps1 enable -Profile private # 挂到 private
#   powershell -File skills.ps1 disable -Profile private
#
# 注意：挂载段用注释标记包围，disable 靠标记精确删除，不会误伤你手写的配置。

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$lib = Join-Path (Split-Path -Parent $PSScriptRoot) "skills"
$dshHome = Join-Path $env:USERPROFILE ".dsh"
$utf8 = New-Object System.Text.UTF8Encoding($false)

$BEGIN = '# >>> dsh-private skills library (managed by skills.ps1) -- do not edit by hand'
$END   = '# <<< dsh-private skills library'

# 用 $args 而非 param：powershell -File 下位置参数绑定更可靠
$allArgs = @($args)
function Get-Arg([string]$Name) {
    for ($i = 0; $i -lt $allArgs.Count; $i++) {
        if ($allArgs[$i] -eq "-$Name" -and $i + 1 -lt $allArgs.Count) { return $allArgs[$i + 1] }
    }
    return $null
}
$action = 'list'
if ($allArgs.Count -ge 1 -and -not $allArgs[0].StartsWith('-')) { $action = $allArgs[0] }
$profile = Get-Arg 'Profile'
if (-not $profile) { $profile = 'private' }

function Show-Library() {
    Write-Host "skill 库: $lib"
    if (-not (Test-Path $lib)) { Write-Host "  （不存在）"; return }
    $dirs = Get-ChildItem $lib -Directory -ErrorAction SilentlyContinue
    if (-not $dirs) { Write-Host "  （空）"; return }
    foreach ($d in $dirs) {
        $hasSkill = Test-Path (Join-Path $d.FullName "SKILL.md")
        $scripts = (Get-ChildItem $d.FullName -File | Where-Object { $_.Name -ne 'SKILL.md' } | Select-Object -ExpandProperty Name) -join ', '
        $mark = if ($hasSkill) { 'ok ' } else { 'BAD' }
        Write-Host ("  [{0}] {1,-18} {2}" -f $mark, $d.Name, $scripts)
    }
}

function Get-Patch([string]$prof) {
    return Join-Path $dshHome "profiles\$prof\cordis.patch.yml"
}

function Show-Status() {
    $profilesDir = Join-Path $dshHome "profiles"
    if (-not (Test-Path $profilesDir)) { Write-Host "没有 profiles 目录"; return }
    foreach ($p in Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue) {
        $patch = Join-Path $p.FullName "cordis.patch.yml"
        if (-not (Test-Path $patch)) { Write-Host ("  {0,-12} 无 patch 文件" -f $p.Name); continue }
        $txt = [System.IO.File]::ReadAllText($patch)
        $mounted = $txt.Contains($BEGIN)
        Write-Host ("  {0,-12} {1}" -f $p.Name, $(if ($mounted) { '已挂载 skill 库' } else { '未挂载' }))
    }
}

function Enable-Lib([string]$prof) {
    $patch = Get-Patch $prof
    if (-not (Test-Path $patch)) { Write-Host "找不到 $patch"; return 1 }
    $txt = [System.IO.File]::ReadAllText($patch)
    if ($txt.Contains($BEGIN)) { Write-Host "$prof 已挂载，跳过"; return 0 }

    $libPath = $lib.Replace('\', '/')
    $block = @"

$BEGIN
# skill 库由 dsh-private 维护；取消挂载用 skills.ps1 disable -Profile $prof
- id: skill-filesystem
  name: "@deepseek-ai/dsh-skill-filesystem"
  config:
    customSkillDirs:
      - $libPath
$END
"@
    # 保留原文件末尾换行，追加挂载段
    [System.IO.File]::WriteAllText($patch, ($txt.TrimEnd() + "`r`n" + $block + "`r`n"), $utf8)
    Write-Host "已挂载到 $prof -> $lib"
    Write-Host "（HMR 会自动重载；若没生效，用 scripts\restart-safe.ps1 重启）"
    return 0
}

function Disable-Lib([string]$prof) {
    $patch = Get-Patch $prof
    if (-not (Test-Path $patch)) { Write-Host "找不到 $patch"; return 1 }
    $txt = [System.IO.File]::ReadAllText($patch)
    if (-not $txt.Contains($BEGIN)) { Write-Host "$prof 未挂载，跳过"; return 0 }
    $pattern = '(?s)\r?\n?' + [regex]::Escape($BEGIN) + '.*?' + [regex]::Escape($END) + '\r?\n?'
    $new = [regex]::Replace($txt, $pattern, "`r`n")
    [System.IO.File]::WriteAllText($patch, $new, $utf8)
    Write-Host "已从 $prof 卸载 skill 库"
    return 0
}

switch ($action.ToLower()) {
    'list'    { Show-Library }
    'status'  { Show-Status }
    'enable'  { $null = Enable-Lib $profile }
    'disable' { $null = Disable-Lib $profile }
    default {
        Write-Host "用法: skills.ps1 <list|status|enable|disable> [-Profile <name>]"
    }
}
