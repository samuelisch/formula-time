# ADR-0028 — Manual Railway apply uses the CLI directly, not railwayapp/config

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-13
- **Owner:** Samuel Chan
- **Amends:** ADR-0020 (Decision: `railway-apply.yml` gains `workflow_dispatch:` so
  the owner can re-run it by hand)

## Context

ADR-0020 added `workflow_dispatch:` to `railway-apply.yml` on the assumption
that the owner could re-run the same `railwayapp/config@v1`, `command: apply`
mechanism already used on the push trigger. Measured 2026-09-13 10:13 UTC: the
owner dispatched it that way and it failed inside the action with "apply
needs a merged pull_request event, or a push of a commit that belongs to a
merged PR." The action's `apply` command only ever downloads the plan
artifact pinned by a merged PR — read from the `pull_request` event, or, on a
push, resolved from the pushed commit's merged-PR history — and applies
exactly that artifact. A `workflow_dispatch` supplies neither a PR nor an
artifact, so this path can never work as ADR-0020 described it (issue #255).

## Decision

- `railway-apply.yml`'s push trigger keeps `railwayapp/config@v1`,
  `command: apply`, unchanged; the job is renamed `apply-pinned` and gated
  `if: github.event_name == 'push'`.
- A new job, `apply-manual`, runs only on `workflow_dispatch`, gated on a
  required string input `confirm` that must equal `apply` — so a misclick on
  "Run workflow" cannot apply anything. It installs `@railway/cli` directly
  (an exact pinned version, `5.54.0` at the time this was written) instead of
  going through `railwayapp/config@v1`, checks out the dispatched ref, then
  runs `railway config plan --verbose` and `railway config apply --yes
  --verbose` against it, both scoped by the same `RAILWAY_TOKEN` repository
  secret the pinned job already uses.
- `apply-manual` never passes `--confirm-destructive`. `apply-pinned` still
  gets it by default (the action's `confirm-destructive` input defaults to
  `"true"`), because a destructive change there was already shown as a PR
  plan comment before merge — merging is the approval. A manual dispatch has
  no such review step, so a plan reporting any destroy fails the job before
  `apply` runs, with an explicit message naming the destroy count, ahead of
  the CLI's own refusal.

## Consequences

- The manual path is a materially different mechanism from the pinned one: a
  fresh CLI install and a fresh `railway config plan` on every run, never a
  pinned plan artifact. Exercising a pinned artifact from `workflow_dispatch`
  is not possible — there is no PR and no `plan` job to have produced one —
  so re-planning live against the dispatched ref is the only alternative.
- A destructive manual apply is never authorized by this job. If one is
  genuinely intended, the owner runs `railway config apply --confirm-destructive`
  by hand, outside CI.
- ADR-0020's text describing the `workflow_dispatch` trigger as "so the owner
  can re-run it by hand" is superseded by this ADR's mechanism, not amended in
  place; ADR-0020's own decision (the paths-filtered push trigger, and
  `release.yml`'s `plan` job) is otherwise unchanged.

ADRs affected: 0020 (Decision: what `workflow_dispatch` actually does).
