import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { JsonlRecorder } from "./recorder.js";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "jsonl-recorder-test-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("JsonlRecorder rejects an invalid session_key before touching the filesystem", () => {
  test('a path-traversal-shaped key ("../x") is rejected, and no directory is created', async () => {
    const recorder = new JsonlRecorder(rootDir);

    await expect(recorder.writeSession({ session_key: "../x" }, "../x")).rejects.toThrow(/invalid session_key/);
    await expect(recorder.appendRows("../x", "position", [{ a: 1 }])).rejects.toThrow(/invalid session_key/);

    expect(await readdir(rootDir)).toEqual([]);
  });

  test("a non-integer session_key (1.5) is rejected, and no directory is created", async () => {
    const recorder = new JsonlRecorder(rootDir);

    await expect(recorder.writeSession({ session_key: 1.5 }, 1.5)).rejects.toThrow(/invalid session_key/);
    await expect(recorder.appendRows(1.5, "position", [{ a: 1 }])).rejects.toThrow(/invalid session_key/);

    expect(await readdir(rootDir)).toEqual([]);
  });

  test("a negative session_key is rejected, and no directory is created", async () => {
    const recorder = new JsonlRecorder(rootDir);

    await expect(recorder.writeSession({ session_key: -1 }, -1)).rejects.toThrow(/invalid session_key/);

    expect(await readdir(rootDir)).toEqual([]);
  });

  test("a valid integer session_key (string or number) is accepted", async () => {
    const recorder = new JsonlRecorder(rootDir);

    await recorder.writeSession({ session_key: 11361 }, "11361");

    expect(await readdir(rootDir)).toEqual(["11361"]);
  });
});
