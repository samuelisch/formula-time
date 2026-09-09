// `/races/:session_key` (ADR-0009 §5, issue #57): fetches the export file,
// folds it in the browser with the shared reducer, and plays it back on the
// same timing board through `BoardSourceProvider`. No server-side replay
// session -- the browser owns playback entirely.
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";

import { Board } from "../board/Board.tsx";
import { DriverPanel } from "../board/DriverPanel.tsx";
import { BoardSourceProvider } from "../board/useBoardState.ts";
import { Card } from "../components/Card.tsx";
import { fetchRaceFile } from "../races/api.ts";
import { foldRace } from "../replay/foldRace.ts";
import { useReplayPlayback } from "../replay/useReplayPlayback.ts";
import { TimeTargetProvider } from "../transport/TimeTarget.ts";
import { TransportBar } from "../transport/TransportBar.tsx";
import { useReplayTimeTarget } from "../transport/useReplayTimeTarget.ts";
import styles from "./ReplayPage.module.css";

export function ReplayPage() {
  const params = useParams<{ session_key: string }>();
  const sessionKey = params.session_key === undefined ? NaN : Number(params.session_key);
  const validKey = Number.isFinite(sessionKey);

  const fileQuery = useQuery({
    queryKey: ["race-file", sessionKey],
    // `staleTime: Infinity`: the file is immutable (etag'd, `cache-control: immutable`).
    staleTime: Infinity,
    enabled: validKey,
    queryFn: () => fetchRaceFile(sessionKey),
  });

  const foldQuery = useQuery({
    queryKey: ["race-fold", sessionKey, fileQuery.data?.exported_at],
    staleTime: Infinity,
    enabled: fileQuery.data !== undefined,
    queryFn: () => foldRace(fileQuery.data!.events, fileQuery.data!.session),
  });

  const playback = useReplayPlayback(foldQuery.data ?? null);
  const target = useReplayTimeTarget(playback, foldQuery.data ?? null);

  if (!validKey) {
    return <Card>Not a valid race.</Card>;
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

  return (
    <div className={styles.replay}>
      {/* The pure `Board`, never `BoardPage`: the live route's furniture
          (the finished/upcoming banner, polls, delay and align controls) all
          read the live session and must not appear on a replay. The banner
          in particular would always fire here -- the exporter only exports
          finished sessions -- and link the replay back to itself. No
          `controls`: a replay has none of the live route's row-1 buttons. */}
      <BoardSourceProvider push={playback.push}>
        <Board
          transport={
            <TimeTargetProvider value={target}>
              <TransportBar />
            </TimeTargetProvider>
          }
          side={<DriverPanel />}
        />
      </BoardSourceProvider>
    </div>
  );
}
