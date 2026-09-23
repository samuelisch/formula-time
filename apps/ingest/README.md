# ingest

The only process that talks to OpenF1. Sole writer of the `sessions` and
`events` tables. Writes every row it queues to a jsonl recording.

## The pipeline

```mermaid
flowchart LR
  D[discovery<br/>sessions + meetings every 60 s] --> S[select the race<br/>30 min before start]
  S --> E[entry list<br/>drivers fetches]
  S --> R[REST rotation<br/>1.1 s / 2.2 s by tier]
  M[MQTT lane<br/>8 topics] --> N
  R --> N[normalise<br/>canonical timestamps · SHA-256 id · dedup]
  E --> N
  N --> Q[one queue] --> W[one writer<br/>batches of 100, seq = commit order] --> PG[(events)]
  N --> J[jsonl recording]
```

- **discovery** polls OpenF1's `sessions` and `meetings` endpoints every 60 s
  while nothing is live, and upserts every row it sees into `sessions`.
- **select the race** picks the race session whose live window has opened —
  30 minutes before its `date_start` — as the one session the REST rotation
  follows.
- **entry list** fetches the selected session's drivers, on its own schedule,
  independent of the rotation.
- **REST rotation** polls one endpoint per tick from a weighted list, at a
  cadence set by whether OpenF1 credentials are configured.
- **MQTT lane** subscribes to eight timing topics on the live broker and
  feeds the same pipeline as REST.
- **normalise** strips vendor fields, canonicalizes timestamps to epoch-ms,
  hashes each row to a stable id, and drops anything already seen — REST and
  MQTT twins of the same row produce the same id.
- **one queue** holds every normalized row from both lanes in arrival order.
- **one writer** drains the queue in batches of 100, so `seq` order equals
  commit order.
- **jsonl recording** is written at the same moment a row is queued, so the
  recording never drifts from what was written to Postgres.

## Rules

| Rule | Value | File |
|---|---|---|
| Live window | 30 min either side of `date_start`/`date_end` | `openf1/discovery.ts`, `writer/sessions.ts`: `LIVE_WINDOW_MS = 30 * 60 * 1000` |
| Race sessions only | `session_name === "Race"`, exact and case-sensitive | `writer/sessions.ts`: `isRaceSession` |
| Session status | `upcoming` before the window, `live` inside it, `finished` after | `writer/sessions.ts`: `computeSessionStatus` |
| REST tick by tier | 2,200 ms with no OpenF1 credentials, 1,100 ms with both `OPENF1_LOGIN` and `OPENF1_PASSWORD`; `REST_TICK_MS` overrides either | `config.ts`: `loadConfig` (`tierDefaultTickMs`, `restTickMs`) |
| Discovery cadence while idle | 60 s | `openf1/rest-lane.ts`: `this.discoveryIntervalMs = opts.discoveryIntervalMs ?? 60_000` |
| Rotation | 21-slot weighted list: `position` × 7, `intervals` × 7, `laps` × 2, `race_control` × 2, `weather` × 1, `pit` × 1, `stints` × 1 | `openf1/rest-lane.ts`: `POLL_ROTATION` |
| Queue cap | 200,000 rows; beyond it, `push`/`pushAll` drop the newest row and count it | `writer/queue.ts`: `DEFAULT_MAX_QUEUED = 200_000` |
| Writer batch | 100 rows every 250 ms; retry backoff 250 ms doubling to 30 s; on shutdown, give up after 3 consecutive failures of the same batch | `writer/writer.ts`: `DEFAULT_BATCH_SIZE = 100`, `run(intervalMs = 250)`, `BACKOFF_BASE_MS = 250`, `BACKOFF_MAX_MS = 30_000`, `MAX_CONSECUTIVE_FAILURES = 3` |
| Token refresh | 2 min before expiry | `openf1/auth.ts`: `REFRESH_MARGIN_MS = 2 * 60 * 1000` |
| MQTT | ADR-0001 §1: "named timing topics only, never `v1/#`; exactly one connection; re-subscribe on every `connect`". 8 topics; proactive reconnect every 50 min; reconnect backoff capped at 60 s; auth-rejection retry after 30 s; a payload whose own `session_key` disagrees with the selected session is dropped as foreign | `openf1/mqtt-lane.ts`, ADR-0001 §1: `MQTT_ENDPOINTS` (8 entries), `DEFAULT_REFRESH_INTERVAL_MS = 50 * 60_000`, `DEFAULT_MAX_BACKOFF_MS = 60_000`, `DEFAULT_AUTH_RETRY_DELAY_MS = 30_000`, `foreignSinceLog` |

