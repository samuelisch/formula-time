import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// vitest.config.ts does not set test.globals, so React Testing Library's
// automatic afterEach cleanup never registers; do it explicitly.
afterEach(() => {
  cleanup();
});
