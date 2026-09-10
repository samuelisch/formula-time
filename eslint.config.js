import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// The plugin's own "recommended" flat config sets rules-of-hooks to error
// and treats every other rule it ships (exhaustive-deps plus the React 19
// compiler-derived checks: refs, purity, immutability, globals, and so on)
// as an error too. Only rules-of-hooks is a hard error here; everything
// else that config lists is downgraded to a warning, matching what the
// plugin itself would call "recommended" once the codebase catches up.
const reactHooksRules = Object.fromEntries(
  Object.keys(reactHooks.configs.flat.recommended.rules).map((ruleId) => [
    ruleId,
    ruleId === "react-hooks/rules-of-hooks" ? "error" : "warn",
  ]),
);

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".claude/worktrees/**",
      "packages/db/src/generated/**",
      "**/*.tsbuildinfo",
      ".railway/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: reactHooksRules,
  },
  {
    // Rules that error on existing source today, downgraded to warn so
    // this pass can land without touching any source file. See the PR
    // body for counts and example files; a later pass fixes the source
    // and raises these back to error.
    rules: {
      // Existing tests bind unused mock args (some already `_`-prefixed,
      // which this rule's default config does not exempt).
      "@typescript-eslint/no-unused-vars": "warn",
      // One `let` in a test fixture that is never reassigned.
      "prefer-const": "warn",
      // One intermediate array reassigned but never read again.
      "no-useless-assignment": "warn",
      // Existing rethrows that drop the caught error instead of chaining
      // it as `cause`.
      "preserve-caught-error": "warn",
    },
  },
);
