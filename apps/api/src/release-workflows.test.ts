import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as yaml from "js-yaml";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, { needs?: string | string[]; steps?: Array<{ name?: string; run?: string }> }>;
}

function loadWorkflow(name: string): Workflow {
  const text = readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
  return yaml.load(text) as Workflow;
}

describe("railway-apply.yml", () => {
  test("fires on every push to release, with no paths filter", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const onPush = wf.on.push as { branches: string[]; paths?: string[] };
    expect(onPush.branches).toEqual(["release"]);
    expect(onPush.paths).toBeUndefined();
  });

  test("also runs on workflow_dispatch so the owner can re-run it by hand", () => {
    const wf = loadWorkflow("railway-apply.yml");
    expect("workflow_dispatch" in wf.on).toBe(true);
  });
});

describe("release.yml smoke job", () => {
  test("needs the gate job and can read Actions runs", () => {
    const wf = loadWorkflow("release.yml");
    expect(wf.jobs.smoke.needs).toBe("gate");
    expect(wf.permissions?.actions).toBe("read");
  });

  test("waits for railway-apply.yml on the same commit before smoke-testing", () => {
    const wf = loadWorkflow("release.yml");
    const steps = wf.jobs.smoke.steps ?? [];
    const waitStep = steps[0];
    expect(waitStep?.run).toContain("railway-apply.yml");
    expect(waitStep?.run).toContain("gh run list");
  });
});
