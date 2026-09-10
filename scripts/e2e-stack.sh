#!/usr/bin/env bash
# Starts (or tears down) the rehearse-race stack for e2e: compose Postgres,
# the drip simulator on a fixture recording, ingest pointed at the
# simulator's output, the api, and the web dev server. `start` blocks until
# the api and web are both answering, then returns with the stack running
# in the background -- Playwright's `webServer` option runs `start`, so
# tests only begin once every part is up. PIDs land in .e2e/pids under the
# repo root so `stop` can find and end them from a separate invocation.
#
# Never points at anything but the local compose Postgres (rehearse-race
# skill): the simulator never touches the network, and ingest reads from
# the simulator's own output directory, never OpenF1.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$REPO_ROOT/.e2e"
PID_FILE="$STATE_DIR/pids"
LOG_DIR="$STATE_DIR/logs"

cmd="${1:-start}"

stop_stack() {
  if [ -f "$PID_FILE" ]; then
    while IFS= read -r pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    done <"$PID_FILE"
    rm -f "$PID_FILE"
  fi
  (cd "$REPO_ROOT" && pnpm db:down) || true
}

case "$cmd" in
  stop)
    stop_stack
    exit 0
    ;;
  start) ;;
  *)
    echo "usage: $0 [start|stop]" >&2
    exit 1
    ;;
esac

# The fixture recording. RECORDING overrides the default; a relative value
# is resolved against the repo root (not cwd) since `pnpm sim` runs with
# apps/ingest as its own working directory.
RECORDING="${RECORDING:-recordings/11361}"
case "$RECORDING" in
  /*) ;;
  *) RECORDING="$REPO_ROOT/$RECORDING" ;;
esac

mkdir -p "$STATE_DIR" "$LOG_DIR"
: >"$PID_FILE"

cd "$REPO_ROOT"
pnpm db:up

# Export this worktree's own compose Postgres before migrating it: an
# already-exported DATABASE_URL/DATABASE_DIRECT_URL in the invoking shell
# (left over from other work) must never leak in here and get migrated
# instead of the compose Postgres just started.
eval "$(scripts/db-env.sh)"
export DATABASE_URL="postgres://formula:formula@localhost:${DB_PORT}/formula_time"
export DATABASE_DIRECT_URL="$DATABASE_URL"

# `docker compose up -d` returns once the container starts, not once
# Postgres is accepting connections (no `--wait`), so a migrate right after
# can race a still-starting server. Retry instead of failing outright.
migrated=false
for _ in $(seq 1 15); do
  if pnpm db:migrate:deploy; then
    migrated=true
    break
  fi
  sleep 2
done
if [ "$migrated" != true ]; then
  echo "e2e-stack: database never became ready for migration" >&2
  exit 1
fi

pnpm sim --recording "$RECORDING" --speed 20 --start race >"$LOG_DIR/sim.log" 2>&1 &
echo $! >>"$PID_FILE"

LIVE_SOURCE=./live-logs/sim pnpm dev:ingest >"$LOG_DIR/ingest.log" 2>&1 &
echo $! >>"$PID_FILE"

pnpm dev:api >"$LOG_DIR/api.log" 2>&1 &
echo $! >>"$PID_FILE"

pnpm dev:web >"$LOG_DIR/web.log" 2>&1 &
echo $! >>"$PID_FILE"

echo "e2e-stack: waiting for the api and web dev server..."
ready=false
for _ in $(seq 1 90); do
  api_ok=false
  web_ok=false
  curl -sf localhost:3000/health >/dev/null 2>&1 && api_ok=true
  curl -sf localhost:5173 >/dev/null 2>&1 && web_ok=true
  if [ "$api_ok" = true ] && [ "$web_ok" = true ]; then
    ready=true
    break
  fi
  sleep 2
done

if [ "$ready" != true ]; then
  echo "e2e-stack: api or web did not become ready in time" >&2
  stop_stack
  exit 1
fi

echo "e2e-stack: ready"
