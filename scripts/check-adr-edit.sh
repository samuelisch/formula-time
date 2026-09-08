#!/usr/bin/env bash
# PreToolUse hook (matcher Edit|Write). Denies an edit to an ADR that is
# Accepted on main. Reads the file's status from main, not from the working
# tree: an ADR new in the current branch is editable until it merges, even
# when it already says "Proposed (accepted when this PR merges)".
set -u
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in */docs/decisions-adr/*) ;; *) exit 0 ;; esac
dir=$(dirname "$f")
base=$(git -C "$dir" rev-parse -q --verify origin/main 2>/dev/null || git -C "$dir" rev-parse -q --verify main 2>/dev/null) || exit 0
rel="docs/decisions-adr/${f##*/docs/decisions-adr/}"
if git -C "$dir" show "$base:$rel" 2>/dev/null | grep -qE 'Status:\*\* (Accepted|Proposed \(accepted when this PR merges\))'; then
  jq -cn '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"ADR is Accepted on main; write a superseding one"}}'
fi
exit 0
