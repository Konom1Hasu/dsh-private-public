# 把主模型改回 deepseek。万一接 gemini 之后 dsh 起不来或不能回话，跑这个。
param([string]$Backup = 'C:\Users\KonomiHasu\dsh-private\backups\web-patch-before-gemini-20261116-192936.yml')
$pf = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
if (-not (Test-Path $Backup)) { Write-Host "备份不存在: $Backup"; exit 1 }
Copy-Item $Backup $pf -Force
Write-Host "已从备份恢复: $Backup"
Write-Host "重启: powershell -File C:\Users\KonomiHasu\dsh-private\scripts\restart-safe.ps1 -Port 3080"
