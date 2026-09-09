// A collapsible card listing race-control messages newest first. Source:
// `race_control.recent_messages` (the reducer keeps the last 100 rows, each
// `{ event_id, payload }`; `payload` is the raw OpenF1 race_control row),
// read through the board seam (`useBoardRaceControl()`), so it is
// spoiler-safe on a delayed viewer and works on replay exactly as it does
// live.
import type { RawRecord } from "@formula-time/domain";

import { Card } from "../components/Card.tsx";
import { Collapsible } from "../components/Collapsible.tsx";
import { cx } from "../lib/classNames.ts";
import { clock, numberField, stringField } from "../lib/format.ts";
import { useBoardRaceControl } from "./useBoardState.ts";
import styles from "./RaceControlFeed.module.css";

export interface RaceControlFeedProps {
  /** Collapsed by default on live, expanded on replay -- the caller (`Board.tsx`) decides which via `useBoardIsReplay()`. */
  defaultOpen?: boolean;
}

// Only RED and YELLOW have a dedicated `--flag-*` variable; any other flag
// (BLUE, BLACK AND WHITE, CLEAR is never stored, ...) falls back to the
// amber used for safety-car rows so a flag row always shows a dot.
function dotColour(flag: string): string {
  if (flag === "RED") return "var(--flag-red)";
  if (flag === "YELLOW") return "var(--flag-yellow)";
  return "var(--flag-amber)";
}

function metaOf(payload: RawRecord): string | null {
  const parts: string[] = [];
  const flag = stringField(payload, "flag");
  const scope = stringField(payload, "scope");
  const sector = numberField(payload, "sector");
  if (flag !== null) {
    const scopeText = scope === null ? null : sector === null ? scope : `${scope} ${sector}`;
    parts.push(scopeText === null ? flag : `${flag} · ${scopeText}`);
  }
  const driverNumber = numberField(payload, "driver_number");
  if (driverNumber !== null) parts.push(`#${driverNumber}`);
  const lapNumber = numberField(payload, "lap_number");
  if (lapNumber !== null) parts.push(`Lap ${lapNumber}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function RaceControlFeed({ defaultOpen = false }: RaceControlFeedProps = {}) {
  const raceControl = useBoardRaceControl();
  const messages = raceControl.recent_messages;
  const count = messages.length;
  const lastPayload = count === 0 ? null : messages[count - 1]!.payload;
  const lastTime = lastPayload === null ? null : stringField(lastPayload, "date");
  const summary = count === 0 ? "Race control · 0 messages" : `Race control · ${count} messages · last ${clock(lastTime)}`;
  const newestFirst = [...messages].reverse();

  return (
    <Card>
      <Collapsible summary={summary} defaultOpen={defaultOpen}>
        {count === 0 ? (
          <p className={styles.empty}>No race-control messages yet</p>
        ) : (
          <ul className={styles.list}>
            {newestFirst.map(({ event_id, payload }) => {
              const flag = stringField(payload, "flag");
              const category = stringField(payload, "category");
              const meta = metaOf(payload);
              return (
                <li key={event_id} className={cx(styles.row, category === "SafetyCar" && styles.safetyCar)}>
                  <span className={styles.time}>{clock(stringField(payload, "date"))}</span>
                  <span className={styles.category}>
                    {flag !== null && <span className={styles.dot} style={{ background: dotColour(flag) }} aria-hidden="true" />}
                    {category ?? "—"}
                  </span>
                  <span className={styles.message}>{stringField(payload, "message") ?? "—"}</span>
                  {meta !== null && <span className={styles.meta}>{meta}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Collapsible>
    </Card>
  );
}
