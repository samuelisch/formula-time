# Glossary

One definition per term, and the file that owns it. The code and the guides use these words and no synonyms.

| Term | Means | Owned by |
|---|---|---|
| event | one row of the append-only log: an OpenF1 payload with its endpoint, source time, receive time and content-hash id | `packages/db/prisma/schema.prisma`, `packages/domain/src/types.ts` |
| seq · cursor | `seq` is the row's commit-ordered number; a cursor is the last `seq` a reader has applied | `apps/api/src/projector/projector.ts` |
| source time | the timestamp inside the payload (when it happened at the track); the delay axis and the fold's clock | `apps/ingest/src/openf1/normalize.ts` |
| fold | reduce the log into a `RaceState`; the browser and the api run the same reducer | `packages/domain/src/race_state.ts` |
| projector · authority | the class that folds the live session on the api, and the role that makes its state the truth; exactly one | `apps/api/src/projector/projector.ts` |
| rebuilt | a push flag meaning "discard your timeline and backfill again": a late commit, a skipped frame, a failed push, or a gap | `apps/api/src/projector/projector.ts`, `apps/api/src/fanout/fanout.ts` |
| push | the object sent on a tick: state, polls, events, seq (`StatePush`), or its patch form (`DeltaPush`) | `packages/domain/src/wire.ts` |
| frame | a push encoded as SSE bytes, plain or gzip; the same bytes go to every socket of a format | `apps/api/src/fanout/fanout.ts` |
| fan-out | the class that turns one push into frames and writes them to every socket | `apps/api/src/fanout/fanout.ts` |
| keyframe | on the stream: every 200th delta push is a full state; in a timeline: a stored fold every 500 events or 30 s, for scrubbing | `apps/api/src/fanout/fanout.ts`, `apps/web/src/replay/timeline.ts` |
| lane | one of the two feeds into ingest's queue: REST or MQTT | `apps/ingest/src/openf1/rest-lane.ts`, `mqtt-lane.ts` |
| writer | the one connection that drains the queue into `events`, in arrival order | `apps/ingest/src/writer/writer.ts` |
| recording | the jsonl copy of a session in received order, replayable by the simulator and the loader | `apps/ingest/src/openf1/recorder.ts` |
| session | an OpenF1 session row; only race sessions are tracked; the live window is 30 minutes either side of its scheduled time | `packages/db/prisma/schema.prisma`, `apps/ingest/src/writer/sessions.ts` |
| entry list | the `drivers` rows for a session, fetched live and written as events | `apps/ingest/src/openf1/rest-lane.ts` |
| lock · resolve · void | a poll's states after open: locked at half distance, resolved at the flag, voided if the session ends unresolved; never "close" | `packages/domain/src/polls.ts`, `apps/api/src/polls/poll-module.ts` |
| export | one immutable gzip file per finished session, folded in the browser | `apps/api/src/export/exporter.ts` |
| delay | how far behind the live edge a viewer watches, on the source-time axis | `apps/web/src/live/store.ts` |
| nudge · seek | the two ways a viewer changes the delay: by a step, or to a moment | `apps/web/src/transport/TimeTarget.ts` |
| offset | alignment's estimate of the delay between the broadcast and the data | `apps/web/src/align/applyOffset.ts` |
| displayed push · mode | the push the board renders and where it came from: `edge` (delay 0), `buffer` (the ring buffer), or `timeline` (a fold) | `apps/web/src/live/store.ts` |
| timeline | the browser's own fold of the log, with keyframes and lap markers, for scrubbing a live race or a replay | `apps/web/src/replay/timeline.ts` |
| anchor | a jump target on the delay axis: race start, a lap change | `apps/web/src/live/anchors.ts` |
| seam | an interface that lets one component serve two sources: the board seam, the time-target seam | `apps/web/src/board/useBoardState.ts`, `apps/web/src/transport/TimeTarget.ts` |
| alignment | the client-side estimate of the viewer's broadcast delay, from OCR of the lap counter | `apps/web/src/align/` |
| release | a push of `main` to the `release` branch; the only thing that deploys | `.claude/skills/release/SKILL.md` |
