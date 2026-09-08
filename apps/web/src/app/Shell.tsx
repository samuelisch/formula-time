import type { RawRecord } from "@formula-time/domain";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { Pill, type PillTone } from "../components/Pill.tsx";
import {
  useCatchingUp,
  useConnection,
  useLastMessageAt,
  useSessionMeta,
  useSessionStatus,
  type SessionStatusValue,
} from "../live/selectors.ts";
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
function sessionLine(session: RawRecord | null, status: SessionStatusValue | null): string {
  if (session === null) return "Waiting for a session";
  const country = stringField(session, "country");
  const name = stringField(session, "name");
  if (country === null || name === null) return "Waiting for a session";
  const base = `${country} · ${name}`;
  if (status === "finished") return `${base} · finished`;
  if (status === "upcoming") return `${base} · upcoming`;
  return base;
}

function pillState(
  connection: ReturnType<typeof useConnection>,
  catchingUp: boolean,
  lastMessageAt: number | null,
  now: number,
  status: SessionStatusValue | null,
): { text: string; tone: PillTone } {
  if (connection === "connecting") return { text: "connecting…", tone: "neutral" };

  const live = status === "live";
  const prefix = live ? "Live" : "Connected";

  if (connection === "reconnecting") return { text: `${prefix} · reconnecting…`, tone: "warn" };

  if (catchingUp) return { text: `${prefix} · catching up`, tone: "live" };

  if (lastMessageAt !== null) {
    const quietSeconds = Math.floor((now - lastMessageAt) / 1000);
    if (now - lastMessageAt >= QUIET_AFTER_MS) {
      return { text: `${prefix} · last update ${quietSeconds}s ago`, tone: "live" };
    }
  }

  return { text: live ? "Live · connected" : "Connected", tone: "live" };
}

export function Shell() {
  useLiveStream();

  const connection = useConnection();
  const catchingUp = useCatchingUp();
  const lastMessageAt = useLastMessageAt();
  const { session } = useSessionMeta();
  const status = useSessionStatus();

  // Ticks once a second so the "last update Ns ago" pill keeps advancing
  // even when no new push arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const pill = pillState(connection, catchingUp, lastMessageAt, now, status);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>FormulaTime</h1>
        <span className={styles.session}>{sessionLine(session, status)}</span>
        <nav className={styles.nav}>
          <NavLink to="/" end>
            Races
          </NavLink>
          <NavLink to="/live">Live</NavLink>
          <NavLink to="/polls">Polls</NavLink>
        </nav>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </header>
      {/* DelayControl and AlignPanel used to sit here, under the header on
          every route -- the placement this comment always called temporary,
          pending the board's toolbar slot. They now mount in BoardPage's
          toolbar (issue #57 fix round 5): they act on the live store's push
          buffer, so on a replay route they were live controls sitting on top
          of a folded race. Alignment on a replay is #67. */}
      <main className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>Timing data by OpenF1. Not affiliated with Formula 1.</footer>
    </div>
  );
}
