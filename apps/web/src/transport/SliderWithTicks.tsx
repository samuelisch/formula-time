// The transport bar's position slider: a native range input with lap ticks
// drawn as a track overlay, a snap "resistance" near each tick, and a
// tooltip showing the current lap above the thumb. Shared by both
// `TimeTarget` implementations. The snap/label math lives in
// `sliderMath.ts`, unit tested on its own.
// See README: Transport slider.
import { useState, type ChangeEvent } from "react";

import { currentLap, percent, shouldLabelTick, snapTarget, type TickMark } from "./sliderMath.ts";
import styles from "./SliderWithTicks.module.css";

export type { TickMark } from "./sliderMath.ts";

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
            {shouldLabelTick(tick.lap, ticks.length) && <span className={styles.tickLabel}>{tick.lap}</span>}
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
