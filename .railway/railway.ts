// Railway Infrastructure as Code. Replaces config-as-code (railway.json /
// railway.toml), which Railway deprecated in favour of this DSL — read-only
// support for the old format ends 2026-12-01
// (https://docs.railway.com/infrastructure-as-code). Confirmed against the
// installed `railway` package's own `dist/iac/index.d.ts` (v3.11.0): the
// `service()`, `postgres()`, `github()`, `preserve()`, `volume()`
// signatures and the `build.buildCommand` / `build.watchPatterns` /
// `deploy.restartPolicyType` / `volumeMounts` fields used below all exist
// there, quoted in the relevant PR body.
//
// One file declares every service in the environment — omitting one here
// means "delete it" — so all three of the owner's existing Railway services
// are declared below, by their exact dashboard names: `api`, `ingest`,
// `Postgres`.
//
// Applied by `railway config plan` / `railway config apply` (CLI, >=5.42.1)
// or the `railwayapp/config@v1` GitHub Action (see
// .github/workflows/railway-plan.yml / railway-apply.yml) — never
// automatically on push. The owner runs the first `railway config plan`
// locally and confirms it reads as *adopting* the three existing services
// (Postgres included — check its image/version in the diff) rather than
// deleting or recreating any of them, before anyone runs `apply`.
import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const db = postgres("Postgres");
  const source = github("samuelisch/formula-time", { branch: "release" });

  // The ingest jsonl recording (LIVE_LOG_DIR) lives on the container's disk
  // today, which Railway discards on every deploy — the recording is the
  // only copy of a live race in received order. `volume(name, config?):
  // VolumeNode` (node_modules/railway/dist/iac/index.d.ts, v3.11.0); a
  // service attaches it by using the VolumeNode as a `volumeMounts` value
  // keyed by mount path, per the same file's `service()` config:
  // `volumeMounts?: Record<string, VolumeMount | null | VolumeNode>`.
  //
  // config.region and config.sizeMB are declared, not left default: the
  // first apply created this volume without either set here, and Railway
  // assigned its own values on creation — region asia-southeast1-eqsg3a
  // (matching the services' multiRegionConfig region) and sizeMB 5000 —
  // then stored them. A volume declared without them plans as a change to
  // null on every run, the same permanent drift as the api's restart
  // policy, in the other direction: there the file declared a platform
  // default, here the platform filled in what the file left unstated. This
  // file now states what the platform holds. Change the size here, not in
  // the dashboard, and let apply carry it.
  const liveLogs = volume("ingest-live-logs", {
    region: "asia-southeast1-eqsg3a",
    sizeMB: 5000,
  });

  // Same four secrets on both services (platform fact: variables are on
  // `api` only today; `ingest` gets its own after this lands — declaring
  // them here for `ingest` too so `railway config apply` sets them at the
  // same time `ingest` is first configured). `preserve()` keeps whatever
  // value is already set in the dashboard, so no secret enters the repo.
  const secrets = {
    DATABASE_URL: db.env.DATABASE_URL,
    DATABASE_DIRECT_URL: db.env.DATABASE_URL,
    OPENF1_LOGIN: preserve(),
    OPENF1_PASSWORD: preserve(),
  };

  // build.buildCommand and build.watchPatterns are adopted verbatim from
  // `railway config plan` run against the live environment (ADR-0019): no
  // `build.builder` here — the live services have none set, and declaring
  // "DOCKERFILE" was drift this file introduced, never actually applied.
  // watchPatterns is widened past each service's own app directory to
  // `packages/**` and the workspace root files, so a shared-code-only
  // commit (e.g. #196, #198) is no longer SKIPPED by the service that
  // needs rebuilding.
  const api = service("api", {
    source,
    build: {
      buildCommand: "pnpm --filter @formula-time/api build",
      watchPatterns: [
        "/apps/api/**",
        "/packages/**",
        "/Dockerfile",
        "/pnpm-lock.yaml",
        "/package.json",
        "/pnpm-workspace.yaml",
      ],
    },
    start: "node apps/api/dist/main.js",
    preDeploy: "pnpm db:migrate:deploy",
    healthcheck: "/health",
    // No `deploy.restartPolicyType` here: Railway's default restart policy
    // is On Failure, and the platform stores nothing for a service left on
    // the default. Declaring `ON_FAILURE` reads back as null and plans as a
    // permanent change. The api runs on the platform default and this file
    // does not manage it; ingest's `ALWAYS` below is a real non-default
    // setting the platform keeps.
    // CORS_ORIGIN: the web bundle's origins, comma-separated (ADR-0008).
    // Set in the dashboard once the custom domain exists; preserved here.
    env: { ...secrets, CORS_ORIGIN: preserve() },
  });

  const ingest = service("ingest", {
    source,
    build: {
      buildCommand: "pnpm --filter @formula-time/ingest build",
      watchPatterns: [
        "/apps/ingest/**",
        "/packages/**",
        "/Dockerfile",
        "/pnpm-lock.yaml",
        "/package.json",
        "/pnpm-workspace.yaml",
      ],
    },
    start: "node apps/ingest/dist/main.js",
    deploy: { restartPolicyType: "ALWAYS" },
    // The recording directory lives under the mounted volume, not the
    // container's own (ephemeral) disk. If the volume is ever unmounted (a
    // local run has none), config.ts's own default (`./live-logs`) applies
    // instead and the recorder creates that directory as it does today.
    volumeMounts: { "/data": liveLogs },
    // MQTT_ENABLED (issue #25 / ADR-0012): config.ts's default already
    // covers the free-tier (no OPENF1_LOGIN) case without this var set;
    // preserved here only so an operator override (e.g. MQTT_ENABLED=false
    // for an incident, with credentials still set — ADR-0012) has a slot in
    // the one committed IaC file instead of only in the dashboard.
    //
    // RAILWAY_RUN_UID: Railway's documented fix for a non-root image writing
    // to a volume (docs.railway.com/reference/volumes, Caveats: "Docker
    // images that run as a non-root UID by default will have permissions
    // issues when performing operations within an attached volume. If you
    // are affected by this, you can set `RAILWAY_RUN_UID=0` environment
    // variable in your service."); `/data` is `root:root drwxr-xr-x` and the
    // image runs as uid 1001, so without this the recorder's `mkdir` fails
    // EACCES on every row. On `ingest` only, never on `api` — `api` serves
    // public traffic, `ingest` binds no port. Not `preserve()`: this value
    // is managed here, like `LIVE_LOG_DIR` (ADR-0036).
    env: {
      ...secrets,
      MQTT_ENABLED: preserve(),
      LIVE_LOG_DIR: "/data/live-logs",
      RAILWAY_RUN_UID: "0",
    },
  });

  // The project name is the join key `railway config plan`/`apply` matches
  // against the live environment — it must equal the Railway dashboard's
  // actual project name, not the repo name. This project is
  // `soothing-compassion`.
  return project("soothing-compassion", { resources: [db, api, ingest, liveLogs] });
});
