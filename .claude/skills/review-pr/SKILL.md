---
name: review-pr
description: Review a pull request end to end and post a verdict. Approves only a clean pass (no security concern, no bug, no code that must change, no decision left to the owner). Use from the Claude Code Review workflow, or locally with a PR number to see the verdict without posting it.
---

# Review a PR and give a verdict

Usage: `/review-pr <pr-number> [--post] [--seam] [--security]`

## Overview

Three reviews, one verdict. The verdict is posted as a GitHub review only when `--post` is given. The Claude Code Review workflow passes it, so the review comes from `claude[bot]`. Never pass `--post` locally: a local `gh` posts as the owner, and the owner's approval must be their own. Do not try to detect CI from the environment; the flag is the only switch.

`--seam` and `--security` select the design and security passes. The workflow derives them from the changed paths (seam: `apps/`, `packages/`, `db/`, `docs/decisions-adr/`; security: `apps/`, `db/`, `.github/`). Locally, pass them by the same rule. Without a flag the pass is skipped and the verdict says so.

Merging is never done here. The owner merges.

## Steps

1. **Context.** `gh pr view <n> --json title,body,labels,baseRefName,headRefName,files,statusCheckRollup`. Read the body's Summary / Friction / Agent / ADRs affected lines and the linked issue (`gh issue view`). Read every changed file in full, not just hunks.
2. **Correctness.** One agent, one pass. Invoke the Agent tool once, `model: sonnet`, with this brief filled in (PR number, base branch, the issue's acceptance criteria pasted verbatim): "Read `gh pr diff <n>` and every changed file in full. Report only (a) bugs: wrong behaviour, an acceptance criterion the diff does not meet, unhandled input, a wrong error path; (b) code that must change: a rule in AGENTS.md broken, a half-finished change, a test the criteria call for that is missing. One line per finding with file:line. No style, no refactors, no running tests. If nothing, one line saying so." With `--post`, put each finding on the PR as an inline comment (`mcp__github_inline_comment__create_inline_comment`).
3. **Design.** With `--seam`, run the `seam-reviewer` agent (`.claude/agents/seam-reviewer.md`) on the PR. Without it, record "seam review not requested: no apps/, packages/, db/, or ADR files changed".
4. **Security.** With `--security`, invoke the `security-review` skill. Without it, record "security review not requested: no apps/, db/, or .github/ files changed".
5. **Classify** every finding from steps 2–4 into exactly one bucket:
   - **Security**: any finding from step 4, or secrets, injection, unauthenticated writes, credentials outside the platform secret store.
   - **Bug**: wrong behaviour, a failing or pending required status check, an acceptance criterion from the issue that the diff does not meet.
   - **Must change**: anything a careful reviewer would block on: an invariant or seam-contract violation, a half-finished rename, a test the issue's acceptance criteria call for that is missing, a "Verified" claim the diff contradicts.
   - **Decision**: contradicts or amends an accepted ADR without a superseding ADR in the same PR; the "ADRs affected" line disagrees with the diff; touches a design-bearing track (Postgres fetcher, projector cursor, vote acknowledgement); the linked issue carries the `owner` label; changes files the issue body did not list.

   Style and nits go under Notes and never move the verdict.
6. **Verdict.** Compose the body in the format below. Without `--post`, print it and stop; say that nothing was posted. With `--post`, submit it inline, one command, no temporary file:
   - all four buckets empty → `gh pr review <n> --approve --body "$(cat <<'EOF'
…
EOF
)"`
   - any Security, Bug, or Must change → the same with `--request-changes`
   - only Decision items → the same with `--comment`
7. If `gh pr review` fails (the token cannot submit reviews), post the same body with `gh pr comment <n> --body "…"` and say in it that the verdict could not be recorded as a review. Never end a `--post` run without one of the two having succeeded.

## Verdict format

```
## Verdict: pass | changes requested | owner decision needed

Security: none | - item, file:line
Bugs: none | - item, file:line
Must change: none | - item, file:line
Decisions: none | - item and which ADR, rule, or issue line it rests on
Notes: - non-blocking items, or none

Reviewed: correctness pass (Sonnet); seam-reviewer (ran | not requested: why); security-review (ran | not requested: why)
Merge is the owner's call.
```

## Common mistakes

- Approving because the diff is small. Every PR gets step 2; a skipped step 3 or 4 needs its reason written down.
- Filing a Decision as changes requested. The code may be right; the call is the owner's, and the review must not block it.
- Approving on a red or pending required check. That is a Bug until it is green.
- Treating the PR's Verified section as proof. It is a claim. If CI runs the command, CI is the proof; if nothing runs it and the claim matters, say so under Notes.
- Running the test suite from this skill. CI proves tests; this skill proves the review.
- Ending a `--post` run with the verdict only in the transcript. Nobody reads the transcript; the review on the PR is the output.
- Ending the turn while review agents are still running. In the workflow there is no next turn: the job ends and nothing is posted. Wait for every agent (the workflow runs them in the foreground); if any is still running, block on it before writing the verdict.
