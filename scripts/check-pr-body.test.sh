#!/usr/bin/env bash
# Feeds scripts/check-pr-body.sh the same JSON shape the PreToolUse hook
# receives, for representative gh invocations, and asserts which ones the
# hook denies. The body rules themselves are covered by
# scripts/check-pr-body.test.ts; what is tested here is the end to end path:
# which commands the hook self-filters on, where it reads the body from, and
# that a refusal comes back as the deny decision the harness understands.
# A stub gh on PATH stands in for the real PR when the command is
# `gh pr ready`, so no test touches the network.
# Run from anywhere; resolves the repo root itself.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hook="$repo_root/scripts/check-pr-body.sh"

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

cat > "$work_dir/gh" <<'STUB'
#!/usr/bin/env bash
# Answers `gh pr view ... --json body --jq .body` with whatever the test put
# in GH_BODY_FILE, and fails like gh does when there is no such PR.
if [ ! -f "${GH_BODY_FILE:-}" ]; then
  echo "no pull requests found" >&2
  exit 1
fi
cat "$GH_BODY_FILE"
STUB
chmod +x "$work_dir/gh"
export PATH="$work_dir:$PATH"
export GH_BODY_FILE=""

fail=0

# The four header lines every body needs, so a case that is about the
# Verified section fails for that reason and no other.
headers="Summary: a real summary
Friction: none
Agent: claude-local
ADRs affected: none"

# A whole PR body with the given text under "## Verified".
make_body() {
  printf '%s\n\n## What\n\nProse.\n\n## Verified\n\n%s\n\nCloses #1\n' "$headers" "$1"
}

real_body=$(make_body "Ran the shell test from the main checkout and from the worktree.")
pending_body=$(make_body "pending")
empty_body=$(printf '%s\n\n## What\n\nProse.\n\n## Verified\n\nCloses #1\n' "$headers")

# Feeds one command string to the hook and asserts whether it came back with
# a deny decision. expect is "deny" or "allow".
run_case() {
  local desc="$1" cmd="$2" expect="$3"
  local out
  out=$(jq -cn --arg cmd "$cmd" '{tool_input:{command:$cmd}}' | (cd "$repo_root" && "$hook") 2>/dev/null)
  if printf '%s' "$out" | grep -qF '"permissionDecision":"deny"'; then
    if [ "$expect" = "deny" ]; then
      echo "PASS: $desc (denied)"
    else
      echo "FAIL: $desc (expected to pass, was denied: $out)"
      fail=1
    fi
  else
    if [ "$expect" = "allow" ]; then
      echo "PASS: $desc (allowed)"
    else
      echo "FAIL: $desc (expected a deny, got: ${out:-<nothing>})"
      fail=1
    fi
  fi
}

# --- gh pr create, body in a file ---

printf '%s\n' "$real_body" > "$work_dir/real.md"
printf '%s\n' "$pending_body" > "$work_dir/pending.md"
printf '%s\n' "$empty_body" > "$work_dir/empty.md"

run_case "create with a real Verified section" \
  "gh pr create --draft --base main --title x --body-file $work_dir/real.md" allow
run_case "create with an empty Verified section" \
  "gh pr create --draft --base main --title x --body-file $work_dir/empty.md" deny
run_case "create with a pending Verified section" \
  "gh pr create --draft --base main --title x --body-file $work_dir/pending.md" deny
run_case "create with a -F body file" \
  "gh pr create --draft -F $work_dir/pending.md" deny
run_case "create whose body file does not exist" \
  "gh pr create --draft --body-file $work_dir/no-such-file.md" deny
run_case "create with template header placeholders still in the body" \
  "gh pr create --body \"Summary: <one line: what changed and why>

## Verified

Ran the shell test.\"" deny

# --- gh pr edit, body on the command line ---

run_case "edit with a pending Verified section" \
  "gh pr edit 12 --body \"$pending_body\"" deny
run_case "edit with a real Verified section" \
  "gh pr edit 12 --body \"$real_body\"" allow
run_case "edit that carries no body is not the hook's business" \
  "gh pr edit 12 --add-label in-review" allow

# The body is a quoted argument, so a flag name written inside it is prose,
# not a flag: the extraction must take the first --body/-b argument, not the
# last thing on the line that looks like one.
flag_prose_body="Summary: cover --body and -b flags in gh pr edit/ready checks
Friction: none
Agent: claude-local
ADRs affected: none

## Verified

Ran the shell test.

Closes #1"
run_case "create whose Summary line names the --body and -b flags" \
  "gh pr create --body \"$flag_prose_body\"" allow
run_case "edit whose Summary line names the --body and -b flags" \
  "gh pr edit 12 --body \"$flag_prose_body\"" allow
run_case "a quoted argument before the body does not hide it" \
  "gh pr create --title \"a title\" --body \"$real_body\"" allow
run_case "a quoted argument before a placeholder body does not hide it either" \
  "gh pr create --title \"a title\" --body \"$pending_body\"" deny
run_case "--body= takes the body from the same argument" \
  "gh pr edit 12 --body=\"$pending_body\"" deny
run_case "a title that merely mentions --body is not a body" \
  "gh pr edit 12 --title \"cover the --body flag\"" allow

# --- gh pr ready, body read back from the PR ---

export GH_BODY_FILE="$work_dir/pending.md"
run_case "ready on a PR whose Verified section is a placeholder" "gh pr ready 12" deny
run_case "ready with no number, on a placeholder body" "gh pr ready" deny

export GH_BODY_FILE="$work_dir/real.md"
run_case "ready on a PR with a real Verified section" "gh pr ready 12" allow

export GH_BODY_FILE="$work_dir/no-such-file.md"
run_case "ready when gh cannot answer lets the command through" "gh pr ready 12" allow
export GH_BODY_FILE="$work_dir/pending.md"

# --- what must not fire ---

run_case "a longer subcommand is not a match" "gh pr readyx" allow
run_case "an echo of the phrase is not a command start" 'echo "gh pr ready"' allow
run_case "an unrelated gh command is not a match" "gh pr list --label ready" allow
run_case "a chained ready still fires" "git push && gh pr ready 12" deny

exit $fail
