# ADR-0017 — Lint joins the gate: the commit hook and CI both run ESLint at zero warnings

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-09
- **Owner:** Samuel Chan
- **Amends:** ADR-0006. The two tiers (commit hook, CI) and what each is
  responsible for proving are unchanged; this adds one more check to both.

## Context

A prior PR (#160) added a root ESLint flat config (`eslint.config.js`,
`typescript-eslint` and `eslint-plugin-react-hooks`) and a `pnpm lint`
script, with `--max-warnings` left unbounded so the config could land
without also fixing every warning it surfaced. Neither the commit hook nor
CI ran it, so a new lint problem could reach `main` unnoticed. ADR-0006
lists what each tier runs; lint was not on either list.

Pinned in root `package.json` devDependencies: `eslint` 10.10.0,
`typescript-eslint` 8.70.0, `eslint-plugin-react-hooks` 7.1.1, `globals`
17.12.0, and `@eslint/js` 10.0.1. The fifth package exists because ESLint 9
and later ship `js.configs.recommended` only from `@eslint/js`, not from
`eslint` itself, and `typescript-eslint`'s own quickstart composes the two
the same way.

## Decision

- The pre-commit hook and CI both run `pnpm lint` (ESLint, no type-aware
  rules) after typecheck.
- `pnpm lint` is `eslint . --max-warnings 0`, so a warning blocks a commit
  and blocks CI the same way an error does.
- `scripts/pre-commit-check.sh`'s gate becomes `pnpm typecheck && pnpm lint
  && pnpm test:unit && scripts/check-adr-immutable.sh`.
- `.github/workflows/ci.yml` gains a `Lint` step between `Typecheck` and
  `Unit tests`, in the same `checks` job, so it is required for merge.
- The four rules PR #160 downgraded to `warn` to land without touching
  source (`@typescript-eslint/no-unused-vars`, `prefer-const`,
  `no-useless-assignment`, `preserve-caught-error`) return to their
  recommended level once the warnings they raised are fixed in source, in
  this same PR.

## Consequences

- A lint warning now blocks a commit locally and blocks the PR in CI,
  exactly as a type error already does.
- `pnpm lint` must run in comparable time to `pnpm typecheck` for the
  commit hook to stay cheap; it does not use type-aware rules, so it does
  not need the TypeScript program build the type-checked variant would.
- A future rule that cannot be satisfied without a source change lands
  either fixed in the same PR that adds it, or downgraded to `warn` with an
  explicit, reviewable reason, the way PR #160 did — `--max-warnings 0`
  means a bare `warn` left unaddressed still blocks the gate.
