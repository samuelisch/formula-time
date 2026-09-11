// Static `circuit_key` -> total race laps map, keyed by `circuit_key`; an
// unknown `circuit_key` maps to `null`.
//
// OpenF1's `circuit_key` is not documented as a fixed public table, so rather
// than guess ids from memory this only fills entries verified against a real
// OpenF1 session payload already captured in this repo (POC live recordings)
// or the `sessions` endpoint, and the lap count for each is the scheduled
// race distance from an official source (formula1.com), never a figure
// recalled from memory — a source citation and retrieval date sit beside
// every entry. Everything else is left out and resolves to `null` at the
// call site.
export const CIRCUITS: Record<number, { name: string; totalLaps: number }> = {
  // 2026 Bahrain GP (session_key 11261, cancelled, but still on the
  // calendar as a circuit_key seen in production): circuit_key 63, "Sakhir".
  // Official race distance: formula1.com circuit info page
  // https://www.formula1.com/en/information/bahrain-bahrain-international-circuit-sakhir.2CaIdaOTCgQ3Yfnb37NmSS
  // ("Number of laps: 57"), retrieved 2026-09-11.
  63: { name: "Sakhir", totalLaps: 57 },
  // 2026 Saudi Arabian GP (session_key 11269, cancelled, but still on the
  // calendar as a circuit_key seen in production): circuit_key 149, "Jeddah".
  // Official race distance: formula1.com race hub page
  // https://www.formula1.com/en/racing/2025/saudi-arabia ("Number of Laps: 50"),
  // retrieved 2026-09-11.
  149: { name: "Jeddah", totalLaps: 50 },
  // 2026 Spanish GP at Madring (session 11369, circuit_key 153) — Sunday
  // 2026-09-13's race. Official race distance: formula1.com circuit guide
  // https://www.formula1.com/en/latest/article/circuit-guide-everything-you-need-to-know-about-the-madring.NF7Mh3iag3w9GUPlihwJA
  // ("the Spanish Grand Prix at Madring will consist of 57 laps"),
  // retrieved 2026-09-11.
  153: { name: "Madring", totalLaps: 57 },
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
