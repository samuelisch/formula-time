// The transport bar's position slider (issue #81 PR 2): a native range
// input with lap ticks drawn as a track overlay, a snap "resistance" near
// each tick, and a tooltip showing the current lap above the thumb. Shared
// by both `TimeTarget` implementations -- `TransportBar` builds `ticks` from
// `target.anchors().laps` and passes it the same way for live and replay.
// The snap/label math lives in `sliderMath.ts`, unit tested on its own.
import type { ChangeEvent } from "react";

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
  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const raw = Number(event.target.value);
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
      />
    </div>
  );
}
