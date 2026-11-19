/**
 * Calculating files of the app: the `.ts` modules under `apps/web/src` that only compute (geometry,
 * units, parsers, lookups) and touch neither React, the app store, the kernel worker, native plugins
 * nor the browser. They need a test file of their own and 100 % coverage each (docs/CODE_STYLE.md,
 * docs/TESTING.md). A new file that fits is found by itself, so it cannot slip in untested.
 *
 * `vitest.config.ts` sets the per-file floor from this list; `node scripts/calculating.mjs` (part of
 * `pnpm lint`) fails when one of them has no `<name>.test.ts` next to it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "apps/web/src";

/** Imports that tie a module to the UI, the store, the worker or the device (type imports don't). */
const UI_IMPORT =
  /^(react|react-dom|zustand|lucide-react|@capacitor\/.*|@meercad\/kernel\/(client|worker)|.*\/store|.*\/components\/.*|.*\?(url|worker).*)$/;

/** Browser globals and storage: a module using them runs in the page, not in a formula. */
const BROWSER =
  /\b(document|window|navigator|localStorage|sessionStorage|location|performance)\.|\b(fetch|matchMedia)\(|\b(indexedDB|requestAnimationFrame|XMLHttpRequest|WebSocket|Worker)\b|\bimport\.meta\.env\b/;

/** Files that fit the rule but hold only data or text (no logic to cover). */
const DATA_ONLY = [/\/i18n\//];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** The modules a source imports at run time (`import type` and `export type … from` left out). */
export function runtimeImports(source) {
  const imports = [];

  for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*"([^"]+)"/gms)) {
    if (!match[2]) imports.push(match[4]);
  }

  for (const match of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) imports.push(match[1]);

  for (const match of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) imports.push(match[1]);

  return imports;
}

/** Whether a module holds code that runs (not only types and interfaces). */
export function hasCode(source) {
  return /^\s*(export\s+)?(default\s+)?(async\s+)?(function|const|let|var|class|enum)\b/m.test(source);
}

/** Whether a module's source only computes. */
export function isCalculating(source) {
  return (
    hasCode(source) && !runtimeImports(source).some((name) => UI_IMPORT.test(name)) && !BROWSER.test(source)
  );
}

/** The calculating files of the app, relative to the repository and sorted. */
export function calculatingFiles(root = ROOT) {
  return walk(join(root, APP))
    .map((path) => relative(root, path).split("\\").join("/"))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
    .filter((path) => !DATA_ONLY.some((pattern) => pattern.test(path)))
    .filter((path) => isCalculating(readFileSync(join(root, path), "utf8")))
    .sort();
}

/** Whether a test file of its own lies next to the file: `<name>.test.ts` or `<name>.<topic>.test.ts`. */
function hasOwnTest(root, path) {
  const dir = dirname(join(root, path));
  const name = path.split("/").pop().replace(/\.ts$/, "");

  return (
    existsSync(join(dir, `${name}.test.ts`)) ||
    readdirSync(dir).some((file) => file.startsWith(`${name}.`) && file.endsWith(".test.ts"))
  );
}

/** Calculating files without a test file of their own. */
export function untested(root = ROOT) {
  return calculatingFiles(root).filter((path) => !hasOwnTest(root, path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--list")) {
    console.log(calculatingFiles().join("\n"));
  } else {
    const missing = untested();

    if (missing.length) {
      console.error(
        "Calculating files need a test file of their own and 100 % coverage (docs/CODE_STYLE.md):\n" +
          missing.map((path) => `  ${path} → ${path.replace(/\.ts$/, ".test.ts")}`).join("\n"),
      );
      process.exit(1);
    }
  }
}
