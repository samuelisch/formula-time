// Netlify applies public/_headers verbatim to the deployed site; this
// reads that file directly so a change to the policy is caught here
// rather than only after a deploy (`vite preview` does not honour it).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const headersPath = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "_headers");
const headers = readFileSync(headersPath, "utf8");

describe("public/_headers", () => {
  it("carries a Content-Security-Policy naming this origin and the api's own origin, nothing else", () => {
    const match = /^ {2}Content-Security-Policy: (.+)$/m.exec(headers);
    expect(match).not.toBeNull();
    const csp = match![1]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' https://api-production-8fbf2.up.railway.app");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("carries the other security headers alongside the CSP", () => {
    expect(headers).toMatch(/^ {2}X-Content-Type-Options: nosniff$/m);
    expect(headers).toMatch(/^ {2}Referrer-Policy: strict-origin-when-cross-origin$/m);
    expect(headers).toMatch(/^ {2}Strict-Transport-Security: max-age=31536000$/m);
  });
});
