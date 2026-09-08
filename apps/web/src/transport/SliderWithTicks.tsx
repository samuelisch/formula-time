// The transport bar's position slider (issue #81 PR 2): a native range
// input with lap ticks drawn as a track overlay, a snap "resistance" near
// each tick, and a tooltip showing the current lap above the thumb. Shared
// by both `TimeTarget` implementations -- `TransportBar` builds `ticks` from
// `target.anchors().laps` and passes it the same way for live and replay.
// The snap/label math lives in `sliderMath.ts`, unit tested on its own.
//
// Snap only applies to a pointer drag (fix round 1, PR #106): the native
// `step` (100ms) also fires a `change` event on every arrow-key press, and
// snapping unconditionally there could pull a keyboard step onto a tick
// that is not on the 100ms grid, making the control appear stuck. A
// `pointerdown`/`pointerup`/`pointercancel` pair on the input tracks
// whether the current `change` came from a drag; keyboard and programmatic
// changes pass the raw stepped value straight through.
import { useState, type ChangeEvent } from "react";

import { currentLap, percent, snapTarget, type TickMark } from "./sliderMath.ts";
import styles from "./SliderWithTicks.module.css";

export type { TickMark } from "./sliderMath.ts";

const LABEL_EVERY = 5;

export interface SliderWithTicksProps {
  min: number;
  max: number;
  value: number;
  ticks: TickMark[];
  disabled?: boolean;
  ariaLabel: string;
  onChange(value: number): void;
}

export function SliderWithTicks({ min, max, value, ticks, disabled = false, ariaLabel, onChange }: SliderWithTicksProps) {
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

  const lap = currentLap(value, ticks);

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
      />
    </div>
  );
}
