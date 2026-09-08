// CORS for the split-hosted web bundle (ADR-0008). The bundle lives on its
// own origin (Cloudflare Pages on the apex of the custom domain); the api
// answers on `api.<domain>`. Both share one registrable domain, so the
// SameSite=Lax viewer cookie still travels on a credentialed fetch.
//
// `CORS_ORIGIN` is a comma-separated allowlist of exact origins, read from
// the platform secret store. Unset means no cross-origin access at all,
// which is the right default for a same-origin dev setup (the Vite proxy).
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
export function replyHeaders(reply: FastifyReply): OutgoingHttpHeaders {
  return reply.getHeaders() as OutgoingHttpHeaders;
}
