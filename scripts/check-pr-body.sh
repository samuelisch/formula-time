#!/usr/bin/env bash
# PreToolUse hook (matcher Bash). Self-filters: acts only when the command
# runs `gh pr create`, `gh pr edit` or `gh pr ready`. It finds the PR body
# those commands are about and hands it to scripts/check-pr-body.mjs, which
# holds every rule about what a body must say; a refusal comes back here as
# the deny decision.
#
# `gh pr ready` is covered as well as the two writing commands because a
# placeholder is almost always written at create time and left there, and
# marking a PR ready is what starts a review round on it.
#
# This script keeps only the two things bash is still the right tool for:
# matching the command string, and calling gh. Everything that has to read
# the body is in the Node script, which is unit tested directly.
set -u
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmd=$(jq -r '.tool_input.command // empty')

# Command recognition, byte-exact and quote-unaware by design: the phrase
# must start a command (line start, or after ; & | with optional blanks) and
# the subcommand must be a whole word, so `gh pr readyx` and
# `echo "gh pr ready"` do not fire.
#
# Out of scope, deliberately, because each would cost more parser than the
# rule is worth: a `gh` alias, wrapper function or absolute path; an
# env-prefixed form (`env GH_TOKEN=x gh pr create`); a quoted decoy that
# happens to sit after a separator; and a second `gh pr` command in the same
# line — only the first one found is checked. The flags below are likewise
# searched across the whole command string, not only within the matched
# invocation.
match=$(printf '%s\n' "$cmd" \
  | grep -oE '(^|[;&|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+(create|edit|ready)([[:space:]]|$)' \
  | head -1)
[ -n "$match" ] || exit 0
case "$match" in
  *create*) mode=create ;;
  *edit*) mode=edit ;;
  *) mode=ready ;;
esac

deny() {
  jq -cn --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

if [ "$mode" = "ready" ]; then
  # Nothing on the command line carries the body, so read it off the PR. The
  # number is the first all-digit argument after "ready"; with none, gh
  # resolves the PR for the current branch in the hook's own cwd.
  num=$(printf '%s\n' "$cmd" \
    | sed -nE 's/.*gh[[:space:]]+pr[[:space:]]+ready[[:space:]]*//p' \
    | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) { print $i; exit }}')
  # A gh that cannot answer — no PR for this branch, no network, not logged
  # in — is not evidence of a bad body, and blocking every `gh pr ready` on
  # it would be worse than missing a placeholder. Let the command through.
  body=$(gh pr view ${num:+"$num"} --json body --jq .body 2>/dev/null) || exit 0
else
  # --body-file/-F wins over --body/-b, as it does in gh itself. The path is
  # taken unquoted up to the next blank, so a path with a space in it is out
  # of scope here too.
  file=$(printf '%s' "$cmd" | sed -nE 's/.*(--body-file|-F)[= ]+"?([^" ]+)"?.*/\2/p' | head -1)
  if [ -n "$file" ]; then
    # Fail closed: a body file the hook cannot read is a body nobody checked.
    [ -f "$file" ] || deny "PR body: cannot read the --body-file '$file'"
    body=$(cat "$file")
  elif printf '%s\n' "$cmd" | grep -qE '(--body|-b)[= ]'; then
    # An inline body is a quoted argument, so the body starts on the command
    # line itself: drop everything up to and including the flag and its
    # opening quote, and the closing quote at the very end. Any argument
    # written after the body is left in the text, which costs nothing — the
    # rules only look for lines the body must have.
    body=$(printf '%s' "$cmd" | sed -E '1s/^.*(--body|-b)[= ]+("|'"'"')?//')
    body=${body%\"}
    body=${body%\'}
  elif [ "$mode" = "edit" ]; then
    # An edit that changes labels or a title says nothing about the body.
    exit 0
  else
    # `gh pr create` with no body flag: check the command itself, so the
    # missing header lines are reported rather than silently passed.
    body="$cmd"
  fi
fi

# Exit 1 from the Node script is the one refusal; anything else (a missing
# node, a bad mode) is a broken hook rather than a bad body, and must not
# block the command.
reason=$(printf '%s\n' "$body" | node "$script_dir/check-pr-body.mjs" --mode "$mode")
[ $? -eq 1 ] || exit 0
deny "$reason"
