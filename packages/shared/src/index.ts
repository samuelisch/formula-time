// @formula-time/shared runs in Node and in the browser.
// Rule (ADR-0002): nothing in this package may import a `node:*` module.
// tsconfig enforces it with `types: []` and `lib: ["ES2022"]`.

export const SHARED_PACKAGE = "@formula-time/shared";
