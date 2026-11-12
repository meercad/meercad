import { defineConfig } from "vitest/config";

/** The UI end-to-end run (`pnpm test:e2e`): every *.e2e.ts, one file (and app) after another. */
export default defineConfig({
  test: {
    root: new URL("../..", import.meta.url).pathname,
    include: [process.env["E2E_FILE"] ?? "tests/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
