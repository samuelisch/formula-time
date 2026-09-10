import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRaceFile } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRaceFile", () => {
  it("requests the file with a v query equal to Date.parse(exportedAt)", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchRaceFile(11361, "2026-09-06T15:10:00.000Z");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`/api/races/11361?v=${Date.parse("2026-09-06T15:10:00.000Z")}`);
  });
});