The rotation counted from `POLL_ROTATION` on the branch matches the issue's
"hot endpoints appear most often" description; no row above was copied from
the issue text without checking it against this file.

## The entry list

| Fetch | When | Retry | Stops when | Fallback |
|---|---|---|---|---|
| Selection fetch | `drivers?session_key=` immediately at session selection | Every 5 min | ≥ 1 row returned | The static list, emitted once |
| Pre-race refresh | 5 min before `date_start`, same `session_key` fetch, once | Next tick, only if the fetch itself threw | Done after one successful attempt (a zero-row response still counts as done) | None |
| Friday fetch | `drivers?meeting_key=`, once the meeting's first session has started, only while that meeting's race session is known and its window hasn't closed | Every 30 min | ≥ 1 row returned | None |
| Budget rule | At most one drivers fetch per tick, taken before the rotation poll | — | — | — |
| Static list | `openf1/entry-list.ts`, season-bound (`ENTRY_LIST_2026`); logs its season once at startup | — | — | — |

Read from `openf1/entry-list-fetches.ts`: `trySelectionFetch`,
`tryPreRaceRefresh`, `checkFridayFetch`, `runFridayFetch`, `runDue`.
`runDue` tries the selection retry, then the pre-race refresh, then the
Friday fetch, and returns as soon as one of them makes a request —
`RestLane.pollOnce` (`openf1/rest-lane.ts`) spends the tick's one request
there before it ever reaches the rotation, so the budget rule above is what
the code does, not a summary of intent.

## Session upsert

Discovery upserts every `sessions` row it sees, keyed by `session_key`.
The row's Grand Prix name isn't on the session record itself — it lives on
OpenF1's `meetings` rows — so callers join it in via a `meetingNames` map
built separately: `SessionDiscovery` fetches `meetings?year=` once per
discovery tick, and the loader and `fetch-race` fetch
`meetings?meeting_key=` once per session. A `meeting_key` missing from
that map, or no fetch made at all, leaves `meetingName` null rather than
guessing.

A rerun must not blank out a naming column (`meetingName`,
`circuitShortName`, `location`) that an earlier run already found.
Prisma's `update` leaves a column untouched only when its key is absent
from the update object entirely — present and `null` sets it to null — so
the upsert omits those three keys, rather than setting them to `null`,
whenever the freshly computed value is `null`. That makes reruns
additive. `create` keeps a literal `null`, since a brand-new row
legitimately has no value yet.

`upsertSession` validates the row (`session_key`, `date_start`,
`date_end`) before writing: a malformed field throws before the database
call, so the caller (`SessionDiscovery.refreshSessions()`) can skip that
one row and keep upserting the rest, instead of one bad row stopping the
whole discovery tick.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none (required) | Postgres connection string; the process exits if unset |
| `OPENF1_LOGIN` | none | OpenF1 sponsor account login; also gates the MQTT default and the REST tier |
| `OPENF1_PASSWORD` | none | OpenF1 sponsor account password |
| `LIVE_SOURCE` | `api` | `api` talks to OpenF1 live; any other value is a directory path replaying a recording through the same queue |
| `LIVE_LOG_DIR` | `./live-logs` | Where the jsonl recording is written |
| `MQTT_ENABLED` | `true` when `OPENF1_LOGIN` is set, else `false` | Turns the MQTT lane on or off; explicit `true`/`false` overrides the default |
| `REST_TICK_MS` | tier default (2200 or 1100) | Overrides the REST rotation's tick interval; an invalid value falls back to the tier default and logs once |
| `LOG_LEVEL` | `info` | Read directly by the logger, not through `config.ts` |

## Commands

