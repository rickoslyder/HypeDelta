// Flat ESLint config for the root TypeScript package (src/).
// The Next.js web app (apps/web) has its own eslint.config.mjs.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "apps/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // This codebase intentionally uses dynamic shapes from LLM/JSON output.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Surface unused code as warnings, allowing intentional _-prefixed args.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Empty catch blocks are used deliberately for best-effort parsing/cleanup.
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    // Tests run under vitest globals and mock freely.
    files: ["src/**/*.test.ts", "src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  }
);
