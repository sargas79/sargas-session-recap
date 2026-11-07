// Local config so vitest does not walk up and pick the repo-root vitest.config.ts (T01),
// which imports packages that are not installed in this isolated spike.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
