// The value passed to Fastify's `trustProxy` option in main.ts, lifted out
// so a unit test can exercise it without the rest of main.ts's side
// effects (it connects to Postgres and calls `app.listen` at module scope).
//
// Railway terminates TLS at its own edge and connects to this container
// over its internal network, so the raw TCP peer this process ever sees is
// always a private address, never the public internet. Trusting those
// private ranges -- rather than `trustProxy: true`, which trusts an
// X-Forwarded-For header of any length -- means address resolution stops
// at the first hop that is not itself private: a client cannot obtain a
// fresh resolved "IP" (and so a fresh rate-limit budget) by prepending
// arbitrary extra hops onto its own request header, because everything
// left of its own real, public-facing address is ignored.
export const TRUST_PROXY = "loopback, linklocal, uniquelocal";
