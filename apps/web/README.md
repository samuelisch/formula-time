# web

A static React bundle: no server, no build-time secrets beyond the api's
origin. One `EventSource` per tab carries the live race. Everything on the
board renders from the displayed push, not the live edge, so a delayed
viewer is never spoiled.

## How a push becomes pixels

```mermaid
flowchart LR
  SSE[SSE ?format=delta<br/>state · delta · status] -->|applyPatch| ST[live store<br/>newest push · ring buffer 60 / 15 s · timeline]
  ST -->|reselect: delay on the source axis| DP[displayed push<br/>mode: edge · buffer · timeline]
  DP --> BS[board seam<br/>BoardSource ?? displayed]
  RP[replay: export file<br/>foldRace → keyframes] --> BS
  BS --> C[components<br/>timing table · cards · polls · driver panel]
  TT[time-target seam<br/>live delay | replay clock] --> TB[transport bar · align panel]
```

- **SSE** — `src/live/useLiveStream.ts` opens the one `EventSource` per tab, mounted once in `Shell`, on `GET /api/live/events?format=delta`.
- **ST** — `src/live/store.ts`'s Zustand store folds each frame into the newest push, a ring buffer, and, once loaded, a full-race timeline.
- **DP** — `reselect` in `src/live/store.ts` picks the displayed push from the viewer's delay on the source-time axis.
- **BS** — `src/board/useBoardState.ts`'s `useBoardPush()` returns a mounted `BoardSourceProvider`'s push, or the live store's displayed push when none is mounted.
- **RP** — `src/replay/foldRace.ts` folds a finished session's export file into the same `Timeline` shape (`src/replay/timeline.ts`) that the live path builds incrementally.
- **C** — the timing table, cards, polls and driver panel all read through the board seam, never a live or replay object directly.
- **TT** — `src/transport/TimeTarget.ts` is the one interface `useLiveTimeTarget` and `useReplayTimeTarget` both implement.
- **TB** — `src/transport/TransportBar.tsx` and `src/align/AlignPanel.tsx` are the two consumers of the time-target seam.

**Live timeline.** `src/live/useSessionTimeline.ts`: a connection that leaves
`"open"` resumes paging from the head seq into the same timeline it already
built; only the first join and a `rebuilt` push start it over from seq 0
(ADR-0038).

## The three modes

| Mode | Chosen when | Costs | Polls show |
|---|---|---|---|
| `edge` | the delay is 0 | nothing | the live polls |
| `buffer` | the delay is within the last 60 pushes or 15 s (`src/live/buffer.ts`'s `BUFFER_LIMITS`) | a binary search over stored pushes | the polls as of that push |
| `timeline` | the delay is older than the buffer and a timeline for this session is loaded | a fold from the nearest keyframe (`src/replay/timeline.ts`) | currently an empty list -- `src/live/store.ts`'s `timelineDisplayed` sets `polls: []` |

## The two seams

- **The board seam** (`src/board/useBoardState.ts`): `BoardSourceProvider`
  supplies a replay's folded push; with no provider mounted, the hooks fall
  back to the displayed live push. It exports `useBoardPush`,
  `useBoardIsReplay`, `useBoardRaceControl`, `useBoardWeather`,
  `useBoardDriverCount`, `useBoardLeaderLap`, `useBoardSessionMeta`,
  `useBoardSessionStatus`, `isRacingPush`, `useBoardIsRacing`,
  `useBoardDriverOrder`, `useBoardDriver`, `useBoardRunStatus`, and
  `useBoardPositionDeltas`. Polls read through this seam too
  (`polls/usePolls.ts`): `Shell` holds the live connection open on every
  route, and a replay's push carries `polls: []`, so a replay never shows
  or opens today's live polls. `useBoardState.ts` is a plain `.ts` file,
  so `BoardSourceProvider` is built with `createElement` rather than JSX.
- **The time-target seam** (`src/transport/TimeTarget.ts`): `range()`,
  `displayedAt()`, `seekTo()`, `nudge()`, `anchors()`, `playback()`, and
  `notice()`, plus `syncOffsetMs()` and `rewindMode()`. `useLiveTimeTarget`
  and `useReplayTimeTarget` are its two implementations.

## Board layout

`src/board/Board.tsx` is the pure timing board -- a two-row toolbar (row 1:
lap counter, source clock, caller-supplied controls; row 2: the shared
transport bar, full width), the driver-detail `side` slot, race-control and
weather cards in a grid, and the full driver table.

- **DOM order vs. visual position.** `side` sits in DOM order right after
  the toolbar -- above the cards and the table -- because that is also its
  visual position below the ~860px breakpoint (`Board.module.css`): a
  full-width card directly under the toolbar. Above the breakpoint,
  `grid-template-areas` repositions `side` next to the table in a final
  row without moving it in the DOM, so reading/tab order stays "toolbar,
  side, cards, table" at every width; only the visual arrangement changes.
  One `grid` on `.board`, not two copies of `side`.
- **Split from `BoardPage`.** The split is by composition, not a flag: the
  live route's own furniture (the finished/upcoming banner, polls, and
  align controls) reads the live session and belongs to `BoardPage`, which
  wraps `Board`. `ReplayPage` mounts `Board` directly with the transport
  bar in the `transport` slot, so a replay can never pick up a live-only
  control by accident.
