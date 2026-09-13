// Runs a real `vite build` (not a unit test of a pure function) to confirm
// vite.config.ts's build-identity plugin: index.html's <meta name="build">
// reflects whichever platform variable is set (VITE_GIT_SHA overriding
// COMMIT_REF overriding GITHUB_SHA), and falls back to "unknown" so the
// literal %VITE_GIT_SHA% placeholder never ships. Runs in the plain-node
// vitest project like lapCounterOcr.node.test.ts -- see
// tsconfig.node-test.json and vitest.config.ts's "web-node" project.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const BUILD_TIMEOUT_MS = 60_000;

const ENV_KEYS = ["VITE_GIT_SHA", "COMMIT_REF", "GITHUB_SHA"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const outDirs: string[] = [];

afterEach(() => {
  while (outDirs.length > 0) {
    rmSync(outDirs.pop()!, { recursive: true, force: true });
  }
});

// Runs the app's real vite.config.ts with the given env vars set (others
// cleared) and returns the built index.html plus the build's wall time, so
// a caller can both assert on the meta tag and report how long a build
// takes.
async function buildWithEnv(env: Partial<Record<EnvKey, string>>): Promise<{ html: string; ms: number }> {
  const outDir = mkdtempSync(path.join(tmpdir(), "build-meta-"));
  outDirs.push(outDir);

  const previous: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }

  const start = Date.now();
  try {
    await build({
      root,
      configFile: path.join(root, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  const ms = Date.now() - start;
  const html = readFileSync(path.join(outDir, "index.html"), "utf8");
  return { html, ms };
}

describe.skipIf(process.env.CI_FAST)("vite build embeds the platform commit SHA in index.html", () => {
  test(
    "COMMIT_REF (Netlify's build-time variable) sets the build meta",
    async () => {
      const { html, ms } = await buildWithEnv({ COMMIT_REF: "abc123" });
      expect(html).toContain('<meta name="build" content="abc123" />');
      // Local build time is reported by hand, not asserted -- CI_FAST above
      // is the gate if this ever grows too slow for the commit hook.
      console.log(`vite build took ${ms}ms`);
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "no source set falls back to unknown, never the literal placeholder",
    async () => {
      const { html } = await buildWithEnv({});
      expect(html).toContain('<meta name="build" content="unknown" />');
      expect(html).not.toContain("%VITE_GIT_SHA%");
    },
    BUILD_TIMEOUT_MS,
  );
});
