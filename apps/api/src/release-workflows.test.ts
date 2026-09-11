import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as yaml from "js-yaml";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    { needs?: string | string[]; steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }> }
  >;
}

function loadWorkflow(name: string): Workflow {
  const text = readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
  return yaml.load(text) as Workflow;
}

describe("railway-apply.yml", () => {
  test("fires only on a push to release that touches .railway/**", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const onPush = wf.on.push as { branches: string[]; paths?: string[] };
    expect(onPush.branches).toEqual(["release"]);
    expect(onPush.paths).toEqual([".railway/**"]);
  });

  test("also runs on workflow_dispatch so the owner can re-run it by hand", () => {
    const wf = loadWorkflow("railway-apply.yml");
    expect("workflow_dispatch" in wf.on).toBe(true);
  });
});

describe("release.yml plan job", () => {
  test("needs the gate job and runs railwayapp/config in plan mode", () => {
    const wf = loadWorkflow("release.yml");
    expect(wf.jobs.plan.needs).toBe("gate");
    const steps = wf.jobs.plan.steps ?? [];
    const planStep = steps.find((s) => s.uses?.startsWith("railwayapp/config"));
    expect(planStep?.with?.command).toBe("plan");
  });

  test("fails the job when the plan is not empty", () => {
    const wf = loadWorkflow("release.yml");
    const steps = wf.jobs.plan.steps ?? [];
    const checkStep = steps.find((s) => s.run?.includes("railway-plan.json"));
    expect(checkStep?.run).toContain("exit 1");
  });
});

describe("release.yml smoke job", () => {
  test("needs the plan job", () => {
    const wf = loadWorkflow("release.yml");
    expect(wf.jobs.smoke.needs).toBe("plan");
  });
});
