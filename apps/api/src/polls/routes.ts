// Returns a Fastify plugin registering the two poll routes, relative to
// whatever prefix the caller applies. Owns nothing beyond routing:
// PollModule (poll-module.ts) is the only writer of `polls` and `votes`
// (apps/api/AGENTS.md, ADR-0001 §2 invariant 5).
//
// Owner decision: every client-facing route lives under the `/api` prefix.
// The routes here stay relative (`/vote`, `/polls`); the caller supplies
// the prefix at registration: `app.register(registerPolls(module), {
// prefix: "/api" })`, so the public paths are `POST /api/vote` and
// `GET /api/polls`. `/health` is not this module's and stays at the root.
//
// `@fastify/cookie` is registered inside this plugin (not main.ts).
// Because `@fastify/cookie` uses `fastify-plugin`, its decorators
// (`reply.setCookie`) are exposed to this plugin's own instance rather than
// creating a nested encapsulation, so `fastify.post`/`fastify.get` below can
// use them regardless of the prefix applied at registration.
//
// `@fastify/rate-limit` is registered the same way, with `global: false`:
// that adds the hook to this instance without limiting any route by
// default, so only `/vote` (via its own `config.rateLimit`) is limited --
// `/polls` and `/races/:session_key/polls` below stay unlimited.
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { FastifyError, FastifyInstance, FastifyPluginAsync } from "fastify";

import type { PrismaClient } from "@formula-time/db";

import { originAllowed, parseAllowedOrigins } from "../cors.js";
import type { PollModule } from "./poll-module.js";
import { pollsBySession } from "./poll-read.js";
import { resolveViewerId, viewerCookieOptions } from "./viewer-identity.js";

interface VoteBody {
  poll_id: string;
  option_id: string;
}

const voteBodySchema = {
  type: "object",
  required: ["poll_id", "option_id"],
  properties: {
    poll_id: { type: "string" },
    option_id: { type: "string" },
  },
} as const;

const INTEGER = /^-?\d+$/;

export function registerPolls(module: PollModule, db: PrismaClient): FastifyPluginAsync {
  return async function pollsPlugin(fastify: FastifyInstance): Promise<void> {
    fastify.register(cookie);
    // Awaited: the plugin wires its onRoute hook here, and that hook must
    // run before the routes below are added, or their `config.rateLimit`
    // is never picked up.
    await fastify.register(rateLimit, { global: false });

    // The plugin throws on the limited route; rewritten here to the vote
    // route's own error shape (`{"error":"…"}`) instead of the plugin's
    // default `{statusCode,error,message}` body. Scoped to this plugin
    // instance, so it never touches the SSE route's error handling.
    fastify.setErrorHandler<FastifyError>((error, request, reply) => {
      if (error.statusCode === 429) {
        reply.code(429);
        reply.send({ error: "rate limited" });
        return;
      }
      reply.send(error);
    });

    fastify.post<{ Body: VoteBody }>(
      "/vote",
      {
        schema: { body: voteBodySchema },
        // 60 votes per minute per client IP (`request.ip`, correct only
        // because `trustProxy` is set in main.ts): two orders of magnitude
        // above a person's re-vote rate, and Postgres's own upsert already
        // caps the harm at one row per viewer regardless (ADR-0001 §2
        // invariant 5), so this bounds load, not tally correctness.
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        // SameSite=None (below) dropped the CSRF guard Lax gave for free, so
        // the vote route checks Origin itself, against the same allowlist
        // the cors plugin uses (ADR-0015). Checked before touching viewer
        // identity or the poll module: a disallowed origin gets nothing else.
        const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGIN);
        if (!originAllowed(request.headers.origin, allowedOrigins)) {
          reply.code(403);
          return { error: "origin not allowed" };
        }

        const env = process.env.NODE_ENV;
        const { viewerId, setCookie } = resolveViewerId(request.headers.cookie, env);
        if (setCookie !== null) {
          reply.setCookie("viewer_id", viewerId, viewerCookieOptions(env));
        }

        const result = await module.vote(request.body.poll_id, viewerId, request.body.option_id);

        if (!result.ok) {
          reply.code(result.status);
          return { error: result.error };
        }

        // Sent only after PollModule.vote's conditional upsert resolved, i.e.
        // after the votes insert committed (ADR-0001 §2 invariant 5: "A vote
        // is acknowledged only after its insert commits").
        reply.code(200);
        return { poll_id: result.poll.poll_id, option_id: result.option_id, viewer_id: viewerId, counted: true };
      },
    );

    fastify.get("/polls", async () => module.publicPolls());

    // GET /api/races/:session_key/polls -- polls for a race, read straight
    // from Postgres rather than the poll module's in-memory (current-session-only)
    // state. Two queries per request, never per viewer per tick (ADR-0001 §2
    // invariant 2); the vote path above is untouched.
    fastify.get<{ Params: { session_key: string } }>("/races/:session_key/polls", async (request, reply) => {
      const raw = request.params.session_key;
      if (!INTEGER.test(raw)) {
        reply.code(400);
        return { error: "session_key must be an integer" };
      }
      const sessionKey = BigInt(raw);

      const { polls, cacheable } = await pollsBySession(db, sessionKey);
      reply.header("cache-control", cacheable ? "public, max-age=300" : "no-store");
      return polls;
    });
  };
}
