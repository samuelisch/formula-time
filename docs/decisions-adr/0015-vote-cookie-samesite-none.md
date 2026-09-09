# ADR-0015 — Vote cookie SameSite=None on split origins, origin check replaces Lax

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-09
- **Owner:** Samuel Chan
- **Amends:** ADR-0008's cookie paragraph ("The viewer cookie stays
  `SameSite=Lax`. On the interim subdomains it does not travel, so vote
  identity is not stable until either the custom domain exists or the
  cookie is switched to `SameSite=None`... That call is made when votes
  reach the UI, not here."). That call is made here.

## Context

ADR-0008 records that the `SameSite=Lax` viewer cookie does not travel
between the Netlify bundle's `*.netlify.app` origin and the api's
`*.up.railway.app` origin — both on the Public Suffix List, so they do not
share one registrable domain. In practice this means one browser can be
issued a new `viewer_id` on every vote (Safari always blocks it; other
browsers depending on settings), which breaks one-vote-per-browser
silently. There is no custom domain yet, so the cookie itself has to
change, not just be document as a known gap.

## Decision

- The `viewer_id` cookie becomes `SameSite=None; Secure; HttpOnly; Path=/;
  Max-Age=31536000` in production. `Secure` was already set.
- In dev, over plain http, a browser drops a `SameSite=None` cookie
  outright, so the cookie's attributes are decided by one helper,
  `viewerCookieOptions(env)` (`apps/api/src/polls/viewer-identity.ts`):
  `env !== "production"` gets `sameSite: "lax", secure: false`; `env ===
  "production"` gets `sameSite: "none", secure: true`. `routes.ts` passes
  this straight to `reply.setCookie`, and `resolveViewerId`'s own raw
  fallback string is built from the same helper, so the two attribute
  lists can never drift apart.
- `SameSite=Lax` was also the CSRF guard for `POST /api/vote` — a
  cross-site POST does not carry the cookie, so a forged vote from another
  site was never a full request. `SameSite=None` removes that guard, so
  the route gains an explicit check instead: the request's `Origin` header
  must be in the same `CORS_ORIGIN` allowlist the cors plugin already uses
  (`parseAllowedOrigins`, `apps/api/src/cors.ts`). Missing or foreign
  origin → `403 { error: "origin not allowed" }`. A same-origin request
  still carries `Origin` on POST (unlike GET), so a same-origin production
  request passes so long as the allowlist includes the site's own origin.
  When the allowlist is empty (dev, `CORS_ORIGIN` unset), the check
  accepts a request with no `Origin` header or a `localhost` origin, so
  the Vite proxy keeps working without setting `CORS_ORIGIN` locally.
- The web already sends `credentials: "include"` on every fetch
  (`apiFetch`, `apps/web/src/api.ts`); nothing changes there.

## Consequences

- Safari's third-party-cookie blocking still yields a fresh `viewer_id`
  per vote there even with `SameSite=None` — Safari does not honor
  `SameSite=None` for a cross-site cookie the way Chromium and Firefox do.
  Accepted, as ADR-0008 already accepted the same gap, until a custom
  domain puts the bundle and the api on the same registrable domain and
  the cookie can go back to `Lax`.
- Any future cookie-scoped route needs the same origin check `POST
  /api/vote` gained here — `SameSite=None` removes the CSRF guard
  everywhere it was relied on implicitly, not just on this one route.
- `CORS_ORIGIN` now has two consumers instead of one: the cors plugin's
  preflight/response headers, and the vote route's own origin check. Both
  read it through `parseAllowedOrigins`, so the two never disagree on what
  "allowed" means.
