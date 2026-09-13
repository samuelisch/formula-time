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
    {
      if?: string;
      needs?: string | string[];
      steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
    }
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

  test("workflow_dispatch requires a confirm input", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const dispatch = wf.on.workflow_dispatch as { inputs?: Record<string, { required?: boolean }> };
    expect(dispatch.inputs?.confirm?.required).toBe(true);
  });

  test("apply-pinned is unchanged: railwayapp/config@v1 apply, guarded by the push event", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const job = wf.jobs["apply-pinned"];
    expect(job.if).toContain("github.event_name == 'push'");
    const steps = job.steps ?? [];
    const applyStep = steps.find((s) => s.uses?.startsWith("railwayapp/config"));
    expect(applyStep?.with?.command).toBe("apply");
  });

  test("apply-manual only runs on a dispatch with confirm set to apply", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const job = wf.jobs["apply-manual"];
    expect(job.if).toContain("workflow_dispatch");
    expect(job.if).toContain("github.event.inputs.confirm == 'apply'");
  });

  test("apply-manual installs the repository's dependencies before planning", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const job = wf.jobs["apply-manual"];
    const steps = job.steps ?? [];
    const planIndex = steps.findIndex((s) => s.name === "Plan");
    const pnpmSetupIndex = steps.findIndex((s) => s.uses?.startsWith("pnpm/action-setup"));
    const installIndex = steps.findIndex((s) => s.run?.includes("pnpm install --frozen-lockfile"));
    expect(planIndex).toBeGreaterThan(-1);
    expect(pnpmSetupIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(-1);
    expect(pnpmSetupIndex).toBeLessThan(planIndex);
    expect(installIndex).toBeLessThan(planIndex);
  });

  test("apply-manual never passes --confirm-destructive", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const job = wf.jobs["apply-manual"];
    const steps = job.steps ?? [];
    for (const step of steps) {
      expect(step.run ?? "").not.toContain("--confirm-destructive");
    }
  });

  test("the destroy-count check tolerates an unparseable plan instead of dying on a bare pipefail", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const job = wf.jobs["apply-manual"];
    const steps = job.steps ?? [];
    const destroyCheck = steps.find((s) => s.name === "Fail if the plan would destroy anything");
    const script = destroyCheck?.run ?? "";
    // The summary-line grep is expected to fail (no match) when the CLI's
    // output format changes; under `set -e` that would abort the step
    // before the "cannot read the plan summary" diagnostic ever runs
    // unless the grep's own failure is caught.
    const summaryLineAssignment = script.split("\n").find((line) => line.includes("summary_line="));
    expect(summaryLineAssignment).toMatch(/\|\|\s*true\s*$/);
  });

  test("apply-manual pins an exact @railway/cli version", () => {
    const wf = loadWorkflow("railway-apply.yml");
    const job = wf.jobs["apply-manual"];
    const steps = job.steps ?? [];
    const installStep = steps.find((s) => s.run?.includes("@railway/cli"));
    const match = installStep?.run?.match(/@railway\/cli@([0-9.]+)/);
    expect(match?.[1]).toMatch(/^[0-9.]+$/);
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

  test("checks the api's reported build against the released commit", () => {
    const wf = loadWorkflow("release.yml");
    const steps = wf.jobs.smoke.steps ?? [];
    const apiStep = steps.find((s) => s.name?.includes("api"));
    expect(apiStep?.run).toContain("$GITHUB_SHA");
    expect(apiStep?.run).toContain('"build"');
  });

  test("checks the netlify bundle's build meta against the released commit", () => {
    const wf = loadWorkflow("release.yml");
    const steps = wf.jobs.smoke.steps ?? [];
    const siteStep = steps.find((s) => s.name?.toLowerCase().includes("netlify"));
    expect(siteStep?.run).toContain("$GITHUB_SHA");
    expect(siteStep?.run).toContain('name="build"');
  });
});
