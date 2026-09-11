# ADR-0020 — Railway apply keeps its paths filter; release adds a drift-checking plan

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-11
- **Owner:** Samuel Chan
- **Amends:** ADR-0019 (Decision: `release.yml`'s job graph, and `railway-apply.yml`'s trigger)

## Context

The first release (push of `adfe1de` to `release` on 2026-09-11 03:43 UTC) ran
`release.yml` green while both Railway services kept serving the
2026-09-10 build. Cause: `railway-apply.yml`'s `on.push.paths:
[".railway/**"]` filter is evaluated against the branch's previous commit,
so a branch-creation push (which has none) never fires it (issue #212). A
design considered and rejected: dropping the paths filter so apply fires
on every release push — reverted after review flagged it as silently
contradicting ADR-0019's Decision text ("triggers on push: branches:
[release] with the same .railway/** path filter") with no superseding
ADR, and after the owner asked why apply should run on every push when
the apply is normally a no-op. Kept instead: the filter stays (apply is
rare, and firing it needlessly on every push has no upside once a manual
trigger exists), and a separate, read-only check catches ordinary drift.

## Decision

- `railway-apply.yml` keeps its `.railway/**` paths filter unchanged, and
  gains `workflow_dispatch:` so the owner can re-run it by hand — this
  covers exactly the branch-creation-push gap that caused the miss,
  without changing when the workflow fires on an ordinary push.
- `release.yml` gains a `plan` job between `gate` and `smoke`: `needs:
  gate`, runs `railwayapp/config@v1` with `command: plan` against the
  released commit, and fails if the resulting plan
  (`railway-plan.json`'s `changeSet.changes`) is non-empty. It applies
  nothing. `command: plan` does not itself fail on a non-empty diff (it
  is designed to preview a PR's change, not gate one), so an explicit
  step reads the plan output and fails the job. `smoke`'s `needs` moves
  from `gate` to `plan` (transitively still requires `gate`).

## Consequences

- The release gate is now `gate` -> `plan` -> `smoke`: a release fails
  loud if the live Railway environment has drifted from
  `.railway/railway.ts`, instead of silently applying nothing and
  deploying against a stale config.
- The owner (or a future automated trigger) re-runs `railway-apply.yml`
  by hand via `workflow_dispatch` when `plan` goes red, or when
  `.railway/**` changes outside the paths-filtered push path.
- Build identity and the smoke job's liveness-only checks are addressed
  separately (issue #212's second slice, PR #215, its own amending ADR).

ADRs affected: 0019 (Decision: job graph, apply trigger).
