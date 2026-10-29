#!/usr/bin/env bash
# Start/stop the NOC Automation app in the background.
#
#   ./app.sh start     start the app (detached; survives closing the terminal)
#   ./app.sh stop      graceful stop (running jobs are cancelled and recorded)
#   ./app.sh restart   stop, then start
#   ./app.sh status    show whether it's running, its PID and URL
#   ./app.sh logs      follow the log (Ctrl+C to quit)
#
# PID file: data/app.pid   Log file: data/logs/app.log

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$APP_DIR/data/app.pid"
LOG_DIR="$APP_DIR/data/logs"
LOG_FILE="$LOG_DIR/app.log"
STOP_TIMEOUT=15 # seconds to wait for a graceful stop before force-killing

cd "$APP_DIR"

port() {
  local p
  p=$(grep -E '^APP_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
  echo "${p:-3000}"
}

# PID of the running app, or empty. Ignores stale PID files and reused PIDs.
running_pid() {
  [[ -f "$PID_FILE" ]] || return 0
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'server\.js'; then
    echo "$pid"
  fi
}

start() {
  local pid
  pid=$(running_pid)
  if [[ -n "$pid" ]]; then
    echo "Already running (PID $pid) on http://localhost:$(port)"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: node is not installed or not on PATH." >&2
    exit 1
  fi
  if [[ ! -f .env ]]; then
    echo "Error: .env not found in $APP_DIR (copy .env.example and fill it in)." >&2
    exit 1
  fi
  if [[ ! -d node_modules ]]; then
    echo "Installing dependencies..."
    npm install --omit=dev
  fi

  mkdir -p "$LOG_DIR"
  echo "----- $(date '+%Y-%m-%d %H:%M:%S %Z') starting -----" >>"$LOG_FILE"
  # setsid + nohup: own session, so it keeps running after the terminal closes.
  setsid nohup node server.js >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"

  # Wait for it to come up (or fail).
  for _ in $(seq 1 20); do
    sleep 0.5
    pid=$(running_pid)
    if [[ -z "$pid" ]]; then
      echo "Failed to start. Last log lines:" >&2
      tail -n 20 "$LOG_FILE" >&2
      rm -f "$PID_FILE"
      exit 1
    fi
    if curl -s -o /dev/null "http://localhost:$(port)/login" 2>/dev/null; then
      echo "Started (PID $pid) on http://localhost:$(port)"
      echo "Logs: $LOG_FILE"
      return 0
    fi
  done
  echo "Started (PID $pid), but it isn't answering on port $(port) yet. Check: ./app.sh logs"
}

stop() {
  local pid
  pid=$(running_pid)
  if [[ -z "$pid" ]]; then
    echo "Not running."
    rm -f "$PID_FILE"
    return 0
  fi
  echo -n "Stopping (PID $pid)"
  kill -TERM "$pid" # graceful: cancels running jobs and records their status
  for _ in $(seq 1 $((STOP_TIMEOUT * 2))); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo " — stopped."
      return 0
    fi
    echo -n "."
    sleep 0.5
  done
  echo
  echo "Still running after ${STOP_TIMEOUT}s; force-killing."
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Stopped (forced)."
}

status() {
  local pid
  pid=$(running_pid)
  if [[ -n "$pid" ]]; then
    local since
    since=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
    echo "Running (PID $pid) on http://localhost:$(port) — since $since"
  else
    echo "Not running."
    return 3
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs)
    mkdir -p "$LOG_DIR"; touch "$LOG_FILE"
    tail -n 50 -f "$LOG_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