- **Two-row toolbar.** Split because the shared `TransportBar` (row 2)
  needs the full width for its slider; row 1 holds the short controls that
  stay put beside the lap counter.
- **Racing detection** (`src/board/useBoardState.ts`'s `isRacingPush`).
  The fold is the authority on whether racing has begun, not the session
  row: the row can lag a status flip by one lifecycle check, so this also
  reads `race_control.session_status` and the leader's lap as a second
  signal alongside the row's own `status`. True when the row already says
  "live", or -- short of that -- when the row is not "finished" and either
  race control has recorded `SESSION STARTED` or the leader's lap is 1 or
  more; "finished" always wins, never overridden by a leftover racing
  signal. A pure function, not a hook, so both `useBoardIsRacing` (the
  displayed push) and `BoardPage`'s timeline-loader latch (the live push)
  apply exactly the same rule.
- **Stable driver identity** (`src/board/useBoardState.ts`'s
  `useBoardDriver`). Returns the same object reference across pushes for
  an unchanged driver, so a memoised `DriverRow` (default shallow prop
  comparison) skips re-rendering for every driver a push didn't touch.
  Stored in state (not a ref) and updated during render via React's
  "adjust state during render" pattern -- setting state while rendering is
  safe and causes React to redo the render immediately with the new
  state, before anything commits or paints.
- **Position-cue expiry and rewind reset** (`src/board/useBoardState.ts`'s
  `advancePositionCueState`). Folds one push into the previous cue state,
  given the current wall-clock time: the baseline resets silently (no
  cue) on a new session or whenever the push's axis (`axisOf()`, the same
  anchor alignment uses) goes backwards, which is what a replay
  rewind/scrub looks like -- the one rule that keeps a delayed or
  scrubbing viewer from seeing a cue for a "change" that is really just
  the playhead moving backwards. A cue is pruned once `now` is more than
  `POSITION_CUE_TTL_MS` past the push that set it.
- **Position-delta fold timing** (`src/board/useBoardState.ts`'s
  `useBoardPositionDeltas`). Position deltas since the previous push,
  keyed by driver number: positive means the driver gained places,
  negative means it lost them, and a driver absent from the result has no
  live cue. The fold (`advancePositionCueState`) runs during render via
  React's "adjust state during render" pattern rather than a ref or an
  effect, so the cue expiry it computes is checked each time a push
  arrives, not on a per-row timer -- a cue can outlive its TTL by up to
  one push interval if pushes are sparse, an acceptable trade for not
  running a timer per driver row.
