// @formula-time/domain runs in Node and in the browser.
// Rule (ADR-0002): nothing in this package may import a Node builtin module.
// tsconfig enforces it with `types: []` and `lib: ["ES2022"]`.

export const DOMAIN_PACKAGE = "@formula-time/domain";

export type { RawRecord, TimestampField, RaceEvent } from "./types.js";
export type { DriverState, RaceState } from "./race_state.js";
export { createInitialState, RaceStateReducer } from "./race_state.js";
export type { PollKind } from "./race_clock.js";
export { isChequered, leaderLap, locksAtLap } from "./race_clock.js";
