import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// WEB_PORT and API_PORT come from scripts/db-env.sh (via `pnpm dev:web`
// running through scripts/with-db-env.sh), so two worktrees' dev servers
// never fight over 5173 or proxy to the wrong worktree's api on 3000.
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiOrigin = `http://localhost:${process.env.API_PORT ?? 3000}`;

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

// Dev server proxies the api's routes to the app service (ADR-0002); every
// api call goes through `/api` (src/api.ts) or `/health` (the platform
// probe). `/live` and `/polls` are SPA routes (Shell's nav, RacesPage's
// links) -- proxying those bare prefixes too, from before the `/api`
// prefix existed, shadowed those routes on a hard reload (issue #72).
// Production serves the built assets from the platform CDN or the app.
export default defineConfig({
  plugins: [react(), buildMetaPlugin(buildSha)],
  server: {
    port: webPort,
    proxy: {
      "/health": apiOrigin,
      "/api": apiOrigin,
    },
  },
});
