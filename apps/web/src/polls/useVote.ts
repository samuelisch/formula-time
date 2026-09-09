// Voting is always live: POST /api/vote via useMutation regardless of the
// viewer's delay, since the server judges the lock against live data
// (PRD §4).
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { apiFetch } from "../api.ts";
import { rememberVote } from "./votes.ts";

export interface VoteVariables {
  pollId: string;
  optionId: string;
}

export interface VoteResponse {
  poll_id: string;
  option_id: string;
  viewer_id: string;
  counted: boolean;
}

interface VoteErrorPayload {
  error?: string;
}

async function postVote(variables: VoteVariables): Promise<VoteResponse> {
  const response = await apiFetch("/api/vote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ poll_id: variables.pollId, option_id: variables.optionId }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = typeof (payload as VoteErrorPayload).error === "string" ? (payload as VoteErrorPayload).error : "Vote rejected";
    throw new Error(message);
  }
  return payload as VoteResponse;
}

/**
 * Wraps the vote mutation: on a 200, remembers the pick in localStorage under
 * `poll-vote-{poll_id}` (votes.ts); a 409 (or other non-2xx) surfaces the
 * server's `error` text as the mutation's error so the card can show it --
 * the viewer's delayed card may still say the poll is open.
 */
export function useVote(): UseMutationResult<VoteResponse, Error, VoteVariables> {
  return useMutation({
    mutationFn: postVote,
    onSuccess: (_result, variables) => {
      rememberVote(variables.pollId, variables.optionId);
    },
  });
}
