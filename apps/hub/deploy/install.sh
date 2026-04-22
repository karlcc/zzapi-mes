#!/usr/bin/env bash
# deploy.sh — install zzapi-mes hub on a Linux host
# Run from the repo root:  bash apps/hub/deploy/deploy.sh
#
# Prerequisites:
#   - Node 20+ installed at /usr/bin/node
#   - A non-root user (e.g. zzapi-mes) to run the service
#
# What this does:
#   1. Builds the project if dist/ is missing
#   2. Copies hub dist + node_modules to /opt/zzapi-mes-hub
#   3. Installs the env file if none exists
#   4. Installs and enables the systemd unit

set -euo pipefail

INSTALL_DIR="/opt/zzapi-mes-hub"
ENV_FILE="/etc/zzapi-mes-hub.env"
SERVICE_USER="${SUDO_USER:-zzapi-mes}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.."/".." && pwd)"

# --- 1. Build if needed ---
if [ ! -d "$REPO_ROOT/apps/hub/dist" ]; then
  echo "Building project..."
  (cd "$REPO_ROOT" && pnpm build)
fi

# --- 2. Copy to install dir ---
echo "Installing to $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"
sudo rsync -a --delete "$REPO_ROOT/apps/hub/dist/" "$INSTALL_DIR/dist/"

# Copy node_modules needed at runtime
# We need @hono/node-server, hono, zod, and @zzapi-mes/core + its deps
if [ -d "$REPO_ROOT/apps/hub/node_modules" ]; then
  sudo rsync -a "$REPO_ROOT/apps/hub/node_modules/" "$INSTALL_DIR/node_modules/"
else
  echo "Installing production dependencies..."
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile)
  sudo rsync -a "$REPO_ROOT/apps/hub/node_modules/" "$INSTALL_DIR/node_modules/"
  # Also need core's node_modules (zod)
  sudo rsync -a "$REPO_ROOT/packages/core/node_modules/" "$INSTALL_DIR/node_modules/"
  sudo rsync -a "$REPO_ROOT/packages/core/dist/" "$INSTALL_DIR/node_modules/@zzapi-mes/core/dist/"
fi

# --- 3. Env file ---
if [ ! -f "$ENV_FILE" ]; then
  echo "Installing example env file to $ENV_FILE"
  sudo cp "$SCRIPT_DIR/zzapi-mes-hub.env.example" "$ENV_FILE"
  echo "!! Edit $ENV_FILE with your values before starting the service !!"
else
  echo "Env file $ENV_FILE already exists — not overwriting"
fi

# --- 4. Systemd unit ---
echo "Installing systemd unit..."
sudo cp "$SCRIPT_DIR/zzapi-mes-hub.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable zzapi-mes-hub

echo ""
echo "Done. To start the hub:"
echo "  sudo systemctl start zzapi-mes-hub"
echo "  sudo systemctl status zzapi-mes-hub"
echo ""
echo "To view logs:"
echo "  journalctl -u zzapi-mes-hub -f"
