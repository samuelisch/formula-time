import { useEffect, useState } from "react";
import { apiFetch, apiUrl } from "./api.ts";
import "./App.css";

type Health = { ok: boolean; domain?: string } | null;
type Stream = "connecting" | "connected" | "reconnecting";

// Deploy-proof placeholder: shows the api is reachable and the SSE stream is
// open across origins. The board, polls and alignment come with #26.
export default function App() {
  const [health, setHealth] = useState<Health>(null);
  const [stream, setStream] = useState<Stream>("connecting");

  useEffect(() => {
    apiFetch("/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
  }, []);

  useEffect(() => {
    const es = new EventSource(apiUrl("/api/live/events"));
    es.onopen = () => setStream("connected");
    es.onerror = () => setStream("reconnecting");
    return () => es.close();
  }, []);

  return (
    <main className="status">
      <h1>FormulaTime</h1>
      <dl>
        <dt>api</dt>
        <dd>{health === null ? "…" : health.ok ? "ok" : "unreachable"}</dd>
        <dt>live stream</dt>
        <dd>{stream}</dd>
      </dl>
      <p className="credit">Timing data by OpenF1. Not affiliated with Formula 1.</p>
    </main>
  );
}
