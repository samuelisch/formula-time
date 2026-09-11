#!/usr/bin/env bash
# Runs scripts/db-env.sh against fabricated git repos and asserts: a
# main-checkout-shaped toplevel (no "/.claude/worktrees/" in its path)
# always gets DB_PORT=5433, API_PORT=3000, WEB_PORT=5173; a worktree-shaped
# toplevel gets three different ports, each inside its own range, stable
# across repeated runs; and a broken hash command (empty or non-numeric
# output) falls back to the plain-checkout defaults instead of an empty
# PORT, even from a worktree-shaped toplevel.
# Uses fabricated repos under mktemp, the same way pre-commit-check.test.sh
# does, so the result never depends on which real tree happens to be
# running the test.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/db-env.sh"

fail=0

main_repo=$(mktemp -d)
worktree_base=$(mktemp -d)
worktree_repo="$worktree_base/formula-time/.claude/worktrees/fake-agent"
mkdir -p "$worktree_repo"
trap 'rm -rf "$main_repo" "$worktree_base"' EXIT

git init -q "$main_repo"
git init -q "$worktree_repo"

# Runs db-env.sh from $1 with none of its own output variables pre-set, and
# echoes the DB_PORT/API_PORT/WEB_PORT lines as one space-joined string.
run_ports() {
  local dir="$1"
  (
    cd "$dir" || exit 1
    unset DB_PORT API_PORT WEB_PORT COMPOSE_PROJECT_NAME
    "$script"
  ) | awk -F= '/^DB_PORT=/{db=$2} /^API_PORT=/{api=$2} /^WEB_PORT=/{web=$2} END{print db, api, web}'
}

# --- main checkout: exact defaults, stable across two runs ---

for i in 1 2; do
  ports="$(run_ports "$main_repo")"
  if [ "$ports" = "5433 3000 5173" ]; then
    echo "PASS: main checkout run $i gets 5433 3000 5173"
  else
    echo "FAIL: main checkout run $i got '$ports', expected '5433 3000 5173'"
    fail=1
  fi
done

# --- a worktree: three different ports, each inside its range, stable ---

first_worktree_ports=""
for i in 1 2; do
  ports="$(run_ports "$worktree_repo")"
  read -r db api web <<<"$ports"

  ok=1
  [ "$db" -ge 5440 ] && [ "$db" -le 5489 ] || ok=0
  [ "$api" -ge 3000 ] && [ "$api" -le 3199 ] || ok=0
  [ "$web" -ge 5173 ] && [ "$web" -le 5372 ] || ok=0
  [ "$db" != "$api" ] && [ "$db" != "$web" ] && [ "$api" != "$web" ] || ok=0

  if [ "$ok" = 1 ]; then
    echo "PASS: worktree run $i gets three distinct in-range ports ($ports)"
  else
    echo "FAIL: worktree run $i got '$ports', expected three distinct in-range ports"
    fail=1
  fi

  if [ "$i" = 1 ]; then
    first_worktree_ports="$ports"
  elif [ "$ports" != "$first_worktree_ports" ]; then
    echo "FAIL: worktree ports are not stable across runs ('$first_worktree_ports' then '$ports')"
    fail=1
  else
    echo "PASS: worktree ports are stable across runs"
  fi
done

# --- failure path: a broken hash command falls back to the plain
# defaults, never to an empty PORT, even from a worktree-shaped toplevel ---

stub_dir=$(mktemp -d)
trap 'rm -rf "$main_repo" "$worktree_base" "$stub_dir"' EXIT

broken_hash_case() {
  local desc="$1" stub_body="$2"
  cat >"$stub_dir/sha256sum" <<STUB
#!/usr/bin/env bash
$stub_body
STUB
  cp "$stub_dir/sha256sum" "$stub_dir/shasum"
  cp "$stub_dir/sha256sum" "$stub_dir/openssl"
  chmod +x "$stub_dir/sha256sum" "$stub_dir/shasum" "$stub_dir/openssl"

  local raw ports
  raw="$(
    cd "$worktree_repo" || exit 1
    unset DB_PORT API_PORT WEB_PORT COMPOSE_PROJECT_NAME
    PATH="$stub_dir:$PATH" "$script"
  )"
  ports="$(printf '%s\n' "$raw" | awk -F= '/^DB_PORT=/{db=$2} /^API_PORT=/{api=$2} /^WEB_PORT=/{web=$2} END{print db, api, web}')"

  if [ "$ports" = "5433 3000 5173" ]; then
    echo "PASS: $desc falls back to 5433 3000 5173"
  else
    echo "FAIL: $desc got '$ports', expected '5433 3000 5173' (never empty)"
    fail=1
  fi
}

broken_hash_case "an empty hash" 'exit 0'
broken_hash_case "a non-numeric hash" 'echo "not-a-hex-digest"'

# --- consuming db-env.sh's output: its lines carry no `export`, so a plain
# `eval "$(scripts/db-env.sh)"` only sets shell-local variables a spawned
# child process never sees (apps/web/package.json's test:e2e hit exactly
# this, since Playwright reads WEB_PORT/API_PORT from its own process env).
# `export $(scripts/db-env.sh)` is the correct idiom -- word-splits the
# output into `export`'s own arguments, so it lands in the environment a
# child inherits. Proves the idiom, not just the script's own stdout. ---

child_ports="$(
  cd "$worktree_repo" || exit 1
  unset DB_PORT API_PORT WEB_PORT COMPOSE_PROJECT_NAME
  export $("$script")
  sh -c 'printf "%s %s %s\n" "$DB_PORT" "$API_PORT" "$WEB_PORT"'
)"

if [ "$child_ports" = "$first_worktree_ports" ]; then
  echo "PASS: a child process spawned after 'export \$(db-env.sh)' sees this worktree's own ports"
else
  echo "FAIL: child process saw '$child_ports', expected '$first_worktree_ports' (test:e2e's env-export path)"
  fail=1
fi

exit $fail
