// Whether the rehearse-race recording these e2e tests drip is present.
// The fixture is a committed slice (apps/web/e2e/fixtures/11361-slice),
// so this is always true in a normal checkout; the check stays only as a
// guard against a broken or partial checkout, where a spec skips rather
// than fails (retro rule: fixture-gated), so `pnpm test:e2e` still passes.
import { existsSync } from "node:fs";

export const RECORDING_PRESENT = existsSync("apps/web/e2e/fixtures/11361-slice");
