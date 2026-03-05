#!/usr/bin/env bash
# Transient Recall Power Mode controller.
# Starts/stops/status for interval auto-checkpoint daemon with sane defaults.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ACTION="${1:-status}"
STATE_DIR="$REPO_ROOT/.tr"
PID_FILE="$STATE_DIR/power-mode.pid"
LOG_FILE="$STATE_DIR/power-mode.log"

PROJECT_DEFAULT="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$REPO_ROOT")")"
PROJECT="${TR_PROJECT_DEFAULT:-$PROJECT_DEFAULT}"
INTERVAL_SEC="${TR_POWER_MODE_INTERVAL_SEC:-300}"
MODE="${TR_AUTO_CHECKPOINT_MODE:-project}"
MCP_URL="${TR_MCP_BASE_URL:-http://localhost:8090}"

mkdir -p "$STATE_DIR"

is_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

start() {
  if is_running; then
    echo "Power Mode already running (pid $(cat "$PID_FILE"))."
    echo "Log: $LOG_FILE"
    exit 0
  fi

  nohup node "$SCRIPT_DIR/auto-checkpoint-daemon.mjs" \
    --project="$PROJECT" \
    --mode="$MODE" \
    --interval_sec="$INTERVAL_SEC" \
    >> "$LOG_FILE" 2>&1 &

  local pid="$!"
  echo "$pid" > "$PID_FILE"

  echo "Power Mode started."
  echo "  pid: $pid"
  echo "  project: $PROJECT"
  echo "  mode: $MODE"
  echo "  interval_sec: $INTERVAL_SEC"
  echo "  mcp: $MCP_URL"
  echo "  log: $LOG_FILE"
}

stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "Power Mode is not running."
    exit 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Power Mode stopped (pid $pid)."
}

status() {
  if is_running; then
    echo "Power Mode: running (pid $(cat "$PID_FILE"))."
    echo "  log: $LOG_FILE"
    exit 0
  fi
  echo "Power Mode: stopped."
}

case "$ACTION" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart)
    stop
    start
    ;;
  *)
    echo "Usage: bash scripts/power-mode.sh [start|stop|status|restart]"
    exit 1
    ;;
esac
