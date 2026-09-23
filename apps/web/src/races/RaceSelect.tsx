// Reusable race picker. Lists the current session first (labelled with
// its status), then the historical races from `GET /api/races`, newest
// first as served, deduplicated against the current session's key.
// `current === null` renders a leading, disabled placeholder rather than
// letting the native <select> fallback show a historical race as selected.
// See README: Polls.
import type { SessionStatusValue } from "../live/selectors.ts";
import { excludeSession, raceTitleDisambiguated } from "../lib/format.ts";
import type { RaceIndexEntry } from "./api.ts";
import styles from "./RaceSelect.module.css";

/** `raceTitleDisambiguated` for each race against the rest of the list
 * (never itself), so two rounds sharing a meeting name (e.g. two years of
 * the same Grand Prix) still read as distinct options. */
function optionLabels(races: RaceIndexEntry[]): Map<number, string> {
  const labels = new Map<number, string>();
  for (const race of races) {
    labels.set(race.session_key, raceTitleDisambiguated(race, excludeSession(races, race.session_key)));
  }
  return labels;
}

export interface RaceSelectCurrent {
  sessionKey: string;
  label: string;
  status: SessionStatusValue | null;
}

export interface RaceSelectProps {
  /** The live/current session, already labelled by the caller; null when no session has been seen yet. */
  current: RaceSelectCurrent | null;
  /** `GET /api/races`, newest first as served -- not re-sorted here. */
  races: RaceIndexEntry[];
  /** The selected session_key, as a string (URL param form). */
  value: string;
  onChange: (sessionKey: string) => void;
  id?: string;
}

const STATUS_LABEL: Record<SessionStatusValue, string> = {
  live: "Live now",
  upcoming: "Upcoming",
  finished: "Finished",
};

export function RaceSelect({ current, races, value, onChange, id }: RaceSelectProps) {
  const historicalRaces = races.filter((race) => String(race.session_key) !== current?.sessionKey);
  const labels = optionLabels(historicalRaces);

  return (
    <select id={id} aria-label="Select race" className={styles.select} value={value} onChange={(event) => onChange(event.target.value)}>
      {current !== null ? (
        <option value={current.sessionKey}>
          {current.label}
          {current.status !== null ? ` — ${STATUS_LABEL[current.status]}` : ""}
        </option>
      ) : (
        <option value="" disabled>
          Current session
        </option>
      )}
      {historicalRaces.map((race) => (
        <option key={race.session_key} value={String(race.session_key)}>
          {labels.get(race.session_key)}
        </option>
      ))}
    </select>
  );
}
