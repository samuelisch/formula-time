# apps/web — local conventions

Issue label: `web`. An agent working here picks `ready` issues labelled
`web` (`gh issue list --label ready --label web --search "sort:created-asc"`) and nothing else.

## What this app owns

- Vite + React. Built assets are static, hosted on Netlify (interim
  `*.netlify.app`, target the apex of a custom domain); the api answers
  on its own origin (ADR-0008). `public/_redirects` is the SPA fallback,
  `public/_headers` the asset cache policy. `VITE_API_URL` is the api's origin at build time; unset
  means relative URLs, which is the dev setup: the dev server
  (`vite.config.ts`) proxies `/health` and `/api` to the api on port 3000
  (`/live` and `/polls` are SPA routes, not proxied -- issue #72). Every
  request goes through `src/api.ts`, never a hand-built URL.
- Imports the RaceState type, wire schemas, and the reducer from
  `@formula-time/domain`. Never copies them. The reducer runs in the
  browser to fold finished races (target) and must stay identical to the
  server's.
- One `EventSource` per tab carries race state, poll state, tallies, and
  the heartbeat. The browser does not validate the SSE payload; it trusts
  its own server. Votes are a plain `POST`.
- Alignment is entirely client-side: OCR of the lap counter and
  lights-out detection (`src/align/`) produce a personal offset applied
  straight to `setDelayMs` on the live store -- no server seek, no trim
  loop; the render is a pure function of the delay against the push ring
  buffer (now − offset). `TransportBar` (`src/transport/`) is the primary
  UI for nudging the delay; auto-align (`AlignPanel`/`useAligner`) is
  experimental. `tesseract.js` (the OCR library) is a dependency loaded with a dynamic
  `import()` in `src/align/capture.ts` so ordinary viewers never download
  it; worker and core paths are left at the library's CDN defaults --
  Netlify serves this app's bundle, but the OCR worker itself comes from
  jsDelivr at runtime.
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
- `@formula-time/domain` is browser-safe: its tsconfig enforces
  `types: []` and `lib: ["ES2022"]`, so it cannot import `node:*`. Types
  and the reducer live there; identity hashing does not, and never gets
  imported here.
- Config is read from the platform secret store, never from files in the
  image: `DATABASE_URL`, `OPENF1_LOGIN`, `OPENF1_PASSWORD`, `PORT`,
  `LIVE_SOURCE`. This app touches none of them directly.
- Vocabulary: *fold* (reduce over the event log), *projector* (the class)
  / *authority* (the role, exactly one), *push* (one serialized RaceState
  + tallies sent to every socket), *lock* (poll state before resolve; not
  "close"). This app folds on the client but is never the authority.
- Live state lives in the zustand store (`src/live/store.ts`), not in
  TanStack Query -- a push stream updating several times a second is not
  request/response data. TanStack Query is only for `/api/polls` and the
  vote mutation. Components read the store through the narrow selector
  hooks in `src/live/selectors.ts` (`useConnection`, `useDisplayed`,
  `useDelay`, ...), never the whole store, so a render depends only on the
  slice it uses.
- The delay axis is `Date.parse(state.latest_source_time)`, falling back
  to `sent_at` when null (`axisOf` in `src/live/types.ts`) -- the POC's
  alignment anchor, so an offset measured against the broadcast applies
  directly. The push ring buffer (`src/live/buffer.ts`) caps at 600
  entries or 180 000ms of span, whichever hits first, oldest evicted;
  deltas are a post-deploy item, so this cap is the memory bound until
  then. `delayMs === 0` renders the live edge with zero buffer work.
- `src/live/useLiveStream.ts` is the only place in the app that
  constructs an `EventSource`; it is mounted once in `Shell`. No other
  component or hook opens its own connection.
- `src/transport/TimeTarget.ts` is the seam `TransportBar` drives against,
  with `useLiveTimeTarget` (the live store's delay) and
  `useReplayTimeTarget` (a replay's playback clock) as its two
  implementations, so one control surface serves both.
- `src/replay/timeline.ts`'s `Timeline` is the incremental fold --
  keyframes, lap markers, `foldAt` for scrubbing -- shared by the replay
  path (`src/replay/foldRace.ts`, the whole event log in one shot) and the
  live path (`src/live/timeline.ts`, built page by page while a session
  is still live). The live page mounts `src/live/LiveTimelineLoader.tsx` to
  hand that timeline to the live store, whose `reselect` (`src/live/store.ts`)
  folds from it once a viewer rewinds past the push ring buffer
  (`mode: "timeline"`, `polls: []`).
- Styling is CSS Modules (`*.module.css` next to the component); the dark
  palette lives as CSS variables in `src/index.css`.
- Unit tests are `*.test.ts(x)` next to the source. The root
  `vitest.config.ts` runs this app's tests as the `web` project (jsdom +
  React Testing Library, `src/test/setup.ts`); everything else runs as
  the `node` project. `src/test/fakeEventSource.ts` is the EventSource
  test double -- inject it via `useLiveStream({ EventSourceImpl })`.
