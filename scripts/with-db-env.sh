#!/usr/bin/env bash
# Runs a command with this worktree's COMPOSE_PROJECT_NAME/DB_PORT (from
# scripts/db-env.sh) exported, plus a DATABASE_URL/DATABASE_DIRECT_URL
# default derived from DB_PORT — but only when the caller hasn't already set
# one, so CI (real service container) and Railway (managed Postgres) are
# untouched.
#
# Usage: scripts/with-db-env.sh <command> [args...]
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -eq 0 ]; then
  echo "with-db-env: usage: scripts/with-db-env.sh <command> [args...]" >&2
  exit 1
fi

# Railway (pre-deploy `pnpm db:migrate:deploy`) and CI set DATABASE_URL
# themselves and run in images without git; the worktree derivation is
# purely a local-dev convenience, so skip it entirely when the URL is set.
if [ -n "${DATABASE_URL:-}" ]; then
  : "${DATABASE_DIRECT_URL:=$DATABASE_URL}"
  export DATABASE_DIRECT_URL
  exec "$@"
fi

db_env_output="$("$script_dir/db-env.sh")" || {
  echo "with-db-env: scripts/db-env.sh failed (see above)" >&2
  exit 1
}
while IFS='=' read -r key val; do
  export "${key}=${val}"
done <<<"$db_env_output"

: "${DATABASE_URL:=postgres://formula:formula@localhost:${DB_PORT}/formula_time}"
: "${DATABASE_DIRECT_URL:=$DATABASE_URL}"
export DATABASE_URL DATABASE_DIRECT_URL

if [ "${1:-}" = "docker" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "with-db-env: docker not found on PATH. Install Docker (Docker Desktop, or the docker CLI + a running daemon) to run this command." >&2
    exit 1
  fi

  if [ "${2:-}" = "compose" ] && [ "${3:-}" = "up" ]; then
    if ! "$@"; then
      status=$?
      echo "with-db-env: 'docker compose up' failed (exit $status)." >&2
      echo "with-db-env: if the error above says port ${DB_PORT} is already allocated, override it: DB_PORT=<free-port> pnpm db:up" >&2
      exit "$status"
    fi
    exit 0
  fi
fi

exec "$@"
