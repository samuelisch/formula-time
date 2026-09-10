// Static `circuit_key` -> total race laps map, keyed by `circuit_key`; an
// unknown `circuit_key` maps to `null`.
//
// OpenF1's `circuit_key` is not documented as a fixed public table, so rather
// than guess ids from memory this only fills entries verified against a real
// OpenF1 session payload already captured in this repo (POC live recordings)
// — everything else is left out and resolves to `null` at the call site.
export const CIRCUITS: Record<number, { name: string; totalLaps: number }> = {
  // 2026 Italian GP: poc/live-logs/11361/session.json ("circuit_key": 39,
  // "circuit_short_name": "Monza"). Race distance unchanged since 2020: 53 laps.
  39: { name: "Monza", totalLaps: 53 },
  // 2026 Dutch GP: poc/live-logs/11353/session.json ("circuit_key": 55,
  // "circuit_short_name": "Zandvoort"). Race distance: 72 laps.
  55: { name: "Zandvoort", totalLaps: 72 },
};

export function totalLapsForCircuit(circuitKey: number): number | null {
  return CIRCUITS[circuitKey]?.totalLaps ?? null;
}
