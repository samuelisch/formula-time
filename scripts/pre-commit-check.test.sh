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

# --- tree resolution: which tree does the gate actually run against? ---
# Real git repos under mktemp -d, independent of the real main checkout or
# any real worktree, each with its own pnpm-lock.yaml and (except the
# no-install one) a node_modules/.pnpm directory and a stub
# scripts/check-adr-immutable.sh so the full gate chain runs to completion.

make_repo() {
  local dir="$1" with_install="$2"
  git init -q "$dir"
  : > "$dir/pnpm-lock.yaml"
  mkdir -p "$dir/scripts"
  cat > "$dir/scripts/check-adr-immutable.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$dir/scripts/check-adr-immutable.sh"
  if [ "$with_install" = "yes" ]; then
    mkdir -p "$dir/node_modules/.pnpm"
  fi
}

main_repo=$(mktemp -d)
worktree_repo=$(mktemp -d)
no_install_repo=$(mktemp -d)
stale_lock_repo=$(mktemp -d)
space_repo="$(mktemp -d)/repo with space"
mkdir -p "$space_repo"
accent_repo="$(mktemp -d)/café"
mkdir -p "$accent_repo"
trap 'rm -rf "$main_repo" "$worktree_repo" "$no_install_repo" "$stale_lock_repo" "$(dirname "$space_repo")" "$(dirname "$accent_repo")"' EXIT

make_repo "$main_repo" yes
make_repo "$worktree_repo" yes
make_repo "$no_install_repo" no
make_repo "$stale_lock_repo" yes
# node_modules/.pnpm was created before the lockfile is touched again, so
# the lockfile now reads as newer than the install. The sleep guarantees a
# distinct mtime second between the two, since -nt compares whole seconds.
sleep 1
touch "$stale_lock_repo/pnpm-lock.yaml"
make_repo "$space_repo" yes
make_repo "$accent_repo" yes

main_top=$(git -C "$main_repo" rev-parse --show-toplevel)
worktree_top=$(git -C "$worktree_repo" rev-parse --show-toplevel)
no_install_top=$(git -C "$no_install_repo" rev-parse --show-toplevel)
stale_lock_top=$(git -C "$stale_lock_repo" rev-parse --show-toplevel)
space_top=$(git -C "$space_repo" rev-parse --show-toplevel)
accent_top=$(git -C "$accent_repo" rev-parse --show-toplevel)

# Feeds one command to the hook with the hook's own cwd set to hook_cwd, and
# asserts which tree the gate ran pnpm in (or, if expect_install_msg is
# "yes", that it printed the install message and never called pnpm).
run_tree_case() {
  local desc="$1" hook_cwd="$2" cmd="$3" expect_tree="$4" expect_install_msg="$5"
  rm -f "$MARKER_FILE"
  local out
  out=$(jq -cn --arg cmd "$cmd" '{tool_input:{command:$cmd}}' | (cd "$hook_cwd" && "$hook") 2>&1)
  if [ "$expect_install_msg" = "yes" ]; then
    if printf '%s' "$out" | grep -qF "run pnpm install in $expect_tree" && [ ! -f "$MARKER_FILE" ]; then
      echo "PASS: $desc (printed install message for $expect_tree, did not call pnpm)"
    else
      echo "FAIL: $desc (expected install message for $expect_tree, got: $out)"
      fail=1
    fi
    return
  fi
  if [ ! -f "$MARKER_FILE" ]; then
    echo "FAIL: $desc (expected the gate to run pnpm, it did not; output: $out)"
    fail=1
    return
  fi
  if grep -qxF "$expect_tree" "$MARKER_FILE"; then
    echo "PASS: $desc (gated $expect_tree)"
  else
    echo "FAIL: $desc (expected tree $expect_tree, pnpm ran in: $(cat "$MARKER_FILE" | tr '\n' ' '))"
    fail=1
  fi
}

