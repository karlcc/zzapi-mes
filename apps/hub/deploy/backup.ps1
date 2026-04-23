# zzapi-mes hub SQLite backup (Windows / msi-1).
#
# Register via Task Scheduler — see deploy/README or the Obsidian
# `zzapi-mes-sqlite-backup-procedure` note for the scheduled-task command.
# Uses `sqlite3 .backup` for a WAL-safe snapshot. Requires sqlite3.exe in PATH
# (install: `winget install SQLite.SQLite`).
#
# Env overrides: HUB_DB, HUB_BACKUP_DIR, HUB_BACKUP_RETAIN_DAYS.
$ErrorActionPreference = 'Stop'

$Db = if ($env:HUB_DB) { $env:HUB_DB } else { 'C:\var\zzapi-mes-hub\hub.db' }
$BackupDir = if ($env:HUB_BACKUP_DIR) { $env:HUB_BACKUP_DIR } else { 'C:\var\zzapi-mes-hub\backups' }
$RetainDays = if ($env:HUB_BACKUP_RETAIN_DAYS) { [int]$env:HUB_BACKUP_RETAIN_DAYS } else { 30 }

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Dest = Join-Path $BackupDir "hub-$Stamp.db"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

& sqlite3.exe $Db ".backup '$Dest'"
if ($LASTEXITCODE -ne 0) { throw "sqlite backup failed: exit $LASTEXITCODE" }

$check = & sqlite3.exe $Dest 'PRAGMA integrity_check;'
if ($check -ne 'ok') { throw "integrity check failed: $check" }

Compress-Archive -Path $Dest -DestinationPath "$Dest.zip"
Remove-Item $Dest

Get-ChildItem $BackupDir -Filter 'hub-*.db.zip' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetainDays) } |
  Remove-Item

Write-Host "backup complete: $Dest.zip"
