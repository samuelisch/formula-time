-- Removes non-race sessions already written before ingest started filtering on session_name (issue #168); a row with events or polls is left in place.
DELETE FROM sessions s WHERE s.name <> 'Race' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_key = s.session_key) AND NOT EXISTS (SELECT 1 FROM polls p WHERE p.session_key = s.session_key);
