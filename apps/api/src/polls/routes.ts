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
// `@fastify/cookie` is registered inside the returned plugin rather than
// in main.ts: wiring this module into the app's single Fastify instance is
// left to a follow-up commit after #23 (projector/fan-out/live route)
// merges, per the plan for #24. Because `@fastify/cookie` uses
// `fastify-plugin`, its decorators (`reply.setCookie`) are exposed to this
// plugin's own instance rather than creating a nested encapsulation, so
// `fastify.post`/`fastify.get` below can use them regardless of the prefix
// applied at registration.
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { PollModule } from "./poll-module.js";
import { resolveViewerId } from "./viewer-identity.js";

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

export function registerPolls(module: PollModule): FastifyPluginAsync {
  return async function pollsPlugin(fastify: FastifyInstance): Promise<void> {
    fastify.register(cookie);

    fastify.post<{ Body: VoteBody }>("/vote", { schema: { body: voteBodySchema } }, async (request, reply) => {
      const { viewerId, setCookie } = resolveViewerId(request.headers.cookie);
      if (setCookie !== null) {
        reply.setCookie("viewer_id", viewerId, {
          path: "/",
          maxAge: 31536000,
          sameSite: "lax",
          httpOnly: true,
          secure: true,
        });
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
    });

    fastify.get("/polls", async () => module.publicPolls());
  };
}
