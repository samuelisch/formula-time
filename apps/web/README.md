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
regenerated by `scripts/vendor-ocr.mjs`), never a CDN. The policy
(`src/align/core.ts`'s `OffsetTracker`): a lights-out read seeds or
overwrites the offset outright; a lap-flip read nudges it by a small EMA
gain instead of replacing it; a sample far from the current estimate is
discarded, and three consecutive agreeing discards force a re-lock.
Alignment is experimental by decision.

## Reading order

`src/app/router.tsx` and `src/app/Shell.tsx` → `src/live/useLiveStream.ts` →
`src/live/store.ts` → `src/board/useBoardState.ts` → `src/pages/BoardPage.tsx`
→ `src/transport/TimeTarget.ts` → `src/replay/timeline.ts` →
`src/pages/ReplayPage.tsx` → `src/polls/` → `src/align/`.

See [`../../docs/architecture.md`](../../docs/architecture.md) for how this
app fits the rest of the system, and
[`../../docs/glossary.md`](../../docs/glossary.md) for the vocabulary it
uses.
