// Ingest service: the ONLY process that talks to OpenF1 (ADR-0001 §1).
// Two lanes (REST, MQTT) → one queue → one connection → events table.
// This is the entrypoint; the lanes and writer land with their tracks.
import { DOMAIN_PACKAGE } from "@formula-time/domain";

console.log(`ingest starting (domain: ${DOMAIN_PACKAGE})`);

// Must not exit: the process stays alive without the lanes' own vars until
// the owner sets them on the `ingest` service. The lanes and writer land
// with their own tracks.
const idleTimer = setInterval(() => {
  console.log("ingest idle");
}, 60_000);

process.on("SIGTERM", () => {
  clearInterval(idleTimer);
  process.exit(0);
});
