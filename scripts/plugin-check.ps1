param(
  [string]$Profile = 'web',
  [switch]$DumpConfig
)

$ErrorActionPreference = 'Stop'
$srcRoot = 'C:\Users\KonomiHasu\dsh-private\packages'
$dstRoot = "C:\Users\KonomiHasu\.dsh\profiles\$Profile\node_modules\@yg"

$pkgs = Get-ChildItem -Directory $srcRoot | Where-Object {
  $pj = Join-Path $_.FullName 'package.json'
  if (-not (Test-Path $pj)) { return $false }
  $meta = Get-Content $pj -Raw -Encoding UTF8 | ConvertFrom-Json
  return $meta.name -like '@yg/*'
}

$missingFilesField = 0
$mismatched = 0
$missingDst = 0
$checked = 0

foreach ($p in $pkgs) {
  $meta = Get-Content (Join-Path $p.FullName 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $shortName = $meta.name -replace '^@yg/', ''
  $dstPkg = Join-Path $dstRoot $shortName
  $files = @($meta.files)
  if (-not $files.Count) {
    Write-Warning "[$($meta.name)] package.json 缺少 files 字段"
    $missingFilesField++
    continue
  }
  foreach ($rel in $files) {
    $srcFile = Join-Path $p.FullName $rel
    $dstFile = Join-Path $dstPkg $rel
    if (-not (Test-Path $srcFile)) {
      Write-Warning "[$($meta.name)] files 清单指向不存在的源文件: $rel"
      $missingFilesField++
      continue
    }
    $checked++
    if (-not (Test-Path $dstFile)) {
      Write-Warning "[$($meta.name)] profile 副本缺失: $rel"
      $missingDst++
      continue
    }
    $h1 = (Get-FileHash -Algorithm MD5 $srcFile).Hash
    $h2 = (Get-FileHash -Algorithm MD5 $dstFile).Hash
    if ($h1 -ne $h2) {
      Write-Warning "[$($meta.name)] MD5 不一致: $rel (src=$h1 dst=$h2)"
      $mismatched++
    }
  }
}

Write-Output "plugin-check: pkgs=$($pkgs.Count) checked=$checked missing_src=$missingFilesField missing_dst=$missingDst mismatched=$mismatched"

if ($DumpConfig) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = dsh --profile $Profile --dump-config 2>&1 | ForEach-Object { "$_" }
  $ErrorActionPreference = $prevEap
  $warns = $out | Select-String -Pattern 'patch:.*not found|incompatible' -CaseSensitive:$false
  Write-Output "dump-config warnings: $($warns.Count)"
  $warns | ForEach-Object { Write-Output "  $($_.Line)" }
}

if ($missingFilesField -gt 0 -or $missingDst -gt 0 -or $mismatched -gt 0) {
  exit 1
}
