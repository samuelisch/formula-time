import { describe, expect, it } from "vitest";
import { CIRCUITS, totalLapsForCircuit } from "./circuits.js";

// Every 2026 race session's circuit_key seen in production
// (`GET https://api.openf1.org/v1/sessions?year=2026&session_name=Race`,
// fetched 2026-09-11), excluding circuit_key 12 (session 11731), which is
// deliberately left out of CIRCUITS as an unresolved data anomaly.
const CIRCUIT_KEYS_2026_RACE_SESSIONS = [
  10, // Australia (Melbourne)
  49, // China (Shanghai)
  46, // Japan (Suzuka)
  63, // Bahrain (Sakhir)
  149, // Saudi Arabia (Jeddah)
  151, // United States (Miami)
  23, // Canada (Montreal)
  22, // Monaco (Monte Carlo)
  15, // Spain (Barcelona-Catalunya)
  19, // Austria (Spielberg)
  2, // United Kingdom (Silverstone)
  7, // Belgium (Spa-Francorchamps)
  4, // Hungary (Hungaroring)
  55, // Netherlands (Zandvoort)
  39, // Italy (Monza)
  153, // Spain (Madring)
  144, // Azerbaijan (Baku)
  61, // Singapore
  9, // United States (Austin)
  65, // Mexico (Mexico City)
  14, // Brazil (Interlagos)
  152, // United States (Las Vegas)
  150, // Qatar (Lusail)
  70, // United Arab Emirates (Yas Marina Circuit)
];

describe("totalLapsForCircuit", () => {
  it.each(CIRCUIT_KEYS_2026_RACE_SESSIONS)(
    "resolves circuit_key %i to a positive lap count",
    (circuitKey) => {
      expect(CIRCUITS[circuitKey]).toBeDefined();
      const laps = totalLapsForCircuit(circuitKey);
      expect(laps).not.toBeNull();
      expect(laps).toBeGreaterThan(0);
    },
  );

  it("returns null for an unknown circuit_key", () => {
    expect(totalLapsForCircuit(999999)).toBeNull();
  });
});
