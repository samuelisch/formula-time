#!/usr/bin/env bash
# PreToolUse hook (matcher Bash). Acts only when the command runs `git commit`.
# Gate: an install check, then typecheck, unit tests, and no edits to
# Accepted ADRs. Non-zero exit blocks the commit.
set -u
cmd=$(jq -r '.tool_input.command // empty')
# Anchored: the phrase must start a command (line start or after ; & |), not
# merely appear in a message. Options between "git" and "commit" (-c x=y,
# -C dir, --no-pager, ...) are skipped so an option-prefixed form still
# matches; "commit" must be a whole word so "git commitlog" does not.
printf '%s\n' "$cmd" | grep -qE '(^|[;&|])[[:space:]]*git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]]+)?)*[[:space:]]+commit([[:space:]]|$)' || exit 0

strip_quotes() {
  local p="$1"
  case "$p" in
    \"*\") p="${p#\"}"; p="${p%\"}" ;;
    \'*\') p="${p#\'}"; p="${p%\'}" ;;
  esac
  printf '%s' "$p"
}

# The tree the commit actually lands in is not always the hook's own cwd: an
# agent's Bash command can `cd` into another checkout, or pass `git -C`,
# before running `git commit` in the same command. Pick, in order: the last
# `cd <path> &&`/`cd <path>;` before the commit; else a `git -C <path>
# commit` in the same invocation; else the hook's own cwd, as before.
hook_cwd="$(pwd)"
raw_path=$(printf '%s\n' "$cmd" | sed -nE "s/.*(^|[;&|])[[:space:]]*cd[[:space:]]+(\"[^\"]*\"|'[^']*'|[^[:space:]]+)[[:space:]]*(&&|;).*/\\2/p")
if [ -z "$raw_path" ]; then
  raw_path=$(printf '%s\n' "$cmd" | sed -nE "s/.*(^|[;&|])[[:space:]]*git[[:space:]]+-C[[:space:]]+(\"[^\"]*\"|'[^']*'|[^[:space:]]+)[[:space:]]+commit.*/\\2/p")
fi

tree=""
if [ -n "$raw_path" ]; then
  path=$(strip_quotes "$raw_path")
  case "$path" in
    *'$'*)
      # A $VAR the hook cannot expand: never silently pass, name it and fall
      # back to gating the hook's own cwd tree.
      echo "pre-commit-check: cannot resolve '$path' (unexpanded variable); gating $hook_cwd instead" >&2
      ;;
    /*) abs="$path" ;;
    *) abs="$hook_cwd/$path" ;;
  esac
  if [ -n "${abs:-}" ]; then
    if resolved=$(git -C "$abs" rev-parse --show-toplevel 2>/dev/null); then
      tree="$resolved"
    else
      echo "pre-commit-check: cannot resolve '$path' to a git tree; gating $hook_cwd instead" >&2
    fi
  fi
fi

if [ -z "$tree" ]; then
  tree=$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-$hook_cwd}")
fi

cd "$tree" || exit 1

# A missing or stale install must read as a missing install, not as a
# typecheck error inside an unrelated package.
if [ ! -d "node_modules/.pnpm" ] || [ "pnpm-lock.yaml" -nt "node_modules/.pnpm" ]; then
  echo "run pnpm install in $tree"
  exit 1
fi

pnpm typecheck && pnpm test:unit && scripts/check-adr-immutable.sh
