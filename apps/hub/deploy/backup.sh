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

# Pre-flight: verify sqlite3 is available
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found in PATH" >&2
  exit 1
fi

# Pre-flight: verify DB file exists
if [ ! -f "$DB" ]; then
  echo "database file not found: $DB" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Cleanup trap — remove partial backup on exit/err
cleanup() {
  if [ -f "$DEST" ]; then
    rm -f "$DEST"
  fi
  if [ -f "${DEST}.gz" ]; then
    rm -f "${DEST}.gz"
  fi
}
trap cleanup EXIT

# Set busy_timeout on the source DB so .backup waits for locks instead of failing
sqlite3 "$DB" "PRAGMA busy_timeout = 5000;" ".backup '$DEST'"

# Integrity check — any non-'ok' line aborts.
if ! sqlite3 "$DEST" "PRAGMA integrity_check;" | grep -q '^ok$'; then
  echo "integrity check failed for $DEST" >&2
  exit 1
fi

gzip "$DEST"

# Remove the trap after successful gzip — we only want cleanup on failure
trap - EXIT

find "$BACKUP_DIR" -name 'hub-*.db.gz' -mtime "+$RETAIN_DAYS" -delete

echo "backup complete: ${DEST}.gz"
