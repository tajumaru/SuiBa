import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

// Minimal, enforceable lint set: the typescript-eslint recommended
// rules plus the two react-hooks rules that catch real bugs. Style
// stays with Prettier (the format script); this config is about
// correctness. Gate policy: unused names are errors (CI fails),
// explicit `any` is a warning (visible, not yet gated), and empty
// catch blocks are allowed — fail-closed code often swallows on
// purpose and the interesting failures are handled inside.
export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      // The preflight scripts require() node:crypto into a local
      // `crypto`; Node's webcrypto global of the same name is off.
      globals: { ...globals.node, crypto: "off" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
