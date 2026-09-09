// The transport bar's position slider: a native range input with lap ticks
// drawn as a track overlay, a snap "resistance" near each tick, and a
// tooltip showing the current lap above the thumb. Shared by both
// `TimeTarget` implementations -- `TransportBar` builds `ticks` from
// `target.anchors().laps` and passes it the same way for live and replay.
// The snap/label math lives in `sliderMath.ts`, unit tested on its own.
//
// Snap only applies to a pointer drag: the native `step` (100ms) also fires
// a `change` event on every arrow-key press, and snapping unconditionally
// there could pull a keyboard step onto a tick that is not on the 100ms
// grid, making the control appear stuck. A
// `pointerdown`/`pointerup`/`pointercancel`/`onLostPointerCapture`/`onBlur`
// set on the input tracks whether the current `change` came from a drag
// (the last two clear it if a drag is interrupted -- e.g. focus moves away
// mid-drag -- so it cannot leave a later keyboard step snapping); keyboard
// and programmatic changes pass the raw stepped value straight through.
//
// `ticks` (rendered tick marks) and `allTicks` are deliberately separate:
// `TransportBar` filters `ticks` to `range()` so a tick never renders past
// the slider's own bounds, but the current-lap tooltip must still find the
// viewer's actual lap even when that lap's own anchor sits before
// `range.startMs` (live's rolling buffer can open mid-lap) -- `allTicks` is
// the unfiltered list for that lookup only, defaulting to `ticks` when the
// caller has nothing more complete to give.
import { useState, type ChangeEvent } from "react";

import { currentLap, percent, snapTarget, type TickMark } from "./sliderMath.ts";
import styles from "./SliderWithTicks.module.css";

export type { TickMark } from "./sliderMath.ts";

const LABEL_EVERY = 5;

export interface SliderWithTicksProps {
  min: number;
  max: number;
  value: number;
  /** Rendered as tick marks -- the caller should already have filtered this to `range()`. */
  ticks: TickMark[];
  /** Used only for the current-lap tooltip lookup; unfiltered, so a lap whose anchor is outside `range()` is still found. Defaults to `ticks`. */
  allTicks?: TickMark[];
  disabled?: boolean;
  ariaLabel: string;
  onChange(value: number): void;
}

export function SliderWithTicks({
  min,
  max,
  value,
  ticks,
  allTicks,
  disabled = false,
  ariaLabel,
  onChange,
}: SliderWithTicksProps) {
  const [isDragging, setIsDragging] = useState(false);

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const raw = Number(event.target.value);
    if (!isDragging) {
      onChange(raw);
      return;
    }
    const snapped = snapTarget(raw, ticks, min, max);
    onChange(snapped !== null ? snapped.value : raw);
  }

  const lap = currentLap(value, allTicks ?? ticks);

  return (
    <div className={styles.wrapper}>
      {lap !== null && (
        <div className={styles.tooltip} style={{ left: `${percent(value, min, max)}%` }}>
          Lap {lap}
        </div>
      )}
      <div className={styles.track} aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick.lap} className={styles.tick} style={{ left: `${percent(tick.value, min, max)}%` }}>
            {tick.lap % LABEL_EVERY === 0 && <span className={styles.tickLabel}>{tick.lap}</span>}
          </span>
        ))}
      </div>
      <input
        className={styles.slider}
        type="range"
        min={min}
        max={max}
        step={100}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={handleChange}
        onPointerDown={() => setIsDragging(true)}
        onPointerUp={() => setIsDragging(false)}
        onPointerCancel={() => setIsDragging(false)}
        onLostPointerCapture={() => setIsDragging(false)}
        onBlur={() => setIsDragging(false)}
      />
    </div>
  );
}
