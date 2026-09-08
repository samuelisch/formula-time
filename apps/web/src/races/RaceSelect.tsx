// Reusable race picker (issue #80; also meant for the chooser -- RacesPage
// -- later). Lists the current session first (labelled with its status),
// then the historical races from `GET /api/races`, newest first as served,
// deduplicated against the current session's key.
import type { SessionStatusValue } from "../live/selectors.ts";
import type { RaceIndexEntry } from "./api.ts";
import styles from "./RaceSelect.module.css";

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

  return (
    <select id={id} aria-label="Select race" className={styles.select} value={value} onChange={(event) => onChange(event.target.value)}>
      {current !== null ? (
        <option value={current.sessionKey}>
          {current.label}
          {current.status !== null ? ` — ${STATUS_LABEL[current.status]}` : ""}
        </option>
      ) : null}
      {historicalRaces.map((race) => (
        <option key={race.session_key} value={String(race.session_key)}>
          {race.country} · {race.name}
        </option>
      ))}
    </select>
  );
}
