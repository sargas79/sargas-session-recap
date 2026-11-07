import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    files: ["src/main.ts", "src/foundry/**/*.ts", "src/foundry-globals.d.ts", "test/**/*.ts"],
    rules: {
      // Foundry's runtime API is untyped in this throwaway spike (no community type package pinned).
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
