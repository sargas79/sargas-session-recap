import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests never touch a real Claude CLI or the Claude API. The API harness
    // and live-check script are excluded from test imports by construction.
    testTimeout: 20_000,
  },
});
