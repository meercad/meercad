import { defineConfig } from "vitest/config";

/**
 * Test levels (docs/TESTING.md):
 * - unit: packages and app logic, no kernel, seconds.
 * - integration: the kernel end to end through `KernelSession.rebuild`, fast files only.
 * - integration-slow: the same for files that take long (all examples, threads, coils, screws …).
 * - perf: timings and mesh sizes against budgets and a baseline, one file at a time.
 *
 * `pnpm test:quick` = unit + integration (every commit), `pnpm test` = all but perf (PR, before a
 * merge), `pnpm test:perf`, and `pnpm test:release` for everything including E2E.
 */

/** Acceptance files over about 10 s on a 4-core runner. Move a file here when it gets slow. */
export const SLOW = [
  "tests/acceptance/closures.test.ts",
  "tests/acceptance/coil.test.ts",
  "tests/acceptance/collisions.test.ts",
  "tests/acceptance/examples.test.ts",
  "tests/acceptance/gear.test.ts",
  "tests/acceptance/gridfinity.test.ts",
  "tests/acceptance/gridfinity-area.test.ts",
  "tests/acceptance/incremental-all.test.ts",
  "tests/acceptance/joints.test.ts",
  "tests/acceptance/models.test.ts",
  "tests/acceptance/scan-bin.test.ts",
  "tests/acceptance/screw.test.ts",
  "tests/acceptance/thread.test.ts",
  "tests/acceptance/threads.test.ts",
  "tests/acceptance/wall.test.ts",
  "packages/model/src/texture/texture.test.ts",
];

export default defineConfig({
  test: {
    // Kernel tests run about three times slower on the CI runner than on a Mac.
    testTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["packages/*/src/**/*.test.ts", "tests/*.test.ts"], exclude: SLOW },
      },
      {
        extends: true,
        test: { name: "integration", include: ["tests/acceptance/**/*.test.ts"], exclude: SLOW },
      },
      {
        extends: true,
        test: { name: "integration-slow", include: SLOW },
      },
      {
        extends: true,
        test: {
          name: "perf",
          include: ["tests/perf/**/*.perf.ts"],
          // One file at a time and nothing else running, so timings don't disturb each other.
          fileParallelism: false,
          testTimeout: 600_000,
        },
      },
    ],
  },
});
