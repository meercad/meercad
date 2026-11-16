/**
 * The rule for the app's calculating files (scripts/calculating.mjs): which files count, and that a
 * new one without a test file of its own is reported.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  calculatingFiles,
  hasCode,
  isCalculating,
  runtimeImports,
  untested,
} from "../scripts/calculating.mjs";

let root: string | null = null;

/** A repository of the given files (path → text) in a temporary folder. */
function repo(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), "meercad-calculating-"));

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });

  root = null;
});

const pure = 'import { add2 } from "@meercad/sketch";\nexport const twice = (n: number) => n * 2;\n';

describe("calculating files", () => {
  it("reads run-time imports, type imports left out", () => {
    expect(
      runtimeImports(
        [
          'import type { A } from "react";',
          'import {\n  type B,\n  c,\n} from "../store";',
          'export type { D } from "zustand";',
          'export { e } from "./units";',
          'import "./styles.css";',
          'const lazy = () => import("./lazy");',
        ].join("\n"),
      ),
    ).toEqual(["../store", "./units", "./styles.css", "./lazy"]);
  });

  it("counts files that compute, not ones tied to the UI, the device or the page", () => {
    expect(isCalculating(pure)).toBe(true);
    expect(isCalculating('import type { App } from "../store";\n' + pure)).toBe(true);
    expect(isCalculating('import { useApp } from "../store";\n' + pure)).toBe(false);
    expect(isCalculating('import { useState } from "react";\n' + pure)).toBe(false);
    expect(isCalculating('import { Filesystem } from "@capacitor/filesystem";\n' + pure)).toBe(false);
    expect(isCalculating('import { KernelClient } from "@meercad/kernel/client";\n' + pure)).toBe(false);
    expect(isCalculating('import { Ask } from "../components/Ask";\n' + pure)).toBe(false);
    expect(isCalculating(pure + "export const lang = () => navigator.language;\n")).toBe(false);
    expect(isCalculating(pure + "const db = indexedDB.open('x');\n")).toBe(false);
    expect(isCalculating(pure + "const dark = matchMedia('(prefers-color-scheme: dark)');\n")).toBe(false);
    // Types alone hold nothing to run.
    expect(hasCode("export interface A {\n  b: number;\n}\nexport type C = A[];\n")).toBe(false);
    expect(isCalculating("export interface A {\n  b: number;\n}\n")).toBe(false);
  });

  it("finds the calculating files of the app and reports the ones without a test file", () => {
    const dir = repo({
      "apps/web/src/lib/units.ts": pure,
      "apps/web/src/lib/units.test.ts": "",
      "apps/web/src/lib/mesh.ts": pure,
      "apps/web/src/lib/mesh.ids.test.ts": "",
      "apps/web/src/lib/newMath.ts": pure,
      "apps/web/src/lib/panel.ts": 'import { useState } from "react";\n' + pure,
      "apps/web/src/lib/Chip.tsx": pure,
      "apps/web/src/lib/i18n/de/app.ts": "export const DE = { a: 'b' };\n",
      "apps/web/src/sketch/types.ts": "export interface A {\n  b: number;\n}\n",
      "packages/model/src/other.ts": pure,
    });

    expect(calculatingFiles(dir)).toEqual([
      "apps/web/src/lib/mesh.ts",
      "apps/web/src/lib/newMath.ts",
      "apps/web/src/lib/units.ts",
    ]);
    expect(untested(dir)).toEqual(["apps/web/src/lib/newMath.ts"]);
  });

  it("has every calculating file of the app tested", () => {
    expect(calculatingFiles().length).toBeGreaterThan(30);
    expect(untested()).toEqual([]);
  });
});
