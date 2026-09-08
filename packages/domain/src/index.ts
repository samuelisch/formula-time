// @formula-time/domain runs in Node and in the browser.
// Rule (ADR-0002): nothing in this package may import a `node:*` module.
// tsconfig enforces it with `types: []` and `lib: ["ES2022"]`.

export const DOMAIN_PACKAGE = "@formula-time/domain";
