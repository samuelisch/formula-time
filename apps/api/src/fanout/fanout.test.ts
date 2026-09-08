import { constants as zlibConstants, inflateRawSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import { Fanout } from "./fanout.js";

class FakeRes {
  public chunks: Buffer[] = [];
  public writableLength = 0;
  public destroyed = false;

  public write(chunk: Buffer): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  public destroy(): this {
    this.destroyed = true;
    return this;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asRes(fake: FakeRes): any {
  return fake;
}

describe("Fanout", () => {
  test("two sockets receive byte-identical buffers from the same push", async () => {
    const fanout = new Fanout();
    const a = new FakeRes();
    const b = new FakeRes();
    await fanout.join(asRes(a), "gzip");
    await fanout.join(asRes(b), "gzip");

    await fanout.push({ type: "state", seq: "1" });

    const lastA = a.chunks[a.chunks.length - 1];
    const lastB = b.chunks[b.chunks.length - 1];
    expect(lastA).toBeDefined();
    expect(lastA?.equals(lastB as Buffer)).toBe(true);
  });

  test("a socket joining after two pushes gets the header + only the latest block, which decodes alone", async () => {
    const fanout = new Fanout();
    const early = new FakeRes();
    await fanout.join(asRes(early), "gzip");

    await fanout.push({ n: 1 });
    await fanout.push({ n: 2 });

    const late = new FakeRes();
    await fanout.join(asRes(late), "gzip");

    // header, then exactly one data block (the latest push's, n:2).
    expect(late.chunks).toHaveLength(2);
    expect(late.chunks[0]?.equals(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]))).toBe(
      true,
    );

    const block = late.chunks[1] as Buffer;
    const decoded = inflateRawSync(block, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    expect(decoded.toString("utf8")).toBe(`event: state\ndata: ${JSON.stringify({ n: 2 })}\n\n`);
  });

  test("a socket over the writableLength limit is destroyed and removed on the next push", async () => {
    const fanout = new Fanout();
    const slow = new FakeRes();
    const fine = new FakeRes();
    await fanout.join(asRes(slow), "plain");
    await fanout.join(asRes(fine), "plain");

    expect(fanout.size()).toBe(2);

    slow.writableLength = 2_000_000; // over the 1_048_576 limit
    await fanout.push({ n: 1 });

    expect(slow.destroyed).toBe(true);
    expect(fanout.size()).toBe(1);
    expect(fine.destroyed).toBe(false);
  });

  test("overlapping pushes coalesce to the newest payload; intermediate ones are dropped", async () => {
    const fanout = new Fanout();
    const res = new FakeRes();
    await fanout.join(asRes(res), "plain");

    const p1 = fanout.push({ n: 1 });
    const p2 = fanout.push({ n: 2 });
    const p3 = fanout.push({ n: 3 });
    await Promise.all([p1, p2, p3]);

    const delivered = res.chunks
      .map((chunk) => chunk.toString("utf8"))
      .filter((frame) => frame.startsWith("event: state"))
      .map((frame) => JSON.parse(frame.split("data: ")[1] ?? "{}") as { n: number });

    // The first push (already in flight when 2 and 3 arrived) is delivered;
    // 2 is dropped in favour of 3, the newest payload queued behind it.
    expect(delivered).toEqual([{ n: 1 }, { n: 3 }]);
  });
});
