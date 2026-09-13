// Runs a real `vite build` (not a read of the source file) to confirm
// vite.config.ts's csp-headers plugin: dist/_headers' connect-src carries
// VITE_API_URL when it is set, and drops the "%VITE_API_URL%" placeholder
// entirely (never shipping it literally, never a stray trailing space)
// when it is unset -- the dev/relative-URL build. Also confirms the build
// fails outright on a malformed VITE_API_URL rather than shipping a CSP a
// stray character has broken. Netlify applies dist/_headers verbatim, so
// this is what actually reaches a browser. Runs in the plain-node vitest
// project like build-meta.node.test.ts -- see tsconfig.node-test.json and
// vitest.config.ts's "web-node" project.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const BUILD_TIMEOUT_MS = 60_000;

const outDirs: string[] = [];

afterEach(() => {
  while (outDirs.length > 0) {
    rmSync(outDirs.pop()!, { recursive: true, force: true });
  }
});

async function buildHeaders(apiUrl: string | undefined): Promise<string> {
  const outDir = mkdtempSync(path.join(tmpdir(), "headers-build-"));
  outDirs.push(outDir);

  const previous = process.env.VITE_API_URL;
  if (apiUrl === undefined) delete process.env.VITE_API_URL;
  else process.env.VITE_API_URL = apiUrl;

  try {
    await build({
      root,
      configFile: path.join(root, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (previous === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previous;
  }
  return readFileSync(path.join(outDir, "_headers"), "utf8");
}

function cspOf(headers: string): string {
  const match = /^ {2}Content-Security-Policy: (.+)$/m.exec(headers);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe.skipIf(process.env.CI_FAST)("vite build fills VITE_API_URL into dist/_headers' CSP", () => {
  test(
    "VITE_API_URL set (the production shape) names that origin in connect-src",
    async () => {
      const headers = await buildHeaders("https://api-production-8fbf2.up.railway.app");
      const csp = cspOf(headers);
      expect(csp).toContain("connect-src 'self' https://api-production-8fbf2.up.railway.app;");
      expect(csp).not.toContain("%VITE_API_URL%");
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "VITE_API_URL unset (the dev/relative-URL shape) drops the placeholder, leaving 'self' alone",
    async () => {
      const headers = await buildHeaders(undefined);
      const csp = cspOf(headers);
      expect(csp).toContain("connect-src 'self';");
      expect(csp).not.toContain("%VITE_API_URL%");
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "every other directive and the other security headers are unaffected",
    async () => {
      const headers = await buildHeaders("https://api-production-8fbf2.up.railway.app");
      const csp = cspOf(headers);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).toContain("img-src 'self' data: blob:");
      expect(csp).toContain("media-src 'self' blob:");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(headers).toMatch(/^ {2}X-Content-Type-Options: nosniff$/m);
      expect(headers).toMatch(/^ {2}Referrer-Policy: strict-origin-when-cross-origin$/m);
      expect(headers).toMatch(/^ {2}Strict-Transport-Security: max-age=31536000$/m);
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "a malformed VITE_API_URL fails the build instead of shipping a broken CSP",
    async () => {
      await expect(buildHeaders("https://evil.example; script-src *")).rejects.toThrow(/VITE_API_URL/);
    },
    BUILD_TIMEOUT_MS,
  );
});
