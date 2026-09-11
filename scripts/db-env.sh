#!/usr/bin/env bash
# Prints the compose project name and three dev ports for *this* worktree,
# one `KEY=VALUE` per line:
#
#   COMPOSE_PROJECT_NAME=ft-<8 hex>
#   DB_PORT=<port>
#   API_PORT=<port>
#   WEB_PORT=<port>
#
# Two worktrees never collide: each hashes `git rev-parse --show-toplevel`
# (its own path) into a distinct compose project name and three ports, so
# `docker compose` (which scopes containers/networks by project name), the
# Postgres host port, the api's dev port, and the web dev server's port are
# all worktree-specific. The three port ranges are disjoint by construction,
# so a collision between them is impossible regardless of the hash.
#
# The plain checkout (toplevel does NOT contain `/.claude/worktrees/`) always
# gets DB_PORT 5433, API_PORT 3000, WEB_PORT 5173, so existing docs and the
# ports every consumer already defaults to stay true. Every other worktree
# gets DB_PORT in 5440-5489, API_PORT in 3000-3199, WEB_PORT in 5173-5372,
# chosen by hashing its path.
#
# An already-exported COMPOSE_PROJECT_NAME, DB_PORT, API_PORT or WEB_PORT
# always wins over the computed default — this is the override for "port
# already in use", and how CI/Railway (which set DATABASE_URL, PORT directly,
# never these) stay unaffected.
#
# Usage: eval "$(scripts/db-env.sh)"   # or read the four lines directly
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
# this script never fails a deploy that reaches it. Without git (the Docker
# image) the hash is of the working directory; Railway and CI set
# DATABASE_URL themselves, so the derived port is unused there.
if command -v git >/dev/null 2>&1; then
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
else
  toplevel="$(pwd)"
fi
digest8="$(printf '%s' "$toplevel" | sha256_hex | cut -c1-8)"

# A hash command that is missing, or that prints something empty or
# non-hex, must never reach the arithmetic below carrying a bad value --
# that would either crash the script or (worse) leave a PORT variable
# empty. Treat anything but exactly 8 hex digits as "no hash available"
# and fall through to the plain-checkout defaults instead.
if ! [[ "$digest8" =~ ^[0-9a-fA-F]{8}$ ]]; then
  digest8=""
fi

compose_project_name="${COMPOSE_PROJECT_NAME:-ft-$digest8}"

is_worktree=false
case "$toplevel" in
  *"/.claude/worktrees/"*) is_worktree=true ;;
esac

if [ -n "${DB_PORT:-}" ]; then
  db_port="$DB_PORT"
elif [ "$is_worktree" = true ] && [ -n "$digest8" ]; then
  # 8 hex digits fit in bash's signed 64-bit arithmetic.
  db_port=$((5440 + (16#$digest8 % 50)))
else
  db_port=5433
fi

# Same hash integer as DB_PORT above, offset and reduced into its own
# disjoint range so a fetched API_PORT can never equal a fetched DB_PORT or
# WEB_PORT: API_PORT is 3000 + (that integer mod 200), giving 3000-3199.
if [ -n "${API_PORT:-}" ]; then
  api_port="$API_PORT"
elif [ "$is_worktree" = true ] && [ -n "$digest8" ]; then
  api_port=$((3000 + (16#$digest8 % 200)))
else
  api_port=3000
fi

# Same hash integer again, its own disjoint range: WEB_PORT is
# 5173 + (that integer mod 200), giving 5173-5372.
if [ -n "${WEB_PORT:-}" ]; then
  web_port="$WEB_PORT"
elif [ "$is_worktree" = true ] && [ -n "$digest8" ]; then
  web_port=$((5173 + (16#$digest8 % 200)))
else
  web_port=5173
fi

echo "COMPOSE_PROJECT_NAME=$compose_project_name"
echo "DB_PORT=$db_port"
echo "API_PORT=$api_port"
echo "WEB_PORT=$web_port"
