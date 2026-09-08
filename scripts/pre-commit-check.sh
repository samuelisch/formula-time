#!/usr/bin/env bash
# PreToolUse hook (matcher Bash). Acts only when the command runs `git commit`.
# Gate: typecheck, unit tests, and no edits to Accepted ADRs. Non-zero exit blocks the commit.
set -u
cmd=$(jq -r '.tool_input.command // empty')
# Anchored: the phrase must start a command (line start or after ; & |), not merely appear in a message.
printf '%s\n' "$cmd" | grep -qE '(^|[;&|])[[:space:]]*git commit' || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1
pnpm typecheck && pnpm test:unit && scripts/check-adr-immutable.sh
