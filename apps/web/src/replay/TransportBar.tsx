// The replay transport bar: play/pause, speed, the scrub slider (with lap
// markers as tick marks via a <datalist>), and "Race start". Dropped into
// BoardPage's `toolbar` slot, the same seam DelayControl uses for the live
// board (issue #57).
import { clock } from "../lib/format.ts";
import type { PlaybackSpeed } from "./playbackClock.ts";
import type { ReplayPlayback } from "./useReplayPlayback.ts";
import styles from "./TransportBar.module.css";

const SPEEDS: PlaybackSpeed[] = [1, 5, 20];

export interface TransportBarProps {
  playback: ReplayPlayback;
}

export function TransportBar({ playback }: TransportBarProps) {
  const { sourceMs, isPlaying, speed, startSourceMs, endSourceMs, lapMarkers, play, pause, setSpeed, seek, jumpToStart } =
    playback;

  return (
    <div className={styles.transport}>
      <button type="button" onClick={isPlaying ? pause : play}>
        {isPlaying ? "Pause" : "Play"}
      </button>

      <div className={styles.speeds} role="group" aria-label="Playback speed">
        {SPEEDS.map((option) => (
          <button
            key={option}
            type="button"
            className={option === speed ? styles.speedActive : undefined}
            aria-pressed={option === speed}
            onClick={() => setSpeed(option)}
          >
            {option}×
          </button>
        ))}
      </div>

      <input
        className={styles.slider}
        type="range"
        min={startSourceMs}
        max={endSourceMs}
        step={100}
        value={sourceMs}
        list="replay-lap-markers"
        aria-label="Playback position"
        onChange={(event) => seek(Number(event.target.value))}
      />
      <datalist id="replay-lap-markers">
        {lapMarkers.map((marker) => (
          <option key={marker.lap} value={marker.sourceMs} label={`Lap ${marker.lap}`} />
        ))}
      </datalist>

      <span className={styles.clock}>{clock(new Date(sourceMs).toISOString())}</span>

      <button type="button" onClick={jumpToStart}>
        Race start
      </button>
    </div>
  );
}
