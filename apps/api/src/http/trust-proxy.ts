// The value passed to Fastify's `trustProxy` option in main.ts, lifted out
// so a unit test can exercise it without the rest of main.ts's side
// effects. Always the private address ranges, never `true` -- `true`
// would let a client forge its own resolved IP via X-Forwarded-For and
// dodge the vote route's per-IP rate limit. See README: Polls.
export const TRUST_PROXY = "loopback, linklocal, uniquelocal";