- **Row memoisation** (`src/board/DriverRow.tsx`). `useBoardDriver()`
  returns the previous reference when a driver's data hasn't changed
  since the last push, so a push that touches one driver re-renders only
  that driver's row. `selected` and `onSelect` arrive as props from one
  shared `useDriverSelection()` call in `TimingTable`, rather than each
  row calling the hook itself: every row calling `useSearchParams()`
  directly would re-render all of them on any selection change (the
  URL/location context notifies every subscriber, not just the row whose
  own `selected` value changed), defeating the point of this
  memoisation. `delta` is likewise a plain number prop (not read from a
  hook here), so the same shallow comparison also skips a row whose cue
  did not change; it also drives a subtle row highlight (not just the
  small cue cell), fading with the arrow since both come from the same
  `delta`.

## BoardPage

`src/pages/BoardPage.tsx` is the `/live` route: the pure `Board`
(`src/board/Board.tsx`) plus everything that is live-only -- the
finished/upcoming session banner, the connection pill, polls, and the
alignment control. `ReplayPage` mounts `Board` on its own, so none of this
leaks onto a replay: the banner would read the replay's own session, which
is always finished (the exporter only exports finished sessions), and the
transport bar's live `TimeTarget` acts on the live store's push buffer,
which a replay does not use.

- **One `TimeTarget` seam for transport and align.** `TransportBar` is
  driven by `useLiveTimeTarget()` through the `TimeTarget` seam rather
  than the live store directly, so `AlignPanel` (via `useAligner`) is
  routed through the same seam and can also mount on a replay
  (`ReplayPage.tsx`) -- one `TimeTargetProvider` wraps the whole `Board`,
  not just `TransportBar`, so both slots read the same target.
- **Timeline-loader keying.** `LiveTimelineLoader` is mounted here, keyed
  off the *live* push's own session key (`useLiveSessionKey`) -- never the
  *displayed* session, which in timeline mode is the synthesised push and
  would feed the loader its own output back in. `status` still comes from
  the raw `useLiveSessionStatus()` (`LiveTimelineLoader` only reads it to
  decide when to stop paging in events); whether to *mount* the loader at
  all goes through `isRacingPush()` applied to the live push instead, so
  the same stale-row lag that would otherwise delay it cannot hide the
  full-race timeline for a rewinding viewer.
- **Timeline-loader mount latch** (`useShouldMountTimelineLoader`). Once
  mounted for a session key it stays mounted while that key remains the
  live session, even after racing (`isRacingPush` applied to the live
  push) turns false again -- a viewer rewound deep into the race at the
  chequered flag must not be yanked to the final state (the spoiler rule:
  everything renders from the displayed, rewound state). It never mounts
  before racing has begun, and never for a session that was already
  "finished" the first time this saw it (that session's banner points at
  the replay instead). `racing` uses the same rule as `useBoardIsRacing`,
  so the row's own status lagging the fold by one lifecycle check delays
  this mount by no more than it delays the transport bar. The latch itself
  runs through React's "adjust state during render" pattern (as
  `useBoardDriver` in `board/useBoardState.ts` does), not a ref: comparing
  state to the current `sessionKey` during render, and calling `setState`
  during render when it differs, causes React to redo the render
  immediately with the new state before anything commits or paints.
- **Racing gate.** The transport bar and align button gate on
  `useBoardIsRacing()`, not the session row's status alone: the fold is
  the authority on whether racing has begun, and the row can lag it by one
  lifecycle check. The upcoming banner is suppressed under the same
  condition, since it would otherwise sit above a board that is already
  live. The finished banner keeps its own rule -- a stale row is never the
  reason a viewer loses the finished/replay signal.

## ReplayPage

`src/pages/ReplayPage.tsx` mounts the pure `Board`, never `BoardPage`: the
live route's furniture (the finished/upcoming banner and polls) reads the
live session and must not appear on a replay -- the banner in particular
would always fire here (the exporter only exports finished sessions) and
link the replay back to itself, so there is no polls button in `controls`.
`AlignPanel` mounts here too: `useAligner` reads through `useTimeTarget()`
and the board-source seam instead of the live store directly, so it lines
the replay up with a broadcast the same way the live board does.

## Routes

| Route | Page | Mounts |
|---|---|---|
| `/` | `RacesPage` | the race chooser |
| `/live` | `BoardPage` | board, transport and align panel when racing, connection pill, polls button and modal, the timeline loader |
| `/races/:session_key` | `ReplayPage` | board under `BoardSourceProvider`, replay transport |
| `/polls` | `PollsPage` | polls by race |

