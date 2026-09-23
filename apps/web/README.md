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
  `useBoardPositionDeltas`.
- **The time-target seam** (`src/transport/TimeTarget.ts`): `range()`,
  `displayedAt()`, `seekTo()`, `nudge()`, `anchors()`, `playback()`, and
  `notice()`, plus `syncOffsetMs()` and `rewindMode()`. `useLiveTimeTarget`
  and `useReplayTimeTarget` are its two implementations.

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

## Reading order

`src/app/router.tsx` and `src/app/Shell.tsx` → `src/live/useLiveStream.ts` →
`src/live/store.ts` → `src/board/useBoardState.ts` → `src/pages/BoardPage.tsx`
→ `src/transport/TimeTarget.ts` → `src/replay/timeline.ts` →
`src/pages/ReplayPage.tsx` → `src/polls/` → `src/align/`.

See [`../../docs/architecture.md`](../../docs/architecture.md) for how this
app fits the rest of the system, and
[`../../docs/glossary.md`](../../docs/glossary.md) for the vocabulary it
uses.
