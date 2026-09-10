// Whether the rehearse-race recording these e2e tests drip is present.
// CI unpacks a release asset to this exact path before running; a local
// checkout needs its own copy (see scripts/e2e-stack.sh and the
// rehearse-race skill). A spec skips rather than fails when it is absent
// (retro rule: fixture-gated), so `pnpm test:e2e` still passes for anyone
// without the recording on disk.
import { existsSync } from "node:fs";

export const RECORDING_PRESENT = existsSync("recordings/11361");
