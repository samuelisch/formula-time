# ADR-0036 — The ingest service runs as root on Railway so the volume is writable

- **Status:** Accepted
- **Date:** 2026-09-14
- **Owner:** Samuel Chan
- **Amends:** ADR-0034 (its "a rejected append is logged at error level ...
  never allowed to block or stop the lane" stance is extended to the
  startup probe this ADR adds, not changed); ADR-0007 §4 (names
  `LIVE_LOG_DIR` as a config seam and is unchanged by this).

## Context

Measured, over `railway ssh -s ingest`: the volume applied for issue #267
is mounted at `/data` (`/dev/zd4304`, 4.6 GB, ext4), owned by `root:root`,
mode `drwxr-xr-x`, containing only `lost+found`. The root `Dockerfile`
creates `app` (uid 1001) and ends the runtime stage with `USER app`; in the
running container `/proc/1/status` shows `Uid: 1001`. `su -s /bin/sh app -c
'mkdir -p /data/live-logs'` fails with `Permission denied` — the `railway
ssh` shell itself is root, so a manual `touch /data/x` there succeeds and
misleads about what the service process can do. `apps/ingest/src/openf1/
recorder.ts` creates `<LIVE_LOG_DIR>/<session_key>/raw` with `mkdir({
recursive: true })` on the first row of a session; a rejected append is
logged at error level and does not stop the lane (ADR-0034), so the
failure is silent until the next live session, at which point the
recording — the artefact issue #267 exists to preserve — does not land.

Railway's documentation (docs.railway.com/reference/volumes, under
**Caveats**), verbatim:

> "Docker images that run as a non-root UID by default will have
> permissions issues when performing operations within an attached volume.
> If you are affected by this, you can set `RAILWAY_RUN_UID=0` environment
> variable in your service."

And (docs.railway.com/reference/variables, the `RAILWAY_RUN_UID` row),
verbatim:

> "The UID of the user which should run the main process inside the
> container. Set to `0` to explicitly run as root."

The volumes page documents nothing about the ownership or mode of the
mount path itself, and nothing about Dockerfile `USER` directives.
`RAILWAY_RUN_UID=0` is the only lever Railway documents for this problem.

An entrypoint script that starts as root, `chown`s `/data`, then drops
privilege to `app` was considered and rejected: Railway honours the
image's `USER` (measured: `/proc/1/status` shows `Uid: 1001`), so the
entrypoint would itself run as `app` and its `chown` would fail with the
same EACCES unless `USER app` is removed from the shared `Dockerfile`,
which would make `api` and every local `docker run` start as root too.
`su`, the only privilege-drop tool measured present in the runtime image,
forks rather than execs, leaving `su` as PID 1 and breaking the SIGTERM
handling `MqttLane.stop()` and `main.ts`'s stats interval rely on;
`gosu`/`su-exec` are not measured present, and adding one would mean
shipping a binary in a runtime image whose stated invariant is no source
files and no devDependencies. `RAILWAY_RUN_UID=1001` does not help either:
`/data` is `root:root drwxr-xr-x` regardless of which uid the process
runs as.

## Decision

`RAILWAY_RUN_UID=0` is set on the `ingest` service's env in
`.railway/railway.ts` only, never on `api` — `api` serves public traffic
and declares a `healthcheck`; `ingest` binds no port and reaches only
OpenF1 (HTTPS/MQTT) and Postgres, so root there is a materially smaller
exposure than root on the public service. The value is declared, not
`preserve()`d, the same way `LIVE_LOG_DIR` is managed in that file. The
image's `Dockerfile` is unchanged: it still ends with `USER app`, so `api`
and any local `docker run` keep uid 1001; the override is a per-service
runtime setting, not an image change.

Because `RAILWAY_RUN_UID=0` makes every filesystem write succeed
regardless of where it lands, a startup probe (`apps/ingest/src/openf1/
recording-root.ts`, wired from `main.ts` before the lanes start) is what
stops a broken recording root from being silent. It creates the directory,
performs a real write-and-remove probe (a bare `mkdir` is not enough: it
is a no-op that succeeds against an existing root-owned directory while
every later append still fails), and logs exactly one of three lines:

- writable — `ingest: recording root <dir> is writable (uid=<uid>)`
- not writable — `ingest: recording root <dir> is NOT writable (uid=<uid>): <error message> — recordings will not be written`
- not a mounted volume — `ingest: recording root <dir> is on the container's root filesystem, not a mounted volume — recordings will not survive a redeploy`

The not-a-mount check runs only when the directory was explicitly named
(an absolute `LIVE_LOG_DIR` set in the environment, read through
`config.ts`'s `liveLogDirExplicit` rather than `process.env` directly),
and only before the write probe: an operator who names a specific
absolute location is asserting it is a real mount, and comparing its
device against `/`'s catches the case root's universal write access would
otherwise hide — a location that silently sits on the container's own
ephemeral disk. The default relative `./live-logs` never triggers it.
Neither branch of the probe exits the process or throws out of `main.ts`:
a disk problem must not take the live capture down, the same stance
ADR-0034 takes for a single rejected append. Every injected fs call the
probe makes is bounded by a timeout (default 5s): `ingest` declares no
healthcheck (only `api` does), so nothing restarts it, and a wedged mount
that never resolves a bare `await` would otherwise turn a disk problem
into "the lanes never start" — a stricter failure than the "not writable"
the probe means to report. A timed-out call is treated as `not-writable`.

## Consequences

- `/data/live-logs` on the deployed environment is created and owned by
  `root:root`, not by `app`. Any future check asserting `app` ownership
  there is wrong for what is shipped here.
- `api` and every local run (`docker run` with no override, `pnpm dev`)
  keep uid 1001; the non-root hardening in `apps/ingest/AGENTS.md` and the
  `Dockerfile`'s runtime-stage comment now describe the image, not the
  deployed `ingest` process.
- `RAILWAY_RUN_UID` joins the set of names `ingest` depends on that live in
  `.railway/railway.ts` as a platform variable, not in `config.ts` — it is
  never read by the ingest process itself, only by Railway's container
  runtime.
- The startup probe's three log lines are now part of what a deploy
  verification checks (`.claude/skills/load-race/SKILL.md`), alongside the
  existing per-minute stats line.
