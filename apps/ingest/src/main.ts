// Ingest service: the ONLY process that talks to OpenF1 (ADR-0001 §1).
// Two lanes (REST, MQTT) → one queue → one connection → events table.
// This is the entrypoint; the lanes and writer land with their tracks.
import { DOMAIN_PACKAGE } from "@formula-time/domain";

console.log(`ingest starting (shared: ${DOMAIN_PACKAGE})`);
