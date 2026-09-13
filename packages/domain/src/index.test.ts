import { describe, expect, it } from "vitest";
import { createInitialState, DOMAIN_PACKAGE } from "./index.js";
import type {
  DeltaPush,
  PollOptionPublic,
  PollPublic,
  RaceEventsPage,
  RaceFile,
  RaceIndexEntry,
  StatePush,
  StatusFrame,
} from "./index.js";

describe("domain package", () => {
  it("exports its name", () => {
    expect(DOMAIN_PACKAGE).toBe("@formula-time/domain");
  });

  it("exports the poll wire types", () => {
    const option: PollOptionPublic = { id: "a", label: "A" };
    const poll: PollPublic = {
      poll_id: "race:winner",
      kind: "winner",
      question: "Who wins?",
      options: [option],
      locks_at_lap: 1,
      status: "open",
      tally: {},
      total_votes: 0,
      winning_option_ids: null,
    };
    expect(poll.kind).toBe("winner");
  });

  // The push/index wire types are exports of `./wire.js` re-exported here
  // (packages/domain/src/wire.ts, issue #261): a typed fixture literal per
  // shape is the compile-time assertion -- these types are erased, so
  // there is nothing to check at runtime beyond "the fixture compiles".
  it("exports the push and index wire types", () => {
    const state = createInitialState({ sessions: [], drivers: [] });

    const statePush: StatePush = {
      type: "state",
      seq: "1",
      sent_at: 1000,
      session_key: "42",
      total_laps: 50,
      state,
      polls: [],
      events: [],
    };
    expect(statePush.type).toBe("state");

    const deltaPush: DeltaPush = {
      type: "delta",
      seq: "2",
      base_seq: "1",
      sent_at: 1001,
      session_key: "42",
      patch: [],
      polls: [],
    };
    expect(deltaPush.base_seq).toBe("1");

    const statusFrame: StatusFrame = { catching_up: true };
    expect(statusFrame.catching_up).toBe(true);

    const indexEntry: RaceIndexEntry = {
      session_key: 42,
      name: "Spanish Grand Prix",
      country: "Spain",
      date_start: "2026-06-01T00:00:00.000Z",
      date_end: "2026-06-01T02:00:00.000Z",
      total_laps: 66,
      exported_at: "2026-06-01T02:30:00.000Z",
      meeting_name: "Spanish Grand Prix",
      circuit_short_name: "Catalunya",
      location: "Barcelona",
    };
    expect(indexEntry.session_key).toBe(42);

    const eventsPage: RaceEventsPage = {
      session_key: "42",
      status: "finished",
      events: [],
      next_seq: null,
    };
    expect(eventsPage.status).toBe("finished");

    const raceFile: RaceFile = {
      schema: 1,
      exported_at: "2026-06-01T02:30:00.000Z",
      session: { session_key: "42" },
      events: [],
    };
    expect(raceFile.schema).toBe(1);
  });
});
