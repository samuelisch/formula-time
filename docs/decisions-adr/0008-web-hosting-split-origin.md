# ADR-0008 — Web bundle on a static host (Netlify), api on its own origin

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-08
- **Owner:** Samuel Chan
- **Amends:** ADR-0001 §1 ("static assets on the platform CDN") and §3
  (hosting row). The shape is unchanged; this names the platform and the
  origin split.

## Context

ADR-0001 puts static assets "on the platform CDN". The platform is Railway
(`.railway/railway.ts`), which hosts services, not static sites, so that
line cannot be taken literally. Two ways to serve the Vite bundle were on
the table: the api's Fastify process hands it out on the same origin, or a
static host serves it on its own origin and the browser calls the api
cross-origin.

The vote path (#36) identifies a viewer by an HttpOnly `SameSite=Lax`
cookie. A Lax cookie travels on a cross-origin fetch only when both sides
share one registrable domain. On two platform-issued domains
(`*.netlify.app`, `*.up.railway.app`, both on the Public Suffix List) it
never travels and one-vote-per-browser silently breaks. Speed to a public
URL matters more right now than vote identity, which the UI does not
expose yet.

## Decision

- The web bundle is built and hosted by **Netlify** from `apps/web` on
  push to `main`. Interim: Netlify's own `*.netlify.app` subdomain, the
  api on its Railway-issued domain. Target: a custom domain the owner
  registers, bundle at the apex, api on `api.<domain>`, DNS-only (no CDN
  proxy in the SSE path). The move is two config values and two
  custom-domain screens; no code changes.
- The api allows the bundle's origins through `@fastify/cors` with
  credentials, from a comma-separated `CORS_ORIGIN` variable in the
  platform secret store. Unset means no cross-origin access. The hijacked
  SSE route merges the plugin's headers into its own `writeHead`.
- The bundle reads the api origin from `VITE_API_URL` at build time; unset
  means relative URLs, which is dev behind the Vite proxy.
- The viewer cookie stays `SameSite=Lax`. On the interim subdomains it
  does not travel, so vote identity is not stable until either the custom
  domain exists or the cookie is switched to `SameSite=None` (one line in
  #36; Safari still blocks it as third-party). That call is made when
  votes reach the UI, not here.
- `_redirects` (`/* /index.html 200`) gives the SPA its fallback;
  `_headers` marks hashed assets immutable. Both are Netlify files that
  Cloudflare Pages reads identically, so the host is swappable.

## Consequences

- Bundle and api deploy independently, so a RaceState field added on one
  side is not on the other for a few minutes. Accepted; changes to the
  wire shape are coordinated by hand until it hurts.
- Any hijacked route must merge the cors headers itself, or the browser
  refuses it. `replyHeaders()` in `apps/api/src/cors.ts` is the hook; the
  live route (`routes/live.ts`) uses it and joins `vary`.
- Finished-race exports (ADR-0001 §1) have no home yet on this shape; a
  later ADR picks object storage.
- The `/api` prefix on client routes (owner decision, #38) is unrelated
  to this split: on separate origins nothing collides. `/health` stays at
  the root as the platform probe.
