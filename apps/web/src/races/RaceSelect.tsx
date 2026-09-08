// Reusable race picker (issue #80; also meant for the chooser -- RacesPage
// -- later). Lists the current session first (labelled with its status),
// then the historical races from `GET /api/races`, newest first as served,
// deduplicated against the current session's key.
//
// `current === null` means "no session has been confirmed yet" (fix round
// 2 on PR #85's review): this still renders a leading, disabled placeholder
// entry rather than silently letting the browser's native <select> fallback
// pick the first *historical* race as visually selected. A caller (e.g.
// PollsPage) must never treat "no current session known yet" as license to
// show a different, unrelated race's data -- that was the actual bug this
// placeholder exists to make impossible to reintroduce: if the dropdown can
// only ever show a historical race as selected when its `value` explicitly
// names one, the caller's content and the selector can't drift apart.
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
      ) : (
        <option value="" disabled>
          Current session
        </option>
      )}
      {historicalRaces.map((race) => (
        <option key={race.session_key} value={String(race.session_key)}>
          {race.country} · {race.name}
        </option>
      ))}
    </select>
  );
}
