#!/bin/bash
# zzapi-mes hub SQLite backup (Linux).
#
# Install alongside a systemd timer — see zzapi-mes-hub-backup.timer.
# Uses `sqlite3 .backup` for a WAL-safe snapshot (plain `cp` would miss the
# -wal/-shm files and produce a corrupt copy).
#
# Env overrides: HUB_DB, HUB_BACKUP_DIR, HUB_BACKUP_RETAIN_DAYS.
set -euo pipefail

DB="${HUB_DB:-/var/zzapi-mes-hub/hub.db}"
BACKUP_DIR="${HUB_BACKUP_DIR:-/var/zzapi-mes-hub/backups}"
RETAIN_DAYS="${HUB_BACKUP_RETAIN_DAYS:-30}"

# Validate RETAIN_DAYS is a positive integer — non-numeric values (e.g. "abc")
# would cause find's -mtime to silently skip deletion, retaining backups forever.
if ! [[ "$RETAIN_DAYS" =~ ^[0-9]+$ ]] || [ "$RETAIN_DAYS" -eq 0 ]; then
  echo "HUB_BACKUP_RETAIN_DAYS must be a positive integer (got: $RETAIN_DAYS)" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/hub-$STAMP.db"

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB" ".backup '$DEST'"

# Integrity check — any non-'ok' line aborts.
if ! sqlite3 "$DEST" "PRAGMA integrity_check;" | grep -q '^ok$'; then
  echo "integrity check failed for $DEST" >&2
  exit 1
fi

gzip "$DEST"

find "$BACKUP_DIR" -name 'hub-*.db.gz' -mtime "+$RETAIN_DAYS" -delete

echo "backup complete: ${DEST}.gz"