`src/replay/replayStart.ts`'s `replayStartMs` cuts a replay's playback and
scrub bar to the formation lap -- `date_start` on time, `FORMATION_WINDOW_MS`
before the measured lights-out when delayed -- instead of the recording's
first row.

## Data sources

| Data | From | Held in | Cache |
|---|---|---|---|
| the stream | `src/live/useLiveStream.ts` | the store | none |
| the snapshot on a gap | `GET /api/live/snapshot` | the store | none |
| the races index | `GET /api/races` | TanStack Query | default |
| the export file | `GET /api/races/:key` | TanStack Query | immutable with `?v=` |
| the paged log | `GET /api/races/:key/events` | the live timeline | none |
| polls by race | `GET /api/races/:key/polls` | TanStack Query | 5 minutes |
| the vote | `POST /api/vote` | a mutation | remembered in `localStorage` as `poll-vote-{poll_id}` |

## Delay, offset, nudge, seek

- **Delay** is how far behind the live edge a viewer watches, on the
  source-time axis (`src/live/store.ts`).
- **Offset** is alignment's estimate of the delay between the broadcast and
  the data (`src/align/applyOffset.ts`).
- **Nudge** moves the delay by a step (`src/transport/TimeTarget.ts`).
- **Seek** moves the delay to a moment (`src/transport/TimeTarget.ts`).

## Alignment

