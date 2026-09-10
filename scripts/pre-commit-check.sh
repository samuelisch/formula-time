#!/usr/bin/env bash
# PreToolUse hook (matcher Bash). Acts only when the command runs `git commit`.
# Gate: an install check, then typecheck, unit tests, and no edits to
# Accepted ADRs. Non-zero exit blocks the commit.
set -u
cmd=$(jq -r '.tool_input.command // empty')

strip_quotes() {
  local p="$1"
  case "$p" in
    \"*\") p="${p#\"}"; p="${p%\"}" ;;
    \'*\') p="${p#\'}"; p="${p%\'}" ;;
  esac
  printf '%s' "$p"
}

# Quoted text is an argument, not shell syntax: neither `echo '; git commit'`
# nor `echo 'x && cd /decoy && y'` runs anything. Replacing the blanks inside
# quotes with \001 leaves a quoted stretch unable to look like a command —
# every form the patterns below recognise needs a real blank inside it —
# while a genuinely quoted path (`cd "/my dir" &&`) still matches and is
# restored by unmask_blanks once extracted. One byte in, one byte out, so an
# offset into the masked command is also an offset into the original. An
# unbalanced quote masks the rest of the line, which costs nothing: such a
# command is a shell syntax error and never reaches a commit.
mask_quoted_blanks() {
  awk '{
    q = ""; out = ""
    for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (q == "") { if (c == "\"" || c == "\047") q = c }
      else if (c == q) { q = "" }
      else if (c == " " || c == "\t") { c = "\001" }
      out = out c
    }
    print out
  }'
}

unmask_blanks() {
  printf '%s' "$1" | tr '\001' ' '
}

masked=$(printf '%s' "$cmd" | mask_quoted_blanks)
# Anchored: the phrase must start a command (line start or after ; & |), not
# merely appear in a message. Options between "git" and "commit" (-c x=y,
# -C dir, --no-pager, ...) are skipped so an option-prefixed form still
# matches; "commit" must be a whole word so "git commitlog" does not.
self_filter='(^|[;&|])[[:space:]]*git([[:space:]]+-[^[:space:]]+([[:space:]]+[^[:space:]]+)?)*[[:space:]]+commit([[:space:]]|$)'
match_line=$(printf '%s\n' "$masked" | grep -obE "$self_filter" | head -1)
[ -n "$match_line" ] || exit 0
match_offset=${match_line%%:*}
cmd_match=${match_line#*:}

# The tree the commit actually lands in is not always the hook's own cwd: an
# agent's Bash command can `cd` into another checkout, or pass `git -C`,
# before running `git commit` in the same command. Pick, in order: the last
# `cd <path> &&`/`cd <path>;` before the matched commit invocation; else a
# `git -C <path>` inside that same invocation; else the hook's own cwd, as
# before. "Before" is scoped to the text preceding the matched invocation
# itself, not just anywhere in the command, so a `cd` that runs after the
# commit (e.g. `git commit -m x && cd /other && echo done`) is ignored, and
# an unrelated "git commit"-looking substring earlier in the command (e.g.
# inside a quoted echo argument) cannot be mistaken for it either: the cut
# point comes from grep's own byte offset for the anchored match, not a
# second, textual search for the matched string, and that match was taken
# from the masked text so quoted text cannot supply it.
#
# That offset is a count of bytes, so the cut point is measured and applied
# in bytes throughout — `wc -c` for the length of the match's leading
# separator, `head -c` for the slice. Bash's ${#var} and ${var:0:n} count
# characters in a UTF-8 locale, so mixing them in would move the cut point
# one place right per multibyte character earlier in the command.
hook_cwd="$(pwd)"
git_part=$(printf '%s' "$cmd_match" | sed -E 's/^[;&|]?[[:space:]]*//')
anchor=${cmd_match%"$git_part"}
anchor_bytes=$(printf '%s' "$anchor" | wc -c | tr -d '[:space:]')
cut_bytes=$(( match_offset + anchor_bytes ))
prefix=""
# head -c 0 is an error on BSD, and a commit that starts the command has
# nothing in front of it to search anyway.
if [ "$cut_bytes" -gt 0 ]; then
  prefix=$(printf '%s' "$masked" | head -c "$cut_bytes")
fi
raw_path=$(printf '%s\n' "$prefix" | sed -nE "s/.*(^|[;&|])[[:space:]]*cd[[:space:]]+(\"[^\"]*\"|'[^']*'|[^[:space:]]+)[[:space:]]*(&&|;).*/\\2/p")
if [ -z "$raw_path" ]; then
  raw_path=$(printf '%s\n' "$cmd_match" | sed -nE "s/.*git[[:space:]]+-C[[:space:]]+(\"[^\"]*\"|'[^']*'|[^[:space:]]+)[[:space:]]+commit.*/\\1/p")
fi

tree=""
if [ -n "$raw_path" ]; then
  path=$(unmask_blanks "$(strip_quotes "$raw_path")")
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
