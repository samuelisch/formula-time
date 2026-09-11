# FormulaTime — the deployed app

Public, non-commercial live F1 timing app with race-reactive polls and
broadcast alignment, built from the validated POC at
`../f1-live-events-poc`. Owner is building backend/system-design depth:
surface decisions and trade-offs, don't decide silently (see their global
learning workflow). Repo was `f1-live-events` until 2026-09-07; same code.

## Where things stand

Do not look here for status; it goes stale. Sources of truth, in order:
`git log` and the tree (what exists), GitHub Issues (what is in flight and
what is next), `docs/decisions-adr/` (what is decided), `docs/PRD.md` §4–5 (product
decisions and open product questions). Anything decided in conversation but
not yet in an ADR is listed at the top of `docs/HLD.md` §7 as "ADR pending".

## Where context lives

Read `docs/` before doing anything. What each part holds:

- `docs/PRD.md` — what and why: problem, goals, not-now list, product
  decisions, open product questions. Mirrors the owner's Notion.
- `docs/decisions-adr/` — binding decisions, numbered and dated. ADR-0001: shape,
  the five invariants, managed-first stance, build order, seam contracts.
  ADR-0002: repo layout and toolchain. ADR-0003: package names
  (`packages/domain`, `apps/api` = the app service of ADR-0001).
- `docs/HLD.md` — requirements with numbers, entities, the stored data
  model, the HLD diagrams, and §7: the mechanics and vocabulary every
  agent must use rather than reinvent.
- `docs/08-system-designs.md` — per-component LLD and the audit trail of
  the resolved design calls. `docs/live-architecture-decisions.md` — the
  reasoning behind ADR-0001. Other `docs/*.md` are earlier drafts.
- `../f1-live-events-poc/CLAUDE.md` — the POC being lifted: architecture,
  commands, hard-won OpenF1 facts (free-tier lockout, 404 semantics,
  mutating rows, never two API consumers). `../f1-live-events-poc/poc/ts/`
  is the source; the file coupling is behind `Fetcher` in `live_capture.ts`.

## Rules

- The five invariants in ADR-0001 §2 are not negotiable.
- Managed-first: pick the platform's way (secrets, TLS, pooler, restarts)
  over anything hand-rolled.
- New decisions get a new numbered file in `docs/decisions-adr/` (Status / Date /
  Context / Decision / Consequences). Never edit an accepted ADR's decision;
  supersede it. A PreToolUse hook blocks edits to accepted ADRs. Take the
  next free ADR number from `origin/main` and from every open PR
  (`gh pr list --search ADR-00`) when the PR opens, not when the draft
  starts. A PR that adds a precondition, a config name, or a wire format
  writes the ADR before asking for review.
- Tests (ADR-0002): vitest for unit (in-memory fakes) and integration
  (real Postgres in Docker — dedup + vote upsert); Playwright for e2e.
  `typecheck` + unit + the ADR check before a commit (the hook), plus
  `pnpm lint` (ESLint, root `eslint.config.js`) in the hook and in CI
  (ADR-0017); the same plus integration and build in CI on every PR,
  required for merge (ADR-0006). The PR's Verified section is prose about what CI does not
  cover, never pasted output. `db:up`/`db:down`/`db:migrate:*`/
  `test:integration` derive a per-worktree compose project and Postgres port
  from `scripts/db-env.sh` (README "Local Postgres"), so concurrent worktrees
  never share a database.
- `docs/` is gitignored on purpose (drafts), except `docs/decisions-adr/` and `docs/retros/`, which are tracked — do not change
  `.gitignore` unless asked. Consequence: `PRD.md`, `HLD.md` and the other
  drafts are invisible inside git worktrees. Task bodies must be
  self-contained (seam contracts pasted verbatim, ADR-0001 §4).
- OpenF1 credentials only via the platform secret store; never in the repo.
- Use the vocabulary in `docs/HLD.md` §7. "Projector" is the class,
  "authority" is the role. "Lock" is the poll state, not "close".
- Comments state what the code is for and any invariant it relies on. Never
  an issue number, a PR number, a review round, or who asked for it; git
  blame and the PR hold that history.

## Context by function

