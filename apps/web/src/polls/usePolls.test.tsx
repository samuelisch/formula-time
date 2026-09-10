// Polls come off the board push (`useBoardPush()`), not the live store
// directly, so a mounted `BoardSourceProvider` (a replay) sees that
// provider's polls -- always `polls: []` for a folded race -- while the
// live SSE connection the shell keeps open on every route is ignored. With
// no provider, the hook falls back to the live store, so the live route is
// unchanged.
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { BoardSourceProvider } from "../board/useBoardState.ts";
import { useLiveStore } from "../live/store.ts";
import { makePush } from "../test/fixtures.ts";
import { makePoll } from "./pollFixtures.ts";
import { usePolls } from "./usePolls.ts";

const LIVE_POLL = makePoll({ poll_id: "9999:winner", status: "open" });

function seedLiveStore(): void {
  useLiveStore.setState({ displayed: makePush({ polls: [LIVE_POLL] }) });
}

describe("usePolls", () => {
  afterEach(() => {
    useLiveStore.setState({ displayed: null });
  });

  it("returns the live store's polls when no board source is provided (the live route)", () => {
    seedLiveStore();
    const { result } = renderHook(() => usePolls());
    expect(result.current).toEqual([LIVE_POLL]);
  });

  it("returns the provider's polls, not the live store's, when a board source is mounted (a replay)", () => {
    seedLiveStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BoardSourceProvider push={makePush({ polls: [] })}>{children}</BoardSourceProvider>
    );
    const { result } = renderHook(() => usePolls(), { wrapper });
    expect(result.current).toEqual([]);
  });
});
