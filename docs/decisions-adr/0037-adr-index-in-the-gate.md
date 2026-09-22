# ADR-0037 — The ADR index joins the gate: CI fails on a stale `docs/decisions-adr/README.md`

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-22
- **Owner:** Samuel Chan
- **Amends:** ADR-0006. The three tiers and what each is responsible for
  proving are unchanged; `checks` gains one more required step, matching
  the precedent an earlier amendment set for adding a required check to
  this same job (see Context).

## Context

A reader had to open all 36 files under `docs/decisions-adr/` to see every
decision's status and which ones amend which. `scripts/adr-index.mjs`
(this PR) generates `docs/decisions-adr/README.md`, a table of every
ADR's number, title, status, date, and amendment graph, parsed from each
file's front matter. A generated file drifts the moment an ADR is added or
edited without also being regenerated, and ADR-0006 lists nothing that
would catch that: `checks` runs typecheck, lint, unit, integration, build,
and the accepted-ADR immutability check, none of which reads
`docs/decisions-adr/README.md`. ADR-0017 already set the precedent for
adding one more required check to the same `checks` job (lint, there);
this is that same category of change, so it gets its own amending ADR
rather than landing silently inside a feature PR.

## Decision

- `.github/workflows/ci.yml`'s `checks` job gains a step named "ADR index
  is current", running `node scripts/adr-index.mjs --check`, placed right
  after "Accepted ADRs unchanged". It is required for merge, the same as
  every other step in that job.
- `node scripts/adr-index.mjs --check` exits 1 without writing when the
  generated content differs from `docs/decisions-adr/README.md`, printing
  `docs/decisions-adr/README.md is stale; run node scripts/adr-index.mjs`
  on stderr; it exits 0 otherwise.
- Root `AGENTS.md`'s ADR rule states the regeneration step: after adding or
  amending an ADR, run `node scripts/adr-index.mjs` (or `pnpm
  docs:adr-index`) before opening the PR, since CI now rejects a stale
  index.
- `scripts/check-adr-edit.sh`, the PreToolUse hook that denies edits to an
  Accepted ADR, excludes `docs/decisions-adr/README.md` by its literal
  filename: the generated file lives in the same directory the hook scans,
  but it is never itself an ADR's decision text, and it changes on every
  ADR-touching PR by design.

## Consequences

- Every PR that adds or amends an ADR must regenerate the index in the
  same commit, or CI blocks it — the same discipline `pnpm lint` already
  enforces for source files.
- The generator's own parsing limitations (documented alongside it, e.g.
  its first-paragraph heuristic can over-attribute an `Amends` mention
  that is really about a different ADR pair) are a property of the
  generator, not of this gate; a future PR that tightens the parser only
  ever changes generated output, never this decision.
- A file whose name does not match `docs/decisions-adr/NNNN-*.md` — the
  generated `README.md` included — is never itself indexed, so the table
  never lists itself.
