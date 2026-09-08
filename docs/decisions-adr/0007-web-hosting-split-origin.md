# ADR-0007 — Web bundle on a static host, api on a subdomain

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
share one registrable domain. On two platform-issued domains it never
travels and one-vote-per-browser silently breaks.

## Decision

- The web bundle is built and hosted by **Cloudflare Pages** from
  `apps/web` on push to `main`, at the apex (and `www`) of a custom domain
  the owner registers. The api keeps its Railway service on
  `api.<domain>`, DNS-only (no Cloudflare proxy in the SSE path).
- The api allows the bundle's origins through `@fastify/cors` with
  credentials, from a comma-separated `CORS_ORIGIN` variable in the
  platform secret store. Unset means no cross-origin access. The hijacked
  SSE route merges the plugin's headers into its own `writeHead`.
- The bundle reads the api origin from `VITE_API_URL` at build time; unset
  means relative URLs, which is dev behind the Vite proxy.
- The viewer cookie stays `SameSite=Lax`; the shared registrable domain
  keeps it working. No `SameSite=None`.

## Consequences

- Bundle and api deploy independently, so a RaceState field added on one
  side is not on the other for a few minutes. Accepted; changes to the
  wire shape are coordinated by hand until it hurts.
- Any future hijacked route must merge the cors headers itself, or the
  browser refuses it. `replyHeaders()` in `apps/api/src/cors.ts` is the
  hook; #38's live route needs it on rebase.
- Finished-race exports (ADR-0001 §1) have no home yet on this shape; a
  later ADR picks object storage.
- An `/api` path prefix is no longer needed for route collisions and is
  not introduced here.
