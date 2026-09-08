// The primary alignment control (PRD §4: manual delay is the stable path).
// Applies a personal offset (`delayMs`) against the live store's push
// buffer; auto-align (OCR, lights) is a later issue that plugs into the
// same `setDelayMs`.
import { useEffect, useState, type FormEvent } from "react";

import { useAnchors, useDelay } from "../live/selectors.ts";
import styles from "./DelayControl.module.css";

const NUDGE_MS = 1_000;
const BIG_NUDGE_MS = 10_000;

function formatSeconds(ms: number, decimals = 1): string {
  return (ms / 1000).toFixed(decimals);
}

/** Buffered delay control: nudge/slider/jump all funnel into `setDelayMs`. */
export function DelayControl() {
  const { delayMs, spanMs, bufferShort, setDelayMs } = useDelay();
  const anchors = useAnchors();
  const [lapInput, setLapInput] = useState("");
  const [jumpMessage, setJumpMessage] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "[") setDelayMs(Math.max(0, delayMs - NUDGE_MS));
      if (event.key === "]") setDelayMs(delayMs + NUDGE_MS);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [delayMs, setDelayMs]);

  function nudge(deltaMs: number): void {
    setDelayMs(Math.max(0, delayMs + deltaMs));
  }

  function clampToSpan(ms: number): number {
    return Math.min(Math.max(ms, 0), spanMs);
  }

  function jumpToSourceTime(sourceTime: string | null, label: string): void {
    if (sourceTime === null) {
      setJumpMessage(`${label} not seen since you joined`);
      return;
    }
    setJumpMessage(null);
    setDelayMs(clampToSpan(Date.now() - Date.parse(sourceTime)));
  }

  function handleLightsOut(): void {
    jumpToSourceTime(anchors.lights_out, "Lights out");
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
    jumpToSourceTime(found.source_time, `Lap ${lap}`);
  }

  return (
    <div className={styles.control} title="[ and ] nudge the delay by 1s">
      <div className={styles.row}>
        <span className={styles.value}>{formatSeconds(delayMs)}s</span>
        <button type="button" onClick={() => nudge(-BIG_NUDGE_MS)}>
          −10s
        </button>
        <button type="button" onClick={() => nudge(-NUDGE_MS)}>
          −1s
        </button>
        <button type="button" className={styles.live} onClick={() => setDelayMs(0)}>
          Live
        </button>
        <button type="button" onClick={() => nudge(NUDGE_MS)}>
          +1s
        </button>
        <button type="button" onClick={() => nudge(BIG_NUDGE_MS)}>
          +10s
        </button>
      </div>

      <input
        className={styles.slider}
        type="range"
        min={0}
        max={spanMs}
        step={100}
        value={Math.min(delayMs, spanMs)}
        disabled={spanMs === 0}
        aria-label="Delay"
        onChange={(event) => setDelayMs(Number(event.target.value))}
      />

      <div className={styles.meta}>Buffered: {formatSeconds(spanMs, 0)}s</div>
      {bufferShort && (
        <div className={styles.warning}>Delay exceeds what this tab has buffered; showing the oldest</div>
      )}

      <form className={styles.jump} onSubmit={handleGoToLap}>
        <button type="button" onClick={handleLightsOut}>
          Lights out
        </button>
        <input
          type="number"
          aria-label="Lap number"
          placeholder="Lap"
          value={lapInput}
          onChange={(event) => setLapInput(event.target.value)}
        />
        <button type="submit">Go</button>
      </form>
      {jumpMessage !== null && <div className={styles.warning}>{jumpMessage}</div>}
    </div>
  );
}
