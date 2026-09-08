# FormulaTime

## What this is about

- This is a project on Formula 1 timing visibility, with user interaction on predictions on race results and events. It's a real time polling application with rich data fed from F1TV's source feed, with unique syncing abilities to align race data to the video feed on the same machine.
- Part of a project for JDSG 2026, where we create applications that builds up more intuitive habits on system design archiecture thinking.

## What this project involves

- A timing layer where the user will be able to see rich race data, with granular controls on live replay, with the ability to automatically sync to users' video stream.
- A polling layer where users can predict race state and race results, that resolves and notifies users when those events happen.

## Decisions

- `docs/decisions-adr/` holds every architectural decision, numbered and dated. New decisions are appended.

## Deploy

Railway, two services from one Docker image built from the root
`Dockerfile`:

- `api` — points at `railway.api.json`. Runs `pnpm db:migrate:deploy` as
  its pre-deploy command, then starts `node apps/api/dist/main.js`.
- `ingest` — points at `railway.ingest.json`. Starts
  `node apps/ingest/dist/main.js` directly, no pre-deploy step.

Each service's config-as-code path is set under Service → Settings →
Config-as-code path in the Railway dashboard.

Variables (set on `api`; `ingest` gets its own later): `DATABASE_URL`,
`DATABASE_DIRECT_URL`, `OPENF1_LOGIN`, `OPENF1_PASSWORD`. Railway injects
`PORT` itself.

Check the SSE route through Railway's proxy once deployed:

```
curl -N https://<api-domain>/live/events
```

A `heartbeat` event should print every 5 seconds, unbuffered.
