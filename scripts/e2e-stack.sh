#!/usr/bin/env bash
# Starts (or tears down) the rehearse-race stack for e2e: Postgres, the drip
# simulator on a fixture recording, ingest pointed at the simulator's
# output, the api, and the web dev server. `start` blocks until the api and
# web are both answering, then returns with the stack running in the
# background -- Playwright's `webServer` option runs `start`, so tests only
# begin once every part is up. PIDs land in .e2e/pids under the repo root
# so `stop` can find and end them from a separate invocation.
#
# Postgres: a local run brings up this worktree's own compose Postgres,
# exporting its DATABASE_URL/DATABASE_DIRECT_URL before any database
# command runs (including the migration) so an ambient value in the
# invoking shell is never used, and migrates it (torn down on `stop`). CI
# already has a Postgres service container and exports DATABASE_URL for it
# before calling this script, so a pre-set DATABASE_URL skips both -- CI
# migrates that database itself, the same way the `checks` job does.
#
# The simulator never touches the network, and ingest reads from the
# simulator's own output directory, never OpenF1.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$REPO_ROOT/.e2e"
PID_FILE="$STATE_DIR/pids"
LOG_DIR="$STATE_DIR/logs"
LOCAL_DB_MARKER="$STATE_DIR/started-local-db"

cmd="${1:-start}"
echo "e2e-stack: invoked with cmd=$cmd"

stop_stack() {
  if [ -f "$PID_FILE" ]; then
    while IFS= read -r pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    done <"$PID_FILE"
    rm -f "$PID_FILE"
  fi
  if [ -f "$LOCAL_DB_MARKER" ]; then
    (cd "$REPO_ROOT" && pnpm db:down) || true
    rm -f "$LOCAL_DB_MARKER"
  fi
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

# COMPOSE_PROJECT_NAME/DB_PORT/API_PORT/WEB_PORT for this worktree -- an
# already-exported value (e.g. from the test:e2e script that spawned this
# one) always wins, so this is a no-op when they are already set and a
# worktree-specific computation otherwise. Read unconditionally, before the
# DATABASE_URL branch below, so the api/web health checks further down
# always agree with the ports the api and web dev servers actually bind.
eval "$(scripts/db-env.sh)"

if [ -z "${DATABASE_URL:-}" ]; then
  pnpm db:up
  : >"$LOCAL_DB_MARKER"

  # An already-exported DATABASE_URL/DATABASE_DIRECT_URL in the invoking
  # shell (left over from other work) must never leak in here and get
  # migrated instead of the compose Postgres just started. This branch only
  # runs when neither was already set (checked above), so it is always this
  # worktree's own compose Postgres being exported here.
  export DATABASE_URL="postgres://formula:formula@localhost:${DB_PORT}/formula_time"
  export DATABASE_DIRECT_URL="$DATABASE_URL"

  # `docker compose up -d` returns once the container starts, not once
  # Postgres is accepting connections (no `--wait`), so a migrate right
  # after can race a still-starting server. Retry instead of failing
  # outright.
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
else
  echo "e2e-stack: DATABASE_URL already set, using the caller's Postgres"
fi

pnpm sim --recording "$RECORDING" --speed 20 --start race >"$LOG_DIR/sim.log" 2>&1 &
echo $! >>"$PID_FILE"

LIVE_SOURCE=./live-logs/sim pnpm dev:ingest >"$LOG_DIR/ingest.log" 2>&1 &
echo $! >>"$PID_FILE"

pnpm dev:api >"$LOG_DIR/api.log" 2>&1 &
echo $! >>"$PID_FILE"

pnpm dev:web >"$LOG_DIR/web.log" 2>&1 &
echo $! >>"$PID_FILE"

echo "e2e-stack: waiting for the api (port $API_PORT) and web dev server (port $WEB_PORT)..."
ready=false
for _ in $(seq 1 90); do
  api_ok=false
  web_ok=false
  curl -sf "localhost:${API_PORT}/health" >/dev/null 2>&1 && api_ok=true
  curl -sf "localhost:${WEB_PORT}" >/dev/null 2>&1 && web_ok=true
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