run_tree_case "plain commit gates the hook's own cwd tree" \
  "$main_repo" 'git commit -m x' "$main_top" no
run_tree_case "cd into a worktree before commit gates the worktree" \
  "$main_repo" "cd $worktree_repo && git commit -m x" "$worktree_top" no
run_tree_case "git -C a worktree commit gates the worktree" \
  "$main_repo" "git -C $worktree_repo commit -m x" "$worktree_top" no
run_tree_case "cd into a tree with no install reports the install gap" \
  "$main_repo" "cd $no_install_repo && git commit -m x" "$no_install_top" yes
run_tree_case "a cd after the commit is not gated (only a cd before it counts)" \
  "$main_repo" "git commit -m x && cd $worktree_repo && echo done" "$main_top" no
run_tree_case "a decoy 'git commit' inside quotes does not fool the cut point" \
  "$main_repo" "echo 'run git commit yourself' && cd $worktree_repo && git commit -m x" "$worktree_top" no
run_tree_case "a quoted cd path with a space gates that tree" \
  "$main_repo" "cd \"$space_repo\" && git commit -m x" "$space_top" no
run_tree_case "a stale lockfile reports the install gap" \
  "$main_repo" "cd $stale_lock_repo && git commit -m x" "$stale_lock_top" yes

# --- non-ASCII commands: the cut point is a byte offset, so anything that
# measures or slices the command in characters drifts once a multibyte
# character appears before the matched invocation.

run_tree_case "multibyte text before a cd does not drift the cut point" \
  "$main_repo" "café /tmp && cd $worktree_repo && git commit -m x" "$worktree_top" no
run_tree_case "a multibyte commit message does not pull in a later cd" \
  "$main_repo" "git commit -m \"café\" && cd $worktree_repo && echo ok" "$main_top" no
run_tree_case "a cd into a path with a multibyte segment gates that tree" \
  "$main_repo" "cd $accent_repo && git commit -m x" "$accent_top" no

# Each two-byte character before the match adds one character of drift to a
# character-indexed cut, so padding as long as the rest of the command pushes
# a mis-sliced prefix past the whole invocation and onto the trailing cd.
trailing_cd_cmd="git commit -m x && cd $worktree_repo && echo done"
pad=""
pad_i=0
while [ "$pad_i" -lt "${#trailing_cd_cmd}" ]; do
  pad="${pad}é"
  pad_i=$((pad_i + 1))
done
run_tree_case "multibyte padding cannot push the cut point past the commit" \
  "$main_repo" "echo '$pad' && $trailing_cd_cmd" "$main_top" no

# Feeds one command to the hook and asserts both that a given substring
# appears in its output and which tree it fell back to gating.
run_message_case() {
  local desc="$1" hook_cwd="$2" cmd="$3" expect_tree="$4" expect_msg_substr="$5"
  rm -f "$MARKER_FILE"
  local out ok=1
  out=$(jq -cn --arg cmd "$cmd" '{tool_input:{command:$cmd}}' | (cd "$hook_cwd" && "$hook") 2>&1)
  printf '%s' "$out" | grep -qF "$expect_msg_substr" || ok=0
  [ -f "$MARKER_FILE" ] && grep -qxF "$expect_tree" "$MARKER_FILE" || ok=0
  if [ "$ok" = "1" ]; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc (output: $out; marker: $(cat "$MARKER_FILE" 2>/dev/null || echo none))"
    fail=1
  fi
}

run_message_case "an unresolvable plain path is named and falls back to cwd" \
  "$main_repo" "cd /this/path/does/not/exist && git commit -m x" "$main_top" \
  "cannot resolve '/this/path/does/not/exist' to a git tree"
run_message_case 'an unexpanded $VAR path is named and falls back to cwd' \
  "$main_repo" 'cd $SOME_VAR && git commit -m x' "$main_top" \
  "cannot resolve '\$SOME_VAR' (unexpanded variable)"

exit $fail
