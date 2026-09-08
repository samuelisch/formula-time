#!/usr/bin/env bash
# PreToolUse hook (matcher Bash). Acts only when the command runs `git commit`.
# Gate: typecheck, unit tests, and no edits to Accepted ADRs. Non-zero exit blocks the commit.
set -u
cmd=$(jq -r '.tool_input.command // empty')
# Anchored: the phrase must start a command (line start or after ; & |), not merely appear in a message.
printf '%s\n' "$cmd" | grep -qE '(^|[;&|])[[:space:]]*git commit' || exit 0
# Gate the tree the commit is happening in. Hooks run with cwd = the caller's
# directory, so for an agent in a git worktree this is the worktree, not the
# main checkout (CLAUDE_PROJECT_DIR always points at the main checkout).
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")" || exit 1
pnpm typecheck && pnpm test:unit && scripts/check-adr-immutable.sh
