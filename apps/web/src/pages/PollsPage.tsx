// GET /api/polls only fills the page before the first push arrives; once a
// push has been received, the displayed push's polls override it (issue #51
// decision) -- so the delayed viewer still only sees polls as of their own
// moment, never the live edge.
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
