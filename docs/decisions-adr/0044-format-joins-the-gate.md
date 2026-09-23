# ADR-0044 — Format joins the gate: the commit hook and CI both run Prettier's check

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-23
- **Owner:** Samuel Chan
- **Amends:** ADR-0017. The two tiers (commit hook, CI) and what each is
  responsible for proving are unchanged; this adds one more check to both,
  the same way ADR-0017 added lint to the gate ADR-0006 defined.

## Context

#361 added Prettier, pinned exact, with `.prettierrc.json` and
`.prettierignore` measured against the repo's existing style, and one
format-only commit that brought every file Prettier covers into line with
it. Without a check in the gate, that agreement drifts the first time a
commit lands unformatted: ESLint's own stylistic rules were already turned
off in favor of Prettier (`eslint-config-prettier`, last in
`eslint.config.js`), so nothing else in the gate would catch it. The
formatter never touches `.github/`, `.railway/`, the lockfile, or ADRs
(`.prettierignore`), so the gate's `prettier --check` never covers them
either.

## Decision

- `package.json` gains two scripts: `format` (`prettier --write .`) and
  `format:check` (`prettier --check .`).
- `scripts/pre-commit-check.sh`'s gate runs `prettier --check` on the files
  the commit actually adds, copies, modifies or renames
  (`git diff --cached --name-only --diff-filter=ACMR`, filtered to the
  extensions Prettier has an opinion on), not the whole tree: a repo-wide
  check would also fail on pre-existing files the commit never asked the
  author to touch. The gate becomes `pnpm check:exact-pins && pnpm
  typecheck && pnpm lint && <the staged-files format check> && pnpm
  test:unit && scripts/check-adr-immutable.sh`.
- `.github/workflows/ci.yml`'s `checks` job gains a `Format check` step
  (`pnpm format:check`) between `Lint` and `Unit tests`, in the same job,
  so it is required for merge exactly as lint is (ADR-0017).
- `eslint-config-prettier` is the last entry in `eslint.config.js`'s config
  array, turning off every ESLint stylistic rule Prettier also has an
  opinion on, so the two checks never disagree over the same line.

## Consequences

- An unformatted file now blocks a commit locally and blocks the PR in CI,
  exactly as a lint warning already does.
- The commit-hook check runs Prettier only over files the commit touches,
  so it stays cheap and never fails on a pre-existing file outside the
  commit's scope; CI's `format:check` runs over the whole tree, so a file
  that slips past the hook (a direct push, a merge commit) is still caught
  before merge.
- A file `.prettierignore` excludes is never a false failure in either
  tier: Prettier's own ignore file governs regardless of how a path
  reaches `prettier --check`, whether that's the hook's staged-file list
  or CI's whole-tree run.
