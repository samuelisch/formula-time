import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// WEB_PORT and API_PORT come from scripts/db-env.sh (via `pnpm dev:web`
// running through scripts/with-db-env.sh), so two worktrees' dev servers
// never fight over 5173 or proxy to the wrong worktree's api on 3000.
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiOrigin = `http://localhost:${process.env.API_PORT ?? 3000}`;

// ADR-0008: VITE_API_URL is the one place that knows the api's origin, so
// the CSP's connect-src is derived from it rather than a second,
// hand-maintained literal -- a custom-domain move stays "one config value,
// no code change". Trimmed the same way src/api.ts trims it, since a
// trailing slash would turn the CSP entry from an origin match into a
// path-exact match.
const apiOriginForCsp = process.env.VITE_API_URL?.replace(/\/$/, "");

// The running build's own commit SHA (ADR-0021): an explicit override
// first, then whichever platform sets its own variable -- Netlify's
// COMMIT_REF for the deployed site, GitHub Actions' GITHUB_SHA for the e2e
// build -- so no per-platform build-command configuration is needed. The
// literal %VITE_GIT_SHA% placeholder must never ship, hence "unknown" as
// the last resort.
const buildSha = process.env.VITE_GIT_SHA ?? process.env.COMMIT_REF ?? process.env.GITHUB_SHA ?? "unknown";

// Vite's own %ENV_NAME% substitution in index.html only fires for vars it
// already sees as `import.meta.env` (its VITE_-prefixed env files), which
// excludes COMMIT_REF and GITHUB_SHA -- so the fallback chain above is
// resolved by hand and substituted here instead.
function buildMetaPlugin(sha: string): Plugin {
  return {
    name: "build-meta",
    transformIndexHtml(html) {
      return html.replaceAll("%VITE_GIT_SHA%", sha);
    },
  };
}

// A source expression the CSP's connect-src can hold: scheme://host, no
// ';' (would end the directive early and let the rest of its value inject
// new ones), no quote (would close the directive's own quoting), no
// whitespace (would split into multiple, unintended source expressions).
const VALID_CSP_ORIGIN = /^https?:\/\/[^;'"\s]+$/;

// public/_headers carries the literal placeholder "%VITE_API_URL%" in its
// connect-src directive; this fills it in on the built dist/_headers the
// same way buildMetaPlugin fills the build SHA into index.html, so the
// api's origin is declared in exactly the one place (VITE_API_URL) ADR-0008
// names. No origin (a dev build using relative /api URLs) drops the token
// entirely rather than shipping the literal placeholder or a stray space.
// A malformed origin fails the build rather than shipping a CSP silently
// broken (or silently permissive) in a way nothing else would catch.
function cspHeadersPlugin(apiOrigin: string | undefined): Plugin {
  let headersPath = "";
  return {
    name: "csp-headers",
    configResolved(config) {
      if (apiOrigin !== undefined && !VALID_CSP_ORIGIN.test(apiOrigin)) {
        throw new Error(
          `VITE_API_URL "${apiOrigin}" is not a valid Content-Security-Policy source (expected "http(s)://host", with no ';', quote, or whitespace) -- refusing to build a broken CSP into dist/_headers`,
        );
      }
      headersPath = path.isAbsolute(config.build.outDir) ? config.build.outDir : path.join(config.root, config.build.outDir);
      headersPath = path.join(headersPath, "_headers");
    },
    closeBundle() {
      if (!existsSync(headersPath)) return; // e.g. a build with no public/_headers to copy
      const contents = readFileSync(headersPath, "utf8");
      writeFileSync(headersPath, contents.replace(" %VITE_API_URL%", apiOrigin ? ` ${apiOrigin}` : ""));
    },
  };
}

// @formula-time/domain's `exports` point at dist/, so a build started from a
// test would need `tsc -b` first. Vitest sets VITEST in every worker,
// including the one that calls a real `vite build()` in
// src/build-meta.node.test.ts and src/_headers.node.test.ts, so a test-time
// build reads the domain package from its source and a missing or stale
// packages/domain/dist can never fail a test. A dev server and a production
// build see no VITEST, get no alias, and keep resolving the built package
// through its `exports` exactly as before. Exported so a test can assert
// both branches.
const domainSrc = fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url));

export function domainAlias(env: NodeJS.ProcessEnv): Record<string, string> {
  return env.VITEST ? { "@formula-time/domain": domainSrc } : {};
}

// Dev server proxies the api's routes to the app service (ADR-0002); every
// api call goes through `/api` (src/api.ts) or `/health` (the platform
// probe). `/live` and `/polls` are SPA routes (Shell's nav, RacesPage's
// links) -- proxying those bare prefixes too, from before the `/api`
// prefix existed, shadowed those routes on a hard reload (issue #72).
// Production serves the built assets from the platform CDN or the app.
export default defineConfig({
  plugins: [react(), buildMetaPlugin(buildSha), cspHeadersPlugin(apiOriginForCsp)],
  resolve: {
    alias: domainAlias(process.env),
  },
  server: {
    port: webPort,
    proxy: {
      "/health": apiOrigin,
      "/api": apiOrigin,
    },
  },
});
