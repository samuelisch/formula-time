#!/usr/bin/env bash
# PreToolUse hook (matcher Bash). Acts only when the command runs `gh pr create`.
# The PR body must carry real Summary / Friction / Agent / ADRs affected lines,
# not the template placeholders. Handles --body "..." and --body-file/-F <path>.
set -u
cmd=$(jq -r '.tool_input.command // empty')
# Anchored: the phrase must start a command (line start or after ; & |), not merely appear in a message.
printf '%s\n' "$cmd" | grep -qE '(^|[;&|])[[:space:]]*gh pr create' || exit 0
body="$cmd"
file=$(printf '%s' "$cmd" | sed -nE 's/.*(--body-file|-F)[= ]+"?([^" ]+)"?.*/\2/p' | head -1)
if [ -n "$file" ] && [ -f "$file" ]; then body=$(cat "$file"); fi
missing=""
for key in Summary Friction Agent "ADRs affected"; do
  printf '%s\n' "$body" | grep -qE "^${key}: [^<]" || missing="$missing $key"
done
if [ -n "$missing" ]; then
  reason="PR body needs real lines for:$missing (no template placeholders). See .github/pull_request_template.md"
  jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
fi
exit 0
