import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The app imports its kernel worker the Vite way (`./kernel.worker.ts?worker`, `?worker&url`); in
 * its tests the worker runs in the same process (apps/web/test/kernelWorker.ts). Files imported as
 * URLs (`?url`, the sketch solver's .wasm) are their paths on disk.
 */
function testKernelWorker() {
  const stub = fileURLToPath(new URL("./apps/web/test/kernelWorker.ts", import.meta.url));
  return {
    name: "meercad-test-kernel-worker",
    enforce: "pre" as const,
    async resolveId(this: { resolve(id: string, importer?: string): Promise<{ id: string } | null> }, id: string, importer?: string) {
      if (id.endsWith("?worker")) return stub;
      if (id.endsWith("?worker&url")) return "\0worker-url";
      // A file's URL (a .wasm the app loads): in Node its path on disk.
      if (id.endsWith("?url")) {
        const file = await this.resolve(id.slice(0, -4), importer);
        return file ? `/@file-path/${encodeURIComponent(file.id)}` : null;
      }
      return null;
    },
    load: (id: string) => (id === "\0worker-url" ? "export default \"kernel.worker.js\";" : id.startsWith("/@file-path/") ? `export default ${JSON.stringify(decodeURIComponent(id.slice("/@file-path/".length)))};` : null),
  };
}

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
        plugins: [testKernelWorker()],
        // TSX of the app (React 19, automatic runtime).
        oxc: { jsx: { runtime: "automatic" } },
        test: { name: "web", environment: "happy-dom", include: ["apps/web/src/**/*.test.{ts,tsx}"], setupFiles: ["apps/web/test/setup.ts"] },
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
