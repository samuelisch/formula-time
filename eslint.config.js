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
);
