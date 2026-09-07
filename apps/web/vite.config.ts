import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies API and SSE routes to the app service (ADR-0002).
// Production serves the built assets from the platform CDN or the app.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/health": "http://localhost:3000",
      "/api": "http://localhost:3000",
      "/live": "http://localhost:3000",
      "/polls": "http://localhost:3000",
    },
  },
});
