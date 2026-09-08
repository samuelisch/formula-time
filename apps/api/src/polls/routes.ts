// Registers the two poll routes on a Fastify instance. Owns nothing beyond
// routing: PollModule (poll-module.ts) is the only writer of `polls` and
// `votes` (apps/api/AGENTS.md, ADR-0001 §2 invariant 5).
//
// `@fastify/cookie` is registered here rather than in main.ts: wiring this
// module into the app's single Fastify instance is left to a follow-up
// commit after #23 (projector/fan-out/live route) merges, per the plan for
// #24. Because `@fastify/cookie` uses `fastify-plugin`, its decorators
// (`reply.setCookie`) are exposed to this encapsulation's parent, so once
// `registerPolls` itself is `app.register`-ed from main.ts, everything
// composes normally.
import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";

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

export function registerPolls(app: FastifyInstance, module: PollModule): void {
  app.register(cookie);

  app.post<{ Body: VoteBody }>("/vote", { schema: { body: voteBodySchema } }, async (request, reply) => {
    const { viewerId, setCookie } = resolveViewerId(request.headers.cookie);
    if (setCookie !== null) {
      reply.setCookie("viewer_id", viewerId, {
        path: "/",
        maxAge: 31536000,
        sameSite: "lax",
        httpOnly: true,
      });
    }

    const result = await module.vote(request.body.poll_id, viewerId, request.body.option_id);

    if (!result.ok) {
      reply.code(result.status);
      return { error: result.error };
    }

    // Sent only after PollModule.vote's conditional upsert resolved, i.e.
    // after the votes insert committed (ADR-0001 §2 invariant 5: "A vote is
    // acknowledged only after its insert commits").
    reply.code(200);
    return { poll_id: result.poll.poll_id, option_id: result.option_id, viewer_id: viewerId, counted: true };
  });

  app.get("/polls", async () => module.publicPolls());
}
