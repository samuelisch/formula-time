// ADR-0044: eslint-config-prettier is the last entry in eslint.config.js's
// config array so ESLint's own stylistic rules never disagree with
// Prettier's over the same line. This asserts that holds for ESLint's
// actually-resolved config, not just the source order of the array.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Every rule here is one Prettier also has an opinion on (formatting, not
// correctness). eslint-config-prettier ships all of these turned off; if
// it ever stopped being last, or a future ESLint config re-enabled one,
// this list is exactly where the two tools would start fighting.
const PRETTIER_OWNED_RULES = [
  "indent",
  "quotes",
  "semi",
  "comma-dangle",
  "max-len",
  "@typescript-eslint/indent",
  "@typescript-eslint/quotes",
  "@typescript-eslint/semi",
  "@typescript-eslint/comma-dangle",
];

// ESLint's flat-config rule entries are either a bare severity or
// `[severity, ...options]`; --print-config always prints the array form,
// but this normalizes either shape to a plain severity number.
function ruleSeverity(entry: unknown): number | undefined {
  if (entry === undefined) return undefined;
  return Number(Array.isArray(entry) ? entry[0] : entry);
}

describe("eslint and prettier agree", () => {
  it("eslint-config-prettier turns off every stylistic rule prettier owns", () => {
    // `--silent` keeps pnpm's own stdout (an engines warning on some local
    // Node versions) out of the JSON; the `{` search is a second layer of
    // defense against exactly that kind of stray output.
    const raw = execFileSync("pnpm", ["--silent", "eslint", "--print-config", "apps/api/src/main.ts"], {
      encoding: "utf8",
    });
    const config = JSON.parse(raw.slice(raw.indexOf("{"))) as { rules?: Record<string, unknown> };
    const rules = config.rules ?? {};

    for (const rule of PRETTIER_OWNED_RULES) {
      const severity = ruleSeverity(rules[rule]);
      // Absent (no parent config ever registered it) and explicitly 0
      // (off) both mean ESLint never reports it — either satisfies "the
      // two checks never disagree over the same line".
      expect(
        severity === undefined || severity === 0,
        `${rule} is ${JSON.stringify(rules[rule])}, expected off or absent`,
      ).toBe(true);
    }
  });

  // `pnpm lint` and `pnpm format:check` both passing together on the
  // formatted tree is proven by CI's `checks` job, which runs Lint then
  // Format check in sequence on every push (ADR-0017, ADR-0044); asserting
  // it again here would only duplicate what CI already covers.
});