Load only what the task needs. Nothing below is loaded by default.

| Doing | Read / use |
|---|---|
| Any implementation task | The issue body first (self-contained by rule). Then `docs/HLD.md` §7 and the ADR the issue names. Then `superpowers:writing-plans` before code, `superpowers:test-driven-development` while coding, `superpowers:verification-before-completion` before claiming done. |
| Working inside one app | That app's own `AGENTS.md` (`apps/<name>/AGENTS.md`, created with the scaffold). It overrides nothing here; it adds the local conventions. |
| Ingest, fetcher, projector, votes, SSE | `docs/decisions-adr/0001` §2 and §4 verbatim, `docs/HLD.md` §4–§7, then the POC's `CLAUDE.md` for OpenF1 facts. |
| Frontend | `docs/HLD.md` §7 (alignment, rewind tiers, browser fold), ADR-0002 (Vite + React, shared reducer). The `frontend-design` plugin for any visual decision. |
| Reviewing a PR | `/review-pr <n> [--seam] [--security]` (`.claude/skills/review-pr`): one Sonnet correctness pass against the issue; the `seam-reviewer` agent (`.claude/agents/`) for the invariants, seam contracts, and accepted-ADR consistency when `apps/`, `packages/`, `db/`, or ADRs change; `/security-review` when `apps/`, `db/`, or `.github/` change; then classifies findings and posts the verdict. In CI the flags come from the changed paths. |
| Debugging | `superpowers:systematic-debugging` before proposing a fix. |
| Recording a decision | New numbered file in `docs/decisions-adr/`; the ADR-guard hook refuses edits to accepted ones. |
| Running the stack, rehearsing a race | Project skills under `.claude/skills/` once the scaffold exists; until then the POC's `CLAUDE.md` commands. |
| Finishing a branch | `superpowers:finishing-a-development-branch`. |
| Acting as a role | `.claude/agents/planner.md` plans and decides; `.claude/agents/implementor-<api|ingest|web>.md` take labelled issues and fan out subagents. |

## How work is tracked

Tasks live in GitHub Issues. Labels are the state machine:
`ready` → `in-progress` → `in-review` → `done`; `owner` marks a task no
agent may pick up. Every issue also carries exactly one service label:
`web` (apps/web), `api` (apps/api, packages/domain, and root tooling:
.railway, .github, scripts, docker-compose, .claude), `ingest`
(apps/ingest). An implementer picks only `ready` issues with its
own service label, oldest first, and respects "blocked by":
`gh issue list --label ready --label <service> --search "sort:created-asc"`. An issue body is self-contained: goal, the relevant seam
contracts pasted verbatim (ADR-0001 §4), files it may touch, acceptance
criteria as commands, and "blocked by #N". Facts the deliverable must
state are quoted in the body; a paraphrase of a quoted fact is a review
finding, not a style choice.

Per-task loop: claim (`in-progress`) → worktree branch → tests pass →
`gh pr create --draft` with "Closes #N", label `in-review` → when the
branch is done and CI is green, `gh pr ready` → the review bot
(`claude[bot]`, `/review-pr` from the Claude Code Review workflow) runs
once and posts a verdict: approve on a clean pass, changes requested, or
owner decision needed → after a fix round, remove and re-add `in-review`
for a re-review; a push never triggers one → **the owner merges; merging
is never automated** → label `done` → next `ready`. Merging to `main`
never deploys; a release is the `release` skill. A local `/review-pr` prints the verdict and
posts nothing, so approvals only ever come from the bot or the owner.
After a fix round, the implementer updates the PR's Friction line before
re-review; "none" on a PR that needed a round is a false record. A PR is
marked ready, or labelled `in-review`, only once `## Verified` holds the
real result; a placeholder there is a review finding. Slices merge into
main in order; never merge a later slice into an earlier slice's branch.
A number in a brief carries the command that produced it. A brief that
lifts an external API client quotes a measured response, not a type
annotation. A rule that starts something (a fetch, an export, a retry)
names what stops it.

Design-bearing tracks (ADR-0001 §4: the Postgres fetcher / projector
cursor, and vote acknowledgement) are owner-reviewed in person. Whether the
owner writes them or an agent does is the owner's call per task.
