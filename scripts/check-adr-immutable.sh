#!/usr/bin/env bash
# Fails if any ADR that is Accepted on main differs in the working tree.
# Accepted ADRs are superseded, never edited (AGENTS.md rule). Follows renames,
# so moving the folder does not hide an edit. Run from the commit hook and CI.
set -u
# Base to diff against: ADR_CHECK_BASE when set and resolvable (CI passes the
# pre-push tip on a push to main), else origin/main, else main.
git fetch -q origin main 2>/dev/null || true
base=""
if [ -n "${ADR_CHECK_BASE:-}" ]; then
  base=$(git rev-parse -q --verify "${ADR_CHECK_BASE}^{commit}" 2>/dev/null || true)
fi
[ -n "$base" ] || base=$(git rev-parse -q --verify origin/main 2>/dev/null || git rev-parse -q --verify main) || exit 0
status=0
while IFS=$'\t' read -r kind old new; do
  [ -z "${kind:-}" ] && continue
  case "$kind" in
    M*) old_path="$old"; new_path="$old" ;;
    R*) old_path="$old"; new_path="$new" ;;
    *) continue ;;
  esac
  # On main, "Proposed (accepted when this PR merges)" has merged: it is Accepted.
  if git show "$base:$old_path" 2>/dev/null | grep -qE 'Status:\*\* (Accepted|Proposed \(accepted when this PR merges\))'; then
    if ! git show "$base:$old_path" | cmp -s - "$new_path"; then
      echo "check-adr-immutable: $new_path is Accepted on main and its content changed; supersede it instead" >&2
      status=1
    fi
  fi
done < <(git diff -M --name-status "$base" -- 'docs/decisions-adr/' 'decisions-adr/' '*.md' 2>/dev/null | grep -E 'decisions-adr/')
exit $status
