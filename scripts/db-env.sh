#!/usr/bin/env bash
# Prints the compose project name and host port for *this* worktree's local
# Postgres, one `KEY=VALUE` per line:
#
#   COMPOSE_PROJECT_NAME=ft-<8 hex>
#   DB_PORT=<port>
#
# Two worktrees never collide: each hashes `git rev-parse --show-toplevel`
# (its own path) into a distinct compose project name and port, so
# `docker compose` (which scopes containers/networks by project name) and the
# Postgres host port are both worktree-specific.
#
# The plain checkout (toplevel does NOT contain `/.claude/worktrees/`) always
# gets port 5433, so existing docs ("Postgres on host port 5433") stay true.
# Every other worktree gets a port in 5440-5489, chosen by hashing its path.
#
# An already-exported COMPOSE_PROJECT_NAME or DB_PORT always wins over the
# computed default — this is the override for "port already in use", and how
# CI/Railway (which set DATABASE_URL directly, never DB_PORT) stay unaffected.
#
# Usage: eval "$(scripts/db-env.sh)"   # or read the two lines directly
set -euo pipefail

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  else
    openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}

# git is absent in the Docker image; fall back to the working directory so
# this script never fails a deploy that reaches it.
if command -v git >/dev/null 2>&1; then
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
else
  toplevel="$(pwd)"
fi
digest8="$(printf '%s' "$toplevel" | sha256_hex | cut -c1-8)"

compose_project_name="${COMPOSE_PROJECT_NAME:-ft-$digest8}"

if [ -n "${DB_PORT:-}" ]; then
  db_port="$DB_PORT"
else
  case "$toplevel" in
    *"/.claude/worktrees/"*)
      # 8 hex digits fit in bash's signed 64-bit arithmetic.
      db_port=$((5440 + (16#$digest8 % 50)))
      ;;
    *)
      db_port=5433
      ;;
  esac
fi

echo "COMPOSE_PROJECT_NAME=$compose_project_name"
echo "DB_PORT=$db_port"
