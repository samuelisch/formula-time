# apps/web — local conventions

Vite + React. Built assets are static; served by the platform CDN or the
api service. The dev server (`vite.config.ts`) proxies `/health`, `/api`,
`/live`, `/polls` to the api service on port 3000.

## What this app owns

- Imports the RaceState type, wire schemas, and the reducer from
  `@formula-time/domain`. Never copies them. The reducer runs in the
  browser to fold finished races (target) and must stay identical to the
  server's.
- One `EventSource` per tab carries race state, poll state, tallies, and
  the heartbeat. The browser does not validate the SSE payload; it trusts
  its own server. Votes are a plain `POST`.
- Alignment is entirely client-side: OCR of the lap counter and
  lights-out detection produce a personal offset; today it is applied
  through the server-side seek path inherited from the POC, the target is
  a ring buffer of recent pushes rendered at now − offset. Manual delay
  nudge is the primary UI; auto-align is experimental.
- Spoiler safety: a delayed viewer never sees a tally or a result before
  their own lap reaches the lock lap.
- Scope rule: the UI stays plain until the delivery layer is proven. No
  feature that does not serve the timing board, polls, or alignment.
- The `frontend-design` plugin is available for visual decisions; it does
  not override the scope rule above.

## Conventions

- ESM everywhere: relative imports end in `.js` even from `.ts` files
  (NodeNext).
- One TypeScript at the root; `tsc -b` builds this package; `pnpm
  typecheck` at the root must pass.
- Unit tests are `*.test.ts` next to the source, vitest, in-memory fakes
  only. Integration tests (`*.integration.test.ts`, need Postgres) do not
  apply here — this app has no database access. Playwright is e2e only.
- `@formula-time/domain` is browser-safe: it imports no `node:*` module.
  Types and the reducer live there; identity hashing does not, and never
  gets imported here.
- No config is read from files in the image; nothing in this app touches
  `DATABASE_URL`, `OPENF1_LOGIN`, `OPENF1_PASSWORD`, `PORT`, or
  `LIVE_SOURCE` directly — those belong to ingest and api.
- Vocabulary: *fold* (reduce over the event log), *projector* (the class)
  / *authority* (the role, exactly one), *push* (one serialized RaceState
  + tallies sent to every socket), *lock* (poll state before resolve; not
  "close"). This app folds on the client but is never the authority.
