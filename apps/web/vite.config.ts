import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies the api's routes to the app service (ADR-0002); every
// api call goes through `/api` (src/api.ts) or `/health` (the platform
// probe). `/live` and `/polls` are SPA routes (Shell's nav, RacesPage's
// links) -- proxying those bare prefixes too, from before the `/api`
// prefix existed, shadowed those routes on a hard reload (issue #72).
// Production serves the built assets from the platform CDN or the app.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/health": "http://localhost:3000",
      "/api": "http://localhost:3000",
    },
  },
});
