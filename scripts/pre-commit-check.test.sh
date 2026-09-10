#!/usr/bin/env bash
# Feeds scripts/pre-commit-check.sh the same JSON shape the PreToolUse hook
# receives, for representative git commit invocations, and asserts which ones
# trigger the gate (typecheck + unit tests + ADR check) and which do not.
# Uses a stub pnpm on PATH so the gate never really runs typecheck: the stub
# records that it was called, and from which directory, to a marker file.
# Run from anywhere; resolves the repo root itself.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hook="$repo_root/scripts/pre-commit-check.sh"

stub_dir=$(mktemp -d)
trap 'rm -rf "$stub_dir"' EXIT

cat > "$stub_dir/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "$(pwd)" >> "$MARKER_FILE"
exit 0
STUB
chmod +x "$stub_dir/pnpm"

export MARKER_FILE="$stub_dir/pnpm-called"
export PATH="$stub_dir:$PATH"

fail=0

# Feeds one command string to the hook and asserts whether it fired the gate
# (the stub pnpm was invoked). expect is "fire" or "nofire".
run_case() {
  local desc="$1" cmd="$2" expect="$3"
  rm -f "$MARKER_FILE"
  jq -cn --arg cmd "$cmd" '{tool_input:{command:$cmd}}' | (cd "$repo_root" && "$hook") >/dev/null 2>&1
  if [ "$expect" = "fire" ]; then
    if [ -f "$MARKER_FILE" ]; then
      echo "PASS: $desc (fired the gate)"
    else
      echo "FAIL: $desc (expected the gate to fire, it did not)"
      fail=1
    fi
  else
    if [ -f "$MARKER_FILE" ]; then
      echo "FAIL: $desc (expected the gate not to fire, it did)"
      fail=1
    else
      echo "PASS: $desc (did not fire)"
    fi
  fi
}

run_case "plain git commit" 'git commit -m x' fire
run_case "git -c option form" 'git -c x=y commit -m x' fire
run_case "git -C dir form" 'git -C /some/dir commit -m x' fire
run_case "git --no-pager form" 'git --no-pager commit -m x' fire
run_case "git commitlog is not a match" 'git commitlog' nofire
run_case "echo of git commit is not a command start" 'echo "git commit"' nofire
run_case "git commit chained after another command" 'pnpm test && git commit -m x' fire

exit $fail
