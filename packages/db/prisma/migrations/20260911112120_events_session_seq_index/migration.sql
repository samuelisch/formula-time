-- CreateIndex
-- CONCURRENTLY: this table is written continuously by ingest while live races
-- run, so the build must not hold the lock a plain CREATE INDEX takes.
CREATE INDEX CONCURRENTLY "events_session_key_seq_idx" ON "events"("session_key", "seq");
