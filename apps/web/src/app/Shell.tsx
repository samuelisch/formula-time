import type { RawRecord } from "@formula-time/domain";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { DelayControl } from "../align/DelayControl.tsx";
import { Pill, type PillTone } from "../components/Pill.tsx";
import { useCatchingUp, useConnection, useLastMessageAt, useSessionMeta } from "../live/selectors.ts";
import { useLiveStream } from "../live/useLiveStream.ts";
import { stringField } from "../lib/format.ts";
import styles from "./Shell.module.css";

// A stoppage must read as a quiet feed, never a frozen app (POC quiet-feed rule).
const QUIET_AFTER_MS = 5_000;

// The issue's literal format is "{country_name} · {circuit_short_name}", the
// raw OpenF1 field names. The wire never carries those: the projector's
// sessionAsRawRecord() (apps/api/src/projector/projector.ts) puts the
// sessions table's own columns on the wire instead -- `country` (not
// `country_name`) and `name` (the session name, e.g. "Race"; there is no
// persisted circuit display name at all). Render from the real fields
// (owner-vetoable, flagged in the PR).
function sessionLine(session: RawRecord | null): string {
  if (session === null) return "Waiting for a session";
  const country = stringField(session, "country");
  const name = stringField(session, "name");
  if (country === null || name === null) return "Waiting for a session";
  return `${country} · ${name}`;
}

function pillState(
  connection: ReturnType<typeof useConnection>,
  catchingUp: boolean,
  lastMessageAt: number | null,
  now: number,
): { text: string; tone: PillTone } {
  if (connection === "connecting") return { text: "connecting…", tone: "neutral" };
  if (connection === "reconnecting") return { text: "Live · reconnecting…", tone: "warn" };

  if (catchingUp) return { text: "Live · catching up", tone: "live" };

  if (lastMessageAt !== null) {
    const quietSeconds = Math.floor((now - lastMessageAt) / 1000);
    if (now - lastMessageAt >= QUIET_AFTER_MS) {
      return { text: `Live · last update ${quietSeconds}s ago`, tone: "live" };
    }
  }

  return { text: "Live · connected", tone: "live" };
}

export function Shell() {
  useLiveStream();

  const connection = useConnection();
  const catchingUp = useCatchingUp();
  const lastMessageAt = useLastMessageAt();
  const { session } = useSessionMeta();

  // Ticks once a second so the "last update Ns ago" pill keeps advancing
  // even when no new push arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const pill = pillState(connection, catchingUp, lastMessageAt, now);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>FormulaTime</h1>
        <span className={styles.session}>{sessionLine(session)}</span>
        <nav className={styles.nav}>
          <NavLink to="/" end>
            Races
          </NavLink>
          <NavLink to="/live">Live</NavLink>
          <NavLink to="/polls">Polls</NavLink>
        </nav>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </header>
      {/* #48 (the board issue) adds a `toolbar` slot to BoardPage; once it
          merges, DelayControl moves there instead of sitting under the
          header for every page. */}
      <DelayControl />
      <main className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>Timing data by OpenF1. Not affiliated with Formula 1.</footer>
    </div>
  );
}
