#!/usr/bin/env bash
# Install or remove the NOC Automation systemd service.
#
#   ./deploy/install-service.sh install     install, enable at boot and start
#   ./deploy/install-service.sh uninstall   stop, disable and remove
#
# Runs as your normal user and uses sudo for the systemd steps. The service runs
# as the user who installs it (override with SERVICE_USER=name).

set -euo pipefail

SERVICE=noc-automation
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$APP_DIR/deploy/$SERVICE.service"
UNIT_PATH="/etc/systemd/system/$SERVICE.service"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"

port() {
  local p
  p=$(grep -E '^APP_PORT=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
  echo "${p:-3000}"
}

install() {
  if [[ "$SERVICE_USER" == "root" ]]; then
    echo "Refusing to run the app as root. Run this script as your normal user (it uses sudo where needed)," >&2
    echo "or set SERVICE_USER=<name>." >&2
    exit 1
  fi
  local node group home
  node="$(command -v node || true)"
  [[ -n "$node" ]] || { echo "Error: node not found on PATH." >&2; exit 1; }
  [[ -f "$APP_DIR/.env" ]] || { echo "Error: $APP_DIR/.env not found (copy .env.example and fill it in)." >&2; exit 1; }
  group="$(id -gn "$SERVICE_USER")"
  home="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

  if [[ ! -d "$APP_DIR/node_modules" ]]; then
    echo "Installing dependencies..."
    (cd "$APP_DIR" && npm install --omit=dev)
  fi

  # A copy started with app.sh would hold the port; stop it first.
  if [[ -f "$APP_DIR/data/app.pid" ]] && kill -0 "$(cat "$APP_DIR/data/app.pid")" 2>/dev/null; then
    echo "Stopping the copy started with app.sh..."
    "$APP_DIR/app.sh" stop
  fi

  echo "Writing $UNIT_PATH (user: $SERVICE_USER, dir: $APP_DIR, node: $node)"
  sed -e "s|@USER@|$SERVICE_USER|g" -e "s|@GROUP@|$group|g" -e "s|@APP_DIR@|$APP_DIR|g" \
      -e "s|@NODE@|$node|g" -e "s|@HOME@|$home|g" "$TEMPLATE" | sudo tee "$UNIT_PATH" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE"

  for _ in $(seq 1 20); do
    sleep 0.5
    if curl -s -o /dev/null "http://localhost:$(port)/login"; then
      echo "Service $SERVICE is running on http://localhost:$(port) and will start at boot."
      echo "Logs: journalctl -u $SERVICE -f    Status: systemctl status $SERVICE"
      return 0
    fi
  done
  echo "The service was installed but isn't answering yet. Check: journalctl -u $SERVICE -n 50" >&2
  exit 1
}

uninstall() {
  if [[ ! -f "$UNIT_PATH" ]]; then
    echo "Service $SERVICE is not installed."
    return 0
  fi
  sudo systemctl disable --now "$SERVICE"
  sudo rm -f "$UNIT_PATH"
  sudo systemctl daemon-reload
  echo "Service $SERVICE removed. Start the app with ./app.sh start if you still need it."
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  *) echo "Usage: $0 {install|uninstall}" >&2; exit 2 ;;
esac
