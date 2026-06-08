#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/tmp/metapi-dev.pid"
LOG_FILE="${METAPI_DEV_LOG:-/dev/null}"
CMD=(npm run dev)

usage() {
  cat <<'EOF'
Usage: ./metapi-dev.sh <start|stop|restart|status>

Commands:
  start    Start local dev server in the background without terminal logs
  stop     Stop the background local dev server
  restart  Stop and start again
  status   Show process and port status

Optional:
  METAPI_DEV_LOG=/path/to/file ./metapi-dev.sh start
    Write service logs to a file instead of /dev/null.
EOF
}

read_pid() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi

  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [ -z "$pid" ]; then
    return 1
  fi

  printf '%s\n' "$pid"
}

is_running() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

env_value() {
  local key="$1"
  local fallback="$2"
  local current="${!key:-}"
  if [ -n "$current" ]; then
    printf '%s\n' "$current"
    return
  fi

  if [ -f "$ROOT_DIR/.env" ]; then
    local from_file
    from_file="$(
      awk -F= -v key="$key" '
        $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
          sub(/^[^=]*=/, "", $0)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
          gsub(/^"|"$/, "", $0)
          gsub(/^'\''|'\''$/, "", $0)
          value=$0
        }
        END { if (value != "") print value }
      ' "$ROOT_DIR/.env"
    )"
    if [ -n "$from_file" ]; then
      printf '%s\n' "$from_file"
      return
    fi
  fi

  printf '%s\n' "$fallback"
}

descendant_pids() {
  local parent="$1"
  local children child
  children="$(pgrep -P "$parent" 2>/dev/null || true)"
  for child in $children; do
    descendant_pids "$child"
    printf '%s\n' "$child"
  done
}

cleanup_stale_pid() {
  local pid
  if ! pid="$(read_pid)"; then
    rm -f "$PID_FILE"
    return
  fi

  if ! is_running "$pid"; then
    rm -f "$PID_FILE"
  fi
}

start() {
  cleanup_stale_pid

  local existing_pid
  if existing_pid="$(read_pid 2>/dev/null)" && is_running "$existing_pid"; then
    echo "metapi dev is already running (pid $existing_pid)"
    status
    return
  fi

  mkdir -p "$(dirname "$PID_FILE")"
  cd "$ROOT_DIR"

  nohup "${CMD[@]}" > "$LOG_FILE" 2>&1 &
  local pid="$!"
  printf '%s\n' "$pid" > "$PID_FILE"

  echo "metapi dev started (pid $pid)"
  echo "frontend: http://127.0.0.1:$(env_value FRONTEND_PORT 5183)"
  echo "api:      http://127.0.0.1:$(env_value PORT 4000)"
}

stop() {
  local pid
  if ! pid="$(read_pid 2>/dev/null)"; then
    echo "metapi dev is not running"
    rm -f "$PID_FILE"
    return
  fi

  if ! is_running "$pid"; then
    echo "metapi dev is not running"
    rm -f "$PID_FILE"
    return
  fi

  local descendants
  descendants="$(descendant_pids "$pid" | sort -rn || true)"

  if [ -n "$descendants" ]; then
    # shellcheck disable=SC2086
    kill $descendants >/dev/null 2>&1 || true
  fi
  kill "$pid" >/dev/null 2>&1 || true

  sleep 1

  descendants="$(descendant_pids "$pid" | sort -rn || true)"
  if [ -n "$descendants" ]; then
    # shellcheck disable=SC2086
    kill -9 $descendants >/dev/null 2>&1 || true
  fi
  if is_running "$pid"; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi

  rm -f "$PID_FILE"
  echo "metapi dev stopped"
}

status() {
  local managed=0
  local pid
  if pid="$(read_pid 2>/dev/null)" && is_running "$pid"; then
    echo "metapi dev: running (pid $pid)"
    managed=1
  else
    echo "metapi dev: stopped"
    rm -f "$PID_FILE"
  fi

  local api_port
  local frontend_port
  api_port="$(env_value PORT 4000)"
  frontend_port="$(env_value FRONTEND_PORT 5183)"

  if lsof -i :"$api_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "api port $api_port: listening"
  else
    echo "api port $api_port: not listening"
  fi

  if lsof -i :"$frontend_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "frontend port $frontend_port: listening"
  else
    echo "frontend port $frontend_port: not listening"
  fi

  if [ "$managed" -eq 0 ] && (
    lsof -i :"$api_port" -sTCP:LISTEN >/dev/null 2>&1 ||
    lsof -i :"$frontend_port" -sTCP:LISTEN >/dev/null 2>&1
  ); then
    echo "note: ports are listening, but no managed pid file exists; the service may have been started manually"
  fi
}

case "${1:-}" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop
    start
    ;;
  status)
    status
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
