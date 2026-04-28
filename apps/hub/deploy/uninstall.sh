#!/usr/bin/env bash
# uninstall.sh — remove zzapi-mes hub from a Linux host
# Run from the repo root:  bash apps/hub/deploy/uninstall.sh
#
# What this does:
#   1. Stops and disables systemd units (hub + backup timer)
#   2. Removes systemd unit files + reloads daemon
#   3. Removes admin CLI symlink
#   4. Removes install directory (/opt/zzapi-mes-hub)
#   5. Optionally removes data directory (/var/lib/zzapi-mes-hub) — asks first
#   6. Optionally removes env file (/etc/zzapi-mes-hub.env) — asks first
#   7. Optionally removes the zzapi-mes system user — asks first
#
# Prerequisites:
#   - sudo privileges

set -euo pipefail

INSTALL_DIR="/opt/zzapi-mes-hub"
DATA_DIR="/var/lib/zzapi-mes-hub"
ENV_FILE="/etc/zzapi-mes-hub.env"
SERVICE_NAME="zzapi-mes-hub"
BACKUP_SERVICE="zzapi-mes-hub-backup"
BACKUP_TIMER="zzapi-mes-hub-backup.timer"
CLI_SYMLINK="/usr/local/bin/zzapi-mes-hub-admin"

confirm_removal() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N] " answer
  case "$answer" in
    [yY]*) return 0 ;;
    *)     return 1 ;;
  esac
}

# --- 1. Stop and disable systemd units ---
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Stopping $SERVICE_NAME..."
    sudo systemctl stop "$SERVICE_NAME"
  fi
  if systemctl is-active --quiet "$BACKUP_TIMER" 2>/dev/null; then
    echo "Stopping $BACKUP_TIMER..."
    sudo systemctl stop "$BACKUP_TIMER"
  fi
  if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Disabling $SERVICE_NAME..."
    sudo systemctl disable "$SERVICE_NAME"
  fi
  if systemctl is-enabled --quiet "$BACKUP_TIMER" 2>/dev/null; then
    echo "Disabling $BACKUP_TIMER..."
    sudo systemctl disable "$BACKUP_TIMER"
  fi
else
  echo "Warning: systemctl not found. If the hub is running, stop it manually." >&2
fi

# --- 2. Remove systemd unit files ---
for unit in "$SERVICE_NAME" "$BACKUP_SERVICE" "$BACKUP_TIMER"; do
  unit_file="/etc/systemd/system/${unit}.service"
  # Timer unit uses .timer suffix
  if [ "$unit" = "$BACKUP_TIMER" ]; then
    unit_file="/etc/systemd/system/${unit}"
  fi
  if [ -f "$unit_file" ]; then
    echo "Removing systemd unit $unit_file..."
    sudo rm "$unit_file"
  fi
done

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl daemon-reload
fi

# --- 3. Remove admin CLI symlink ---
if [ -L "$CLI_SYMLINK" ] || [ -e "$CLI_SYMLINK" ]; then
  echo "Removing CLI symlink $CLI_SYMLINK..."
  sudo rm -f "$CLI_SYMLINK"
fi

# --- 4. Remove install directory ---
if [ -d "$INSTALL_DIR" ]; then
  echo "Removing install directory $INSTALL_DIR..."
  sudo rm -rf "$INSTALL_DIR"
else
  echo "Install directory $INSTALL_DIR not found — skipping"
fi

# --- 5. Optionally remove data directory ---
if [ -d "$DATA_DIR" ]; then
  if confirm_removal "Remove data directory $DATA_DIR? (contains hub.db with API key hashes and audit log)"; then
    echo "Removing data directory $DATA_DIR..."
    sudo rm -rf "$DATA_DIR"
  else
    echo "Keeping data directory $DATA_DIR"
  fi
else
  echo "Data directory $DATA_DIR not found — skipping"
fi

# --- 6. Optionally remove env file ---
if [ -f "$ENV_FILE" ]; then
  if confirm_removal "Remove env file $ENV_FILE? (contains SAP credentials)"; then
    echo "Removing env file $ENV_FILE..."
    sudo rm -f "$ENV_FILE"
  else
    echo "Keeping env file $ENV_FILE"
  fi
else
  echo "Env file $ENV_FILE not found — skipping"
fi

# --- 7. Optionally remove system user ---
if id -u zzapi-mes >/dev/null 2>&1; then
  if confirm_removal "Remove system user 'zzapi-mes'? (only safe if no files remain owned by it)"; then
    echo "Removing system user zzapi-mes..."
    sudo userdel zzapi-mes
  else
    echo "Keeping system user zzapi-mes"
  fi
else
  echo "System user zzapi-mes not found — skipping"
fi

echo ""
echo "Uninstall complete."
if [ -d "$DATA_DIR" ]; then
  echo "Note: Data directory $DATA_DIR was preserved. Remove manually if desired."
fi
if [ -f "$ENV_FILE" ]; then
  echo "Note: Env file $ENV_FILE was preserved. Remove manually if desired."
fi
