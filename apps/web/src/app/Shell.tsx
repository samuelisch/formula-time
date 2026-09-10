import type { RawRecord } from "@formula-time/domain";
import { NavLink, Outlet } from "react-router";

import { useSessionMeta, useSessionStatus, type SessionStatusValue } from "../live/selectors.ts";
import { useLiveStream } from "../live/useLiveStream.ts";
import { stringField } from "../lib/format.ts";
import styles from "./Shell.module.css";

// The raw OpenF1 fields are "{country_name} · {circuit_short_name}", but the
// wire never carries those: the projector's sessionAsRawRecord()
// (apps/api/src/projector/projector.ts) puts the sessions table's own
// columns on the wire instead -- `country` (not `country_name`) and `name`
// (the session name, e.g. "Race"; there is no persisted circuit display
// name at all). Render from the real fields.
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

export function Shell() {
  useLiveStream();

  const { session } = useSessionMeta();
  const status = useSessionStatus();

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
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>Timing data by OpenF1. Not affiliated with Formula 1.</footer>
    </div>
  );
}
