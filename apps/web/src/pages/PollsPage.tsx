// GET /api/polls only fills the page before the first push arrives; once a
// push has been received, the displayed push's polls override it (issue #51
// decision) -- so the delayed viewer still only sees polls as of their own
// moment, never the live edge.
//
// This fallback reads live tallies/statuses straight from the api (no delay
// applied) and is safe only because delayMs always starts at 0 (live edge)
// and is never persisted across a reload -- so this window is always "no
// push yet", never "a delayed viewer with no push yet". Whoever persists
// delay (apps/web/AGENTS.md: the ring-buffer/persisted-delay work is a
// post-deploy item) must revisit this: a restored non-zero delay reaching
// this fallback before the first push would show live poll state to a
// viewer who asked to be behind it.
import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "../api.ts";
import { Card } from "../components/Card.tsx";
import { useDisplayed } from "../live/selectors.ts";
import type { PollPublic } from "../live/types.ts";
import { PollList } from "../polls/PollList.tsx";

async function fetchInitialPolls(): Promise<PollPublic[]> {
  const response = await apiFetch("/api/polls");
  if (!response.ok) throw new Error("Failed to load polls");
  return (await response.json()) as PollPublic[];
}

export function PollsPage() {
  const displayed = useDisplayed();
  const initialFill = useQuery({
    queryKey: ["polls"],
    queryFn: fetchInitialPolls,
    enabled: displayed === null,
  });

  const polls = displayed !== null ? displayed.polls : (initialFill.data ?? []);

  return (
    <Card>
      <PollList polls={polls} />
    </Card>
  );
}
