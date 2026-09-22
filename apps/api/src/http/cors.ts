// CORS for the split-hosted web bundle (ADR-0008): the bundle and this
// api are on different origins (Netlify and Railway), so the viewer
// cookie needs `SameSite=None` to cross them in production (ADR-0015).
// `CORS_ORIGIN` is a comma-separated allowlist of exact origins from the
// platform secret store; unset means no cross-origin access, the right
// default for same-origin dev (the Vite proxy).
import cors from "@fastify/cors";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function registerCors(app: FastifyInstance, allowed: string[]): Promise<void> {
  await app.register(cors, {
    // `false` sets no header for an origin off the list: the browser then
    // blocks the response. Same-origin requests carry no Origin and pass.
    origin: allowed.length === 0 ? false : allowed,
    credentials: true,
    methods: ["GET", "POST"],
  });
}

/**
 * Headers the cors plugin has already put on a reply. A hijacked route
 * writes its own head on the raw response and Fastify sends nothing, so
 * the SSE route must merge these into its `writeHead` or the browser's
 * cross-origin EventSource is refused.
 */
export function replyHeaders(reply: Pick<FastifyReply, "getHeaders">): OutgoingHttpHeaders {
  return reply.getHeaders() as OutgoingHttpHeaders;
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    return new URL(origin).hostname === "localhost";
  } catch {
    return false;
  }
}

/** POST /api/vote's own origin check (ADR-0015): the viewer cookie is
 * `SameSite=None` for the split origins, which carries no CSRF guard, so
 * this route checks `Origin` against the same allowlist instead. An empty
 * allowlist (dev, `CORS_ORIGIN` unset) also accepts no `Origin` header or
 * a `localhost` origin, so the Vite proxy keeps working; a non-empty
 * allowlist requires exact membership. */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) {
    return origin === undefined || isLocalhostOrigin(origin);
  }
  return origin !== undefined && allowed.includes(origin);
}