Capture is `getDisplayMedia` (`src/align/capture.ts`). OCR of the lap
counter runs on a vendored engine served from this origin (`public/ocr/`,
regenerated by `scripts/vendor-ocr.mjs`), never a CDN; in Node (the opt-in
fixture test against real footage) tesseract.js resolves paths off the
filesystem instead. The policy (`src/align/core.ts`'s `OffsetTracker`): a
lights-out read seeds or overwrites the offset outright; a lap-flip read
nudges it by a small EMA gain instead of replacing it; a sample far from
the current estimate is discarded, and three consecutive agreeing discards
force a re-lock. Alignment is experimental by decision.

- **Lap tracker re-lock** (`src/align/core.ts`'s `createLapTracker`). Only
  `lastLap + 1` counts as a time-anchored flip; a first read establishes
  the lap but not when it started. A tracker stuck on a misread (a bad
  first read, or a counter hidden across two or more flips) re-locks after
  three consecutive reads agreeing on the same otherwise-rejected value,
  treating that as a new unanchored first read -- never a flip, since a
  re-lock never claims to know when that lap started. Any other verdict,
  or a rejected value that changes, resets the count.
- **Lights-out detection** (`src/align/core.ts`'s
  `createLightsOutDetector`). The gantry's five lights are tiny against
  trackside red signage, so the detector tracks a scalar signature instead
  of per-tile stability: the fraction of lit tiles ramps as lights come on
  one by one, sustained above a trailing-window floor, then collapses
  toward the floor in a single step, inside one continuous shot. Static
  signage never ramps; a camera cut changes most cells at once and is
  vetoed by the global-change check.
- **Locating the HUD counter** (`src/align/core.ts`'s `findLapLine`).
  Scans a full-frame OCR result for the first recognized line whose text
  parses as `LAP N/M`; its bounding box becomes the crop, padded so
  digit-width changes (`9 -> 10`, `99 -> 100`) stay inside. Tesseract's
  recognized lines sit under `blocks[].paragraphs[].lines[]`, not the
  page's top level, and only appear when the caller requests
  `{ blocks: true }`.
- **The apply rule** (`src/align/policy.ts`'s `applyReading`). On a
  lights-out fire or a lap-flip read at frame time `f`:
  `target = chooseAnchorTarget(anchors, lap, isRelock)` (lights-out uses
  the last restart anchor after an abort, else `lights_out`);
  `observedWall = Date.now() - (performance.now() - f) + PIPELINE_BIAS_MS`;
  the offset tracker observes `(target, observedWall, kind)`, and a
  numeric `offsetMs()` sets the delay. An unknown anchor returns a "no
  anchor yet" status with no server fetch and no retry loop -- anchors
  come from `useAnchors()` synchronously.
- **Routing an offset to a delay** (`src/align/applyOffset.ts`'s
  `applyOffsetToTarget`). `observedWall - anchorSourceMs` is a constant
  mapping between the viewer's wall clock and the data's source-time axis,
  true whether the anchor is seconds old (live) or days old (a replay
  recording), so the position to show is always
  `sourceMs = nowWallMs - offsetMs` on both platforms. `now` must be the
  same wall clock the offset's `observedWall` was computed from, never a
  fresh `Date.now()` call, or the two calls' sub-ms drift leaks into the
  position.
- **Generation-guarded capture** (`src/align/useCapture.ts`'s `start()`).
  Bumps a generation counter and re-checks it after every `await` in its
  async setup chain; a stale chain (superseded by a Stop or a second Start
  before it finished) abandons itself instead of writing into shared
  state, releasing only its own locally tracked stream/worker acquisitions
  -- never the shared refs, which may already belong to a newer chain that
  ran to completion.
- **Live ref sync timing** (`src/align/useOcrLoop.ts`, `useAligner.ts`).
  The sampling loop's live values sync from a `useLayoutEffect`, never a
  plain `useEffect`: layout effects flush synchronously right after
  commit, before the browser can run any queued macrotask, so the
  `SAMPLE_MS` interval can never observe a commit whose ref sync hasn't
  run yet.

## Polls

`src/polls/PollCard.tsx` renders one poll: question, status pill, lock-lap
meta, option rows as vote buttons, and a verdict line once resolved.
Collapsed inside a `Collapsible`: the summary is the status pill, question,
and lock/vote-count line; the option rows, vote buttons, and verdict live
in the expanded body. Open polls default open (they need a vote), every
other status defaults collapsed; `PollList` and `PollModal` both render
this unchanged, so the collapse behaviour comes for free.

- **Auto-open signal** (`src/polls/PollModal.tsx`). Auto-opens only for a
  transition the viewer's own tab has watched happen: the first signature
  observed for a session is seeded without opening, so a cold page load
  (or a fresh race) never auto-pops for poll state that arrived before
  this tab was watching. Only a later change for the same session pops it
  -- a newly open poll, or the count of resolved polls growing -- never
  re-pops for an unchanged set, including across an unmount/remount
  (`BoardPage` and `PollsPage` are sibling routes, so navigating away and
  back remounts this component; the last-seen signature lives in the
  `pollModalStore` singleton, not a local ref, so it survives that). The
  signature is scoped to the session key, read off the same push as the
  polls themselves (`useBoardPush()?.session_key`), so a new race re-seeds
  instead of comparing across sessions. `polls` is passed in (from
  `usePolls()` at the mount site in `BoardPage`) so this stays testable by
  rerendering with new props rather than driving the live store.
- **Poll-modal signature persistence** (`src/polls/pollModalStore.ts`).
  The signature lives in this singleton rather than a `PollModal`-local
  ref: `BoardPage` and `PollsPage` are sibling routes, so navigating away
  and back remounts `PollModal`. A per-instance ref would reset to `""` on
  that remount, so the auto-pop effect would treat an unchanged,
  already-dismissed poll set as a fresh transition and re-pop it. Keeping
  the signature in this singleton (which survives the remount, same as
  `isOpen`) makes "never re-pops for an unchanged set" hold across
  navigation, not just across rerenders of one instance.
- **Board-seam poll reads** (`src/polls/usePolls.ts`). The push comes
  through the board seam (`useBoardPush()`), not `useDisplayed()`
  directly, for the same reason every other board hook does: `BoardPage`
  also renders under a replay's `BoardSourceProvider`, and `Shell` keeps
  the live SSE connection open on every route. A replay's synthesized push
  carries `polls: []` (polls are live-only by product stance), so under
  the provider this returns nothing -- no poll button count, no auto-pop
  for an unrelated live result mid-replay. On the live route no provider
  is mounted and `useBoardPush()` falls back to `useDisplayed()`, so live
  behaviour is unchanged.
- **Race selection settling** (`src/polls/useSelectedRace.ts`). An
  explicit `?race=<key>` always wins immediately -- the caller fetches its
  polls regardless of whether the current session is known yet, and it
  self-heals to "current" once a push confirms a matching session key.
  With no param, the default is "the current session, else the newest
  race" -- but "no current session is known yet" is ambiguous on its own:
  it means both "the session hasn't pushed its first state" (transient,
  resolves in moments) and "there genuinely is no session"
  (`session-lifecycle.ts`'s `pickSession() === null`, e.g. off-season).
  Inferring the difference from `sessionKey === null` alone races
  `GET /api/races` against the first SSE push and can show a wrong,
  unrelated race's polls. Instead the hook waits for a settled signal from
  the live connection:
  1. `connection !== "open"`, or `"open"` with no push and no `status`
     frame yet -- still settling. `isSettling` is true; no fallback.
  2. Once a `status` frame has landed (still no push), settling is over:
     `isSettling` flips false -- the caller falls through to the normal
     current-session view (its own `GET /api/polls` initial fill) -- while
     a background timer runs.
  3. A push lands at any point after (1) -- current session confirmed; the
     caller reads polls from the push from then on. Or: still no push
     after `NO_SESSION_TIMEOUT_MS` since (2) -- no session is coming;
     `selectedKey` falls back to the newest race from `GET /api/races`,
     matching both the dropdown and the polls the caller shows
     (`RaceSelect`'s placeholder option, in the meantime, keeps the
     dropdown from ever silently pre-selecting a historical race before
     this fires).
- **No-session timeout reset** (`useSelectedRace`'s `noSessionTimedOut`
  effect). Ticks true once the connection is settled (open + at least one
  status frame) and `NO_SESSION_TIMEOUT_MS` has passed with still no push
  and no explicit `?race=`. Resets the moment any of those stop holding (a
  push lands, a param is set, or "settled" is lost): the reset lives in
  the effect's own cleanup, which React runs right before the next effect
  instance (or on unmount), rather than in the setup body, so a fresh
  watch cycle always starts from a clean "not timed out" and no state is
  set synchronously while the effect is merely (re)arming.
- **Vote key scoping** (`src/polls/votes.ts`). Keyed by `poll_id` alone
  (`poll-vote-{poll_id}`) rather than `poll-vote-{session_key}-{poll_id}`:
  poll ids already embed the session key (`${sessionKey}:winner` /
  `${sessionKey}:podium`, `apps/api/src/polls/poll-module.ts`), so they
  never repeat across sessions and the session segment would be redundant.
  Keying by session too is actively wrong: a vote cast during the `/polls`
  page's initial-fill window (before the first SSE push, when the session
  key is not yet known) would write under a placeholder session segment;
  once the push landed and the real session key was known, `myVote` would
  look under a different key and silently lose the pick. Keying by
  `poll_id` alone makes that race impossible.

## Narrow-viewport detection

`src/lib/useNarrowViewport.ts` tracks whether the viewport is at or under
`--bp-narrow` (`index.css`, 640px), for the few places that must know the
breakpoint in JS rather than through a pure CSS media query alone: the
align panel's default-collapsed state and the poll modal's bottom-sheet
variant. Everything else collapses with plain CSS and needs no hook.
jsdom has no `window.matchMedia`, so the hook reads defensively -- any
test that never installs a stub (`src/test/matchMedia.ts`) simply gets
`false`, the same as an environment with no matching media feature.

## Reading order

`src/app/router.tsx` and `src/app/Shell.tsx` → `src/live/useLiveStream.ts` →
`src/live/store.ts` → `src/board/useBoardState.ts` → `src/pages/BoardPage.tsx`
→ `src/transport/TimeTarget.ts` → `src/replay/timeline.ts` →
`src/pages/ReplayPage.tsx` → `src/polls/` → `src/align/`.

See [`../../docs/architecture.md`](../../docs/architecture.md) for how this
app fits the rest of the system, and
[`../../docs/glossary.md`](../../docs/glossary.md) for the vocabulary it
uses.
