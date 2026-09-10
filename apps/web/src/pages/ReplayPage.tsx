// `/races/:session_key` (ADR-0009 §5): fetches the export file, folds it in
// the browser with the shared reducer, and plays it back on the same
// timing board through `BoardSourceProvider`. No server-side replay
// session -- the browser owns playback entirely.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";

import { AlignPanel } from "../align/AlignPanel.tsx";
import { useHeaderStore } from "../app/headerStore.ts";
import { Board } from "../board/Board.tsx";
import { DriverPanel } from "../board/DriverPanel.tsx";
import { BoardSourceProvider } from "../board/useBoardState.ts";
import { Card } from "../components/Card.tsx";
import { stringField } from "../lib/format.ts";
import { fetchRaceFile, fetchRaceIndex } from "../races/api.ts";
import { foldRace } from "../replay/foldRace.ts";
import { useReplayPlayback } from "../replay/useReplayPlayback.ts";
import { jumpToRaceStart } from "../transport/raceStart.ts";
import { TimeTargetProvider, type TimeTarget } from "../transport/TimeTarget.ts";
import { TransportBar } from "../transport/TransportBar.tsx";
import { useReplayTimeTarget } from "../transport/useReplayTimeTarget.ts";
import styles from "./ReplayPage.module.css";

export function ReplayPage() {
  const params = useParams<{ session_key: string }>();
  const sessionKey = params.session_key === undefined ? NaN : Number(params.session_key);
  const validKey = Number.isFinite(sessionKey);

  // Shared with the chooser (`RacesPage`) so both read the same cached
  // index instead of fetching it twice. The matching entry's `exported_at`
  // is this race's file version: it
  // goes into the file query's key and its URL, so a re-export (a new
  // `exported_at`) fetches a fresh file instead of the browser's cached
  // immutable response for the old one.
  const racesQuery = useQuery({
    queryKey: ["races"],
    queryFn: fetchRaceIndex,
  });
  const raceEntry = racesQuery.data?.find((entry) => entry.session_key === sessionKey) ?? null;
  const indexReady = racesQuery.data !== undefined;

  const fileQuery = useQuery({
    queryKey: ["race-file", sessionKey, raceEntry?.exported_at],
    // `staleTime: Infinity`: a given version of the file is immutable
    // (etag'd, `cache-control: immutable`); a new version is a new query
    // key above, not a refetch of this one.
    staleTime: Infinity,
    enabled: validKey && raceEntry !== null,
    queryFn: () => fetchRaceFile(sessionKey, raceEntry!.exported_at),
  });

  const foldQuery = useQuery({
    queryKey: ["race-fold", sessionKey, fileQuery.data?.exported_at],
    staleTime: Infinity,
    enabled: fileQuery.data !== undefined,
    queryFn: () => foldRace(fileQuery.data!.events, fileQuery.data!.session),
  });

  const playback = useReplayPlayback(foldQuery.data ?? null);
  const target = useReplayTimeTarget(playback, foldQuery.data ?? null);

  // The start notice's dismissal: sticky for the life of the page once the
  // viewer has started or seeked playback themselves, regardless of where
  // that lands them -- so it never reappears on a later rewind before
  // lights-out. A wrapper `TimeTarget` sets it inside `seekTo`/`nudge`/
  // `playback().play` before delegating to the real target, so the bar and
  // the notice's own link share the one flag without either duplicating the
  // other's logic.
  const [dismissed, setDismissed] = useState(false);
  const targetWithDismissal = useMemo<TimeTarget>(
    () => ({
      ...target,
      seekTo: (atMs) => {
        setDismissed(true);
        target.seekTo(atMs);
      },
      nudge: (deltaMs) => {
        setDismissed(true);
        target.nudge(deltaMs);
      },
      playback: () => {
        const inner = target.playback();
        if (inner === null) return null;
        return {
          ...inner,
          play: () => {
            setDismissed(true);
            inner.play();
          },
        };
      },
    }),
    [target],
  );

  const setHeaderOverride = useHeaderStore((state) => state.setOverride);
  const country = foldQuery.data === undefined ? null : stringField(foldQuery.data.session, "country");
  const name = foldQuery.data === undefined ? null : stringField(foldQuery.data.session, "name");
  useEffect(() => {
    if (country === null || name === null) return;
    setHeaderOverride(`${country} · ${name} · replay`);
    return () => setHeaderOverride(null);
  }, [country, name, setHeaderOverride]);

  if (!validKey) {
    return <Card>Not a valid race.</Card>;
  }

  // No entry for this session in the index -- no export yet, or the index
  // itself failed to load -- means there is no known version to request the
  // file with, so the file is never fetched at all. Retrying re-fetches the
  // index rather than guessing a version.
  if (racesQuery.isError || (indexReady && raceEntry === null)) {
    return (
      <Card>
        Could not load this race.{" "}
        <button type="button" onClick={() => void racesQuery.refetch()}>
          Retry
        </button>
      </Card>
    );
  }

  if (fileQuery.isError) {
    return <Card>Could not load this race.</Card>;
  }

  if (foldQuery.isError) {
    return <Card>Could not fold this race.</Card>;
  }

  if (foldQuery.data === undefined) {
    return <Card>Loading race…</Card>;
  }

  // The replay always opens at the recording's first row, which can sit
  // well before lights-out -- this notice
  // tells the viewer where the race actually starts instead of leaving them
  // to find "Race start" on their own. It shows only before lights-out, only
  // when there is a lights-out anchor to jump to, and only until the viewer
  // has started or seeked playback themselves (`dismissed`).
  const anchors = targetWithDismissal.anchors();
  const lightsOutMs = anchors.lights_out === null ? null : Date.parse(anchors.lights_out);
  const displayedAtMs = targetWithDismissal.displayedAt();
  const showStartNotice = !dismissed && lightsOutMs !== null && displayedAtMs !== null && displayedAtMs < lightsOutMs;
  const startNoticeMinutes =
    lightsOutMs === null || foldQuery.data.firstSourceMs === null
      ? null
      : Math.round((lightsOutMs - foldQuery.data.firstSourceMs) / 60_000);

  return (
    <div className={styles.replay}>
      {showStartNotice && startNoticeMinutes !== null && (
        <div className={styles.startNotice}>
          This replay starts {startNoticeMinutes} min before lights out.{" "}
          <button type="button" className={styles.startNoticeLink} onClick={() => jumpToRaceStart(targetWithDismissal)}>
            Jump to race start
          </button>
        </div>
      )}
      {/* The pure `Board`, never `BoardPage`: the live route's furniture
          (the finished/upcoming banner and polls) reads the live session
          and must not appear on a replay. The banner in particular would
          always fire here -- the exporter only exports finished sessions --
          and link the replay back to itself. No polls button in `controls`.
          `AlignPanel` mounts here too: `useAligner` reads through
          `useTimeTarget()`/the board-source seam instead of the live store
          directly, so it lines the replay up with a broadcast the same way
          the live board does. */}
      <BoardSourceProvider push={playback.push}>
        <TimeTargetProvider value={targetWithDismissal}>
          <Board controls={<AlignPanel />} transport={<TransportBar />} side={<DriverPanel />} />
        </TimeTargetProvider>
      </BoardSourceProvider>
    </div>
  );
}
