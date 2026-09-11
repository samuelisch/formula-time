import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// WEB_PORT and API_PORT come from scripts/db-env.sh (via `pnpm dev:web`
// running through scripts/with-db-env.sh), so two worktrees' dev servers
// never fight over 5173 or proxy to the wrong worktree's api on 3000.
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiOrigin = `http://localhost:${process.env.API_PORT ?? 3000}`;

// Dev server proxies the api's routes to the app service (ADR-0002); every
// api call goes through `/api` (src/api.ts) or `/health` (the platform
// probe). `/live` and `/polls` are SPA routes (Shell's nav, RacesPage's
// links) -- proxying those bare prefixes too, from before the `/api`
// prefix existed, shadowed those routes on a hard reload (issue #72).
// Production serves the built assets from the platform CDN or the app.
export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    proxy: {
      "/health": apiOrigin,
      "/api": apiOrigin,
    },
  },
});
