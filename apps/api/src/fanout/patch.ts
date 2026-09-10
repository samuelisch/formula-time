// The JSON Patch implementation for RaceState lives in packages/domain
// (ADR-0013) so the browser client applying deltas and this service diffing
// them share one implementation. Re-exported here so nothing else in this
// service has to change its import path.
export type { JsonPatchOp } from "@formula-time/domain";
export { diffState, applyPatch } from "@formula-time/domain";
