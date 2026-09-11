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
  // 2026 Australian GP (session_key 11234, circuit_key 10, "Melbourne").
  // Official race distance: https://www.formula1.com/en/racing/2026/australia
  // ("Number of Laps: 58"), retrieved 2026-09-11.
  10: { name: "Melbourne", totalLaps: 58 },
  // 2026 Chinese GP (session_key 11245, circuit_key 49, "Shanghai").
  // Official race distance: https://www.formula1.com/en/racing/2026/china
  // ("Number of Laps: 56"), retrieved 2026-09-11.
  49: { name: "Shanghai", totalLaps: 56 },
  // 2026 Japanese GP (session_key 11253, circuit_key 46, "Suzuka").
  // Official race distance: https://www.formula1.com/en/racing/2026/japan
  // ("Number of Laps: 53"), retrieved 2026-09-11.
  46: { name: "Suzuka", totalLaps: 53 },
  // 2026 Miami GP (session_key 11280, circuit_key 151, "Miami").
  // Official race distance: https://www.formula1.com/en/racing/2026/miami
  // ("Number of Laps: 57"), retrieved 2026-09-11.
  151: { name: "Miami", totalLaps: 57 },
  // 2026 Canadian GP (session_key 11291, circuit_key 23, "Montreal").
  // Official race distance: https://www.formula1.com/en/racing/2026/canada
  // ("Number of Laps: 70"), retrieved 2026-09-11. The data cross-check
  // (max lap seen in the fetched race) is 68, lower than the scheduled
  // distance — the table holds the scheduled figure, not the measured one.
  23: { name: "Montreal", totalLaps: 70 },
  // 2026 Monaco GP (session_key 11299, circuit_key 22, "Monte Carlo").
  // Official race distance: https://www.formula1.com/en/racing/2026/monaco
  // ("Number of Laps: 78"), retrieved 2026-09-11.
  22: { name: "Monte Carlo", totalLaps: 78 },
  // 2026 Barcelona-Catalunya GP (session_key 11307, circuit_key 15,
  // "Catalunya") — no longer named "Spanish Grand Prix" from 2026, that
  // name moved to Madring (circuit_key 153, above). Official race
  // distance: https://www.formula1.com/en/racing/2026/barcelona-catalunya
  // ("Number of Laps: 66"), retrieved 2026-09-11.
  15: { name: "Catalunya", totalLaps: 66 },
  // 2026 Austrian GP (session_key 11315, circuit_key 19, "Spielberg").
  // Official race distance: https://www.formula1.com/en/racing/2026/austria
  // ("Number of Laps: 71"), retrieved 2026-09-11.
  19: { name: "Spielberg", totalLaps: 71 },
  // 2026 British GP (session_key 11326, circuit_key 2, "Silverstone").
  // Official race distance:
  // https://www.formula1.com/en/racing/2026/great-britain
  // ("Number of Laps: 52"), retrieved 2026-09-11.
  2: { name: "Silverstone", totalLaps: 52 },
  // 2026 Belgian GP (session_key 11334, circuit_key 7, "Spa-Francorchamps").
  // Official race distance: https://www.formula1.com/en/racing/2026/belgium
  // ("Number of Laps: 44"), retrieved 2026-09-11. The data cross-check
  // (max lap seen in the fetched race) is 45, higher than the scheduled
  // distance — the table holds the scheduled figure, not the measured one.
  7: { name: "Spa-Francorchamps", totalLaps: 44 },
  // 2026 Hungarian GP (session_key 11342, circuit_key 4, "Hungaroring").
  // Official race distance: https://www.formula1.com/en/racing/2026/hungary
  // ("Number of Laps: 70"), retrieved 2026-09-11.
  4: { name: "Hungaroring", totalLaps: 70 },
};

export function totalLapsForCircuit(circuitKey: number): number | null {
  return CIRCUITS[circuitKey]?.totalLaps ?? null;
}