| Command | Does | Refuses |
|---|---|---|
| `pnpm ingest:load <recording-dir>...` | Loads a POC-shaped recording (`session.json`, `raw/<endpoint>.jsonl`) into Postgres through the same fetcher → normalizer → queue → writer path; `--replace` deletes and reloads a session already loaded | A session that is still inside its live window (the live service owns it); a non-race session |
| `pnpm ingest:fetch-race <session_key>...` | Pulls a finished historical session straight from OpenF1 and writes it through the same path, also saving it as a recording | Same live-window/non-race guard as `ingest:load`; an unknown `session_key` |
| `pnpm ingest:dump -- <session_key> [--out <dir>] [--force]` | Reads a session's `sessions` row and `events` rows back out of Postgres into the recording layout `ingest:load` reads | An unknown `session_key`; an `--out` directory already holding `polls.jsonl` unless `--force` is passed |
| `pnpm sim` | Drips a recording through the REST lane's file-fetcher path at a chosen speed, no network involved | An `--out-root` directory that already looks like a real recording (holds `polls.jsonl`) |

## What the log lines mean

| Line | Level | Meaning | Fields |
|---|---|---|---|
| `ingest: fatal error` | error | An unhandled rejection or uncaught exception was caught at the top level before this existed and would otherwise have printed a bare stack trace | `kind`, `reason` |
| `ingest: DATABASE_URL is not set; refusing to start ...` | error | Boot guard (ADR-0004): the process exits immediately | — |
| `ingest: REST_TICK_MS=... is invalid; using the tier default ...` | info | The `REST_TICK_MS` override didn't parse as a positive integer; the tier default is used instead | — |
| `ingest: OPENF1_LOGIN/OPENF1_PASSWORD not set; running unauthenticated ...` | info | No OpenF1 credentials; the process still starts, historical/unauthenticated use only | — |
| `ingest: LIVE_SOURCE=... — replaying a recording instead of OpenF1.` | info | `LIVE_SOURCE` names a directory, not `api`; the file fetcher is used instead of the network | — |
| `ingest: MQTT_ENABLED but no OpenF1 credentials/live source; MQTT lane not started.` | info | `MQTT_ENABLED` is true but there's nothing to authenticate or connect with | — |
| `ingest: started ...` | info | Boot complete: REST lane tick, whether MQTT is running, writer running | — |
| `ingest: last 60s` | info | One line per minute combining both lanes' and the writer's counters | `rest_polls`, `rest_rows`, `rest_errors`, `rest_unjoined`, `mqtt_messages`, `mqtt_rows`, `mqtt_dropped`, `mqtt_unjoined`, `mqtt_foreign`, `writer_inserted`, `writer_skipped`, `writer_failures`, `queue_depth`, `session_key` |
| `ingest: recording root ... is writable (uid=...)` | info | Startup probe: the jsonl recording directory is writable | — |
| `ingest: recording root ... is NOT writable ...` | error | Startup probe: recordings will not be written | — |
| `ingest: recording root ... is on the container's root filesystem, not a mounted volume ...` | error | Startup probe: recordings will not survive a redeploy | — |
| `ingest: SIGTERM received, draining queue` | info | Shutdown started: both lanes are told to stop, then the writer drains | — |
| `ingest: drained (inserted=... skipped=...); exiting` | info | Shutdown finished: the writer's final drain totals, then the process exits | `inserted`, `skipped` |
| `ingest: error while draining: ...` | error | The shutdown drain itself threw | — |
| `recording closed <session_key> rows=<n> path=<dir>` | info | A followed session's live window closed; the recording under `<dir>` is complete | `rows` |
| `rest: following session_key=... (...)` | info | REST lane selected a new session to follow | — |
| `rest: session not selected: upsert failed` | info | The live session's `sessions` upsert failed this tick; selecting it would break every later event insert's FK, so it's left unselected until the next discovery tick retries the upsert | — |
| `rest: poll endpoint=... rows=... new=... malformed=...` | info | One rotation tick's fetch result | `rows`, `new` |
| `rest: poll ... failed: ...` | error | A rotation tick's fetch threw | — |
| `rest: session discovery failed: ...` | error | The `sessions` discovery fetch threw | — |
| `rest: session row skipped: ...` | info | One discovered session row failed validation and was not upserted | — |
| `rest: session ... left its live window; releasing` | info | The followed session's window closed; the REST lane stops following it | — |
| `rest: meetings fetch failed: ...` | error | The `meetings` discovery fetch threw | — |
| `rest: recording failed: ...` | error | The jsonl recorder threw while appending REST rows | `endpoint` |
| `rest: tick failed: ...` | error | The tick loop itself threw | — |
| `entry list: fetched session_key=... rows=... new=... foreign=... unknown_session=...` | info | The selection fetch returned rows | `rows`, `new`, `foreign`, `unknown_session` |
| `entry list: static fallback (...) session_key=...` | info | The selection fetch returned nothing; the static list was emitted once | — |
| `entry list: pre-race refresh session_key=... rows=... new=... foreign=... unknown_session=...` | info | The pre-race refresh returned rows | `rows`, `new`, `foreign`, `unknown_session` |
| `entry list: pre-race refresh session_key=... returned 0 rows` | info | The pre-race refresh returned nothing; still counted as done (a zero-row response is not a failure) | — |
| `entry list: pre-race refresh failed for session_key=...` | error | The pre-race refresh fetch itself threw; retried next tick | — |
| `entry list: friday fetch meeting_key=... rows=... new=... foreign=... unknown_session=...` | info | The Friday meeting-wide fetch returned rows | `rows`, `new`, `foreign`, `unknown_session` |
| `entry list: friday fetch meeting_key=... deferred (...); retrying in 30m` | info | The Friday fetch returned nothing or failed | — |
| `entry list: static fallback is for <year>` | info | Logged once at startup: the season the static list covers | — |
| `mqtt: connected` | info | The MQTT client's `connect` handler fired | — |
| `mqtt: disconnected` | info | The MQTT client's `close` handler fired | — |
| `mqtt: proactive 50-min token refresh, reconnecting` | info | The proactive reconnect timer fired; a fresh token will be fetched on the reconnect | — |
| `mqtt: auth rejected: ...` | error | The broker rejected the connection at CONNACK | — |
| `mqtt: error: ...` | error | The client's `error` handler fired for anything other than an auth rejection | — |
| `mqtt: subscribe error: ...` | error | Subscribing to the topic list failed | — |
| `mqtt: message handler failed: ...` | error | Handling one incoming message threw | `endpoint` |
| `mqtt: token fetch failed, will retry: ...` | error | `auth.getToken()` threw before connecting | — |
| `mqtt: recording failed: ...` | error | The recorder threw while appending MQTT rows | `endpoint` |
| `writer: batch inserted=... skipped=...` | info | A batch committed | `inserted`, `skipped` |
| `writer: batch of ... failed, requeued: ...` | error | A batch's insert threw; requeued at the front for retry | `failures` |
| `writer: ... consecutive failures, queue depth=...` | error | The writer's own retry loop (`run()`) counted another failure in a row; backs off before the next attempt | — |
| `writer: giving up after ... consecutive failures, dropped=...` | error | The shutdown drain (`drainAll()`) gave up on the same batch after `MAX_CONSECUTIVE_FAILURES` (3) retries | `dropped` |
| `writer: queue at capacity, dropped ... rows since the last batch` | error | The queue hit its 200,000-row cap and dropped the newest rows | `dropped` |
| `token: expires_in missing or invalid (...), assuming 3600 s` | error | The OpenF1 token response's `expires_in` wasn't the expected numeric string | — |

## OpenF1 facts

- The free tier locks out during any live session.
- The sponsor bearer token expires in 3600 s: refresh before expiry and on
  every reconnect.
- The live API rejects all date filters; a 404 there means no data yet, not
  an error.
- Live rows mutate in place — identity hashing exists because of this.
- Never run two OpenF1 consumers against the same account at once.

## Reading order

`main.ts` → `config.ts` → `writer/queue.ts` and `writer/writer.ts` →
`openf1/normalize.ts` → `openf1/enqueue.ts` → `openf1/discovery.ts` →
`openf1/rest-lane.ts` → `openf1/entry-list-fetches.ts` →
`openf1/mqtt-lane.ts` → `writer/sessions.ts` → `commands/`.

`openf1/rest-lane.ts` is the tick loop, the session selection and the
weighted rotation. The `sessions?year=`/`meetings?year=` snapshot it reads
is `openf1/discovery.ts` (`SessionDiscovery`), and the three drivers fetches
are `openf1/entry-list-fetches.ts` (`EntryListFetches`); the lane constructs
both and neither imports the lane.

See also [`../../docs/architecture.md`](../../docs/architecture.md) and
[`../../docs/glossary.md`](../../docs/glossary.md).
