# zzapi-mes hub SQLite backup (Windows / msi-1).
#
# Register via Task Scheduler — see deploy/README or the Obsidian
# `zzapi-mes-sqlite-backup-procedure` note for the scheduled-task command.
# Uses `sqlite3 .backup` for a WAL-safe snapshot. Requires sqlite3.exe in PATH
# (install: `winget install SQLite.SQLite`).
#
# Env overrides: HUB_DB_PATH, HUB_BACKUP_DIR, HUB_BACKUP_RETAIN_DAYS.
$ErrorActionPreference = 'Stop'

# --- Pre-flight checks ---
if (-not (Get-Command sqlite3.exe -ErrorAction SilentlyContinue)) {
    Write-Error "sqlite3.exe not found in PATH. Install via: winget install SQLite.SQLite"
    exit 1
}

$Db = if ($env:HUB_DB_PATH) { $env:HUB_DB_PATH } else { 'C:\var\zzapi-mes-hub\hub.db' }
$BackupDir = if ($env:HUB_BACKUP_DIR) { $env:HUB_BACKUP_DIR } else { 'C:\var\zzapi-mes-hub\backups' }

if (-not (Test-Path $Db)) {
    Write-Error "database file not found: $Db"
    exit 1
}

$RetainDays = if ($env:HUB_BACKUP_RETAIN_DAYS) { [int]$env:HUB_BACKUP_RETAIN_DAYS } else { 30 }
if ($RetainDays -le 0) {
    Write-Error "HUB_BACKUP_RETAIN_DAYS must be a positive integer (got $RetainDays)"
    exit 1
}

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Dest = Join-Path $BackupDir "hub-$Stamp.db"

# Cleanup partial backup on failure
trap {
    if (Test-Path $Dest) { Remove-Item $Dest -Force -ErrorAction SilentlyContinue }
    if (Test-Path "$Dest.zip") { Remove-Item "$Dest.zip" -Force -ErrorAction SilentlyContinue }
    break
}

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
