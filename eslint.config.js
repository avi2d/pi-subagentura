import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Apply the recommended rules from @eslint/js
  js.configs.recommended,
  // Apply TypeScript rules
  ...tseslint.configs.recommended,
  {
    // TypeScript-specific rules
    rules: {
      // ── Catch TDZ errors ─────────────────────────────────────────────
      // This rule catches variables used before their declaration,
      // which causes "Cannot access 'X' before initialization" runtime errors.
      // Previously, liveStatus was declared after an early-return branch,
      // causing this exact bug with subagent_with_context/sessionDir.
      "no-use-before-define": ["error", {
        functions: false,
        classes: true,
        variables: true,
        allowNamedExports: false,
      }],
    },
  },
  {
    // Target TypeScript files
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
  },
);
