// The shared transport bar: one control surface for both the live delay and
// replay playback, driven entirely through `useTimeTarget()` so it carries
// no platform-specific logic. Mounted by both `BoardPage` and `ReplayPage`
// inside a `TimeTargetProvider`, in the board's toolbar `transport` slot
// (`board/Board.tsx`).
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { clock } from "../lib/format.ts";
import { SliderWithTicks, type TickMark } from "./SliderWithTicks.tsx";
import { useTimeTarget } from "./TimeTarget.ts";
import styles from "./TransportBar.module.css";

const NUDGE_MS = 1_000;
const BIG_NUDGE_MS = 5_000;
const HUGE_NUDGE_MS = 10_000;

function formatSeconds(ms: number, decimals = 1): string {
  return (ms / 1000).toFixed(decimals);
}

export function TransportBar() {
  const target = useTimeTarget();
  const [lapInput, setLapInput] = useState("");
  const [jumpMessage, setJumpMessage] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const el = event.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (event.key === "[") target.nudge(-NUDGE_MS);
      if (event.key === "]") target.nudge(NUDGE_MS);
      if (event.key === ",") target.nudge(-BIG_NUDGE_MS);
      if (event.key === ".") target.nudge(BIG_NUDGE_MS);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target]);

  const range = target.range();
  const displayedAtMs = target.displayedAt();
  const playback = target.playback();
  const anchors = target.anchors();
  // A limitation of where the target actually landed, rendered under the
  // row in the same style as a failed jump: on live this is the store's
  // `bufferShort` ("showing the oldest"), on replay always null.
  const notice = target.notice();

  // All lap anchors as tick marks, unfiltered -- the current-lap tooltip's
  // lookup: a viewer's actual lap can have an anchor before `range.startMs`
  // (live's rolling buffer can open mid-lap), and the tooltip must still
  // find it even though that tick itself is never rendered (out of the
  // slider's own bounds).
  const allTicks = useMemo<TickMark[]>(
    () =>
      anchors.laps
        .map((anchor) => ({ lap: anchor.lap, value: Date.parse(anchor.source_time) }))
        .filter((tick) => Number.isFinite(tick.value)),
    [anchors],
  );

  // Each lap anchor within `range()`, so a tick never renders past the
  // slider's own bounds.
  const ticks = useMemo<TickMark[]>(() => {
    if (range === null) return [];
    return allTicks.filter((tick) => tick.value >= range.startMs && tick.value <= range.endMs);
  }, [allTicks, range]);

  /** Race-start and lap jumps move the position and, on replay, pause -- live has no playback to pause. */
  function seekAndMaybePause(atMs: number): void {
    target.seekTo(atMs);
    playback?.pause();
  }

  function handleRaceStart(): void {
    if (anchors.lights_out === null) {
      setJumpMessage("Race start not seen since you joined");
      return;
    }
    setJumpMessage(null);
    seekAndMaybePause(Date.parse(anchors.lights_out));
  }

  function handleGoToLap(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const lap = Number(lapInput);
    if (!Number.isFinite(lap)) return;
    const found = anchors.laps.find((anchor) => anchor.lap === lap);
    if (found === undefined) {
      setJumpMessage(`Lap ${lap} not seen since you joined`);
      return;
    }
    setJumpMessage(null);
    seekAndMaybePause(Date.parse(found.source_time));
  }

  // For both live and replay, `syncOffsetMs()` is the seam's own delay
  // reading, so the bar never derives it from `range()`/`displayedAt()`
  // itself: on replay it's relative to the un-nudged clock (0 for a fold
  // played straight through); on live it's the store's applied delay,
  // reading `0.0s` exactly when parked at the edge.
  const syncOffsetMs = target.syncOffsetMs();
  const positionLabel =
    playback === null
      ? syncOffsetMs === null
        ? "—"
        : target.rewindMode() === "timeline"
          ? `Rewound ${formatSeconds(syncOffsetMs)}s · from the log`
          : `${formatSeconds(syncOffsetMs)}s`
      : syncOffsetMs === null
        ? clock(displayedAtMs === null ? null : new Date(displayedAtMs).toISOString())
        : `${syncOffsetMs > 0 ? "+" : ""}${formatSeconds(syncOffsetMs)}s`;

  return (
    <div className={styles.transport} title="[ and ] nudge 1s, , and . nudge 5s">
      <div className={styles.row}>
        <button type="button" onClick={() => target.nudge(-HUGE_NUDGE_MS)}>
          −10s
        </button>
        <button type="button" onClick={() => target.nudge(-BIG_NUDGE_MS)}>
          −5s
        </button>

        {playback === null ? (
          <button
            type="button"
            className={styles.live}
            onClick={() => {
              // Fresh at click time, not the `range` captured at the last
              // render: `range().endMs` is `now()` when live, and time keeps
              // passing between a render and a click, so the render-scoped
              // `range` is stale by however long the viewer took to click --
              // using it here would set a nonzero delay instead of exactly 0.
              const freshRange = target.range();
              if (freshRange !== null) seekAndMaybePause(freshRange.endMs);
            }}
          >
            Live
          </button>
        ) : (
          <button type="button" onClick={playback.playing ? playback.pause : playback.play}>
            {playback.playing ? "Pause" : "Play"}
          </button>
        )}

        <button type="button" onClick={() => target.nudge(BIG_NUDGE_MS)}>
          +5s
        </button>
        <button type="button" onClick={() => target.nudge(HUGE_NUDGE_MS)}>
          +10s
        </button>

        <SliderWithTicks
          min={range?.startMs ?? 0}
          max={range?.endMs ?? 0}
          value={displayedAtMs ?? range?.startMs ?? 0}
          ticks={ticks}
          allTicks={allTicks}
          disabled={range === null || range.startMs === range.endMs}
          ariaLabel="Playback position"
          onChange={(value) => target.seekTo(value)}
        />

        <span className={styles.clock}>{positionLabel}</span>

        <button type="button" onClick={handleRaceStart}>
          Race start
        </button>

        <form className={styles.jump} onSubmit={handleGoToLap}>
          <input
            type="number"
            aria-label="Lap number"
            placeholder="Lap"
            value={lapInput}
            onChange={(event) => setLapInput(event.target.value)}
          />
          <button type="submit">Go</button>
        </form>
      </div>
      {notice !== null && <div className={styles.warning}>{notice}</div>}
      {jumpMessage !== null && <div className={styles.warning}>{jumpMessage}</div>}
    </div>
  );
}
