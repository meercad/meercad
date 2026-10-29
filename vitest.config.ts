import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    // Kernel tests run about three times slower on the CI runner than on a Mac.
    testTimeout: 120_000,
  },
});
