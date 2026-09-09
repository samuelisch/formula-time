// Unit tests: in-memory fake stands in for PrismaClient (the pattern in
// exporter.test.ts). File deletion is real (an OS temp dir) -- only the
// database is faked.
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@formula-time/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runPrune } from "./prune-exports.js";

interface FakeExportRow {
  sessionKey: bigint;
  exportedAt: Date;
  path: string;
}

interface FakeEventRow {
  seq: bigint;
  sessionKey: bigint;
  endpoint: string;
}

function makeFakeDb(exports: FakeExportRow[], events: FakeEventRow[]) {
  const deleted: bigint[] = [];
  return {
    deleted,
    export: {
      findMany: vi.fn(async () => exports.map(({ sessionKey, path }) => ({ sessionKey, path }))),
      delete: vi.fn(async ({ where }: { where: { sessionKey: bigint } }) => {
        deleted.push(where.sessionKey);
        return exports.find((e) => e.sessionKey === where.sessionKey);
      }),
    },
    event: {
      findFirst: vi.fn(
        async ({ where }: { where: { sessionKey: bigint; endpoint: { not: string } } }) => {
          const found = events.find(
            (e) => e.sessionKey === where.sessionKey && e.endpoint !== where.endpoint.not,
          );
          return found === undefined ? null : { seq: found.seq };
        },
      ),
    },
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "prune-exports-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("runPrune", () => {
  test("dry run: logs what would be pruned, deletes nothing", async () => {
    const bogusPath = join(tmpRoot, "1.json.gz");
    await writeFile(bogusPath, "not really gzip");
    const db = makeFakeDb(
      [{ sessionKey: 1n, exportedAt: new Date(), path: bogusPath }],
      [{ seq: 1n, sessionKey: 1n, endpoint: "drivers" }],
    );

    const log = vi.fn();
    const summary = await runPrune({ db: db as unknown as PrismaClient, apply: false, log });

    expect(summary).toEqual({ checked: 1, pruned: 1 });
    expect(db.deleted).toHaveLength(0);
    expect(log).toHaveBeenCalledWith("would prune export 1");
    await expect(access(bogusPath)).resolves.toBeUndefined();
  });

  test("apply: deletes the file and the row for a session with no timing events", async () => {
    const bogusPath = join(tmpRoot, "2.json.gz");
    await writeFile(bogusPath, "not really gzip");
    const db = makeFakeDb(
      [{ sessionKey: 2n, exportedAt: new Date(), path: bogusPath }],
      [{ seq: 1n, sessionKey: 2n, endpoint: "drivers" }],
    );

    const log = vi.fn();
    const summary = await runPrune({ db: db as unknown as PrismaClient, apply: true, log });

    expect(summary).toEqual({ checked: 1, pruned: 1 });
    expect(db.deleted).toEqual([2n]);
    expect(log).toHaveBeenCalledWith("pruning export 2");
    await expect(access(bogusPath)).rejects.toThrow();
  });

  test("apply: a session with a timing event is left alone", async () => {
    const goodPath = join(tmpRoot, "3.json.gz");
    await writeFile(goodPath, "not really gzip");
    const db = makeFakeDb(
      [{ sessionKey: 3n, exportedAt: new Date(), path: goodPath }],
      [{ seq: 1n, sessionKey: 3n, endpoint: "position" }],
    );

    const log = vi.fn();
    const summary = await runPrune({ db: db as unknown as PrismaClient, apply: true, log });

    expect(summary).toEqual({ checked: 1, pruned: 0 });
    expect(db.deleted).toHaveLength(0);
    await expect(access(goodPath)).resolves.toBeUndefined();
  });

  test("apply: a missing file is not an error, the row is still deleted", async () => {
    const missingPath = join(tmpRoot, "does-not-exist.json.gz");
    const db = makeFakeDb(
      [{ sessionKey: 4n, exportedAt: new Date(), path: missingPath }],
      [],
    );

    const log = vi.fn();
    await expect(
      runPrune({ db: db as unknown as PrismaClient, apply: true, log }),
    ).resolves.toEqual({ checked: 1, pruned: 1 });
    expect(db.deleted).toEqual([4n]);
  });
});
