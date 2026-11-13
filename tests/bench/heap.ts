// Kernel memory (WebAssembly heap) after building a design, with and without meshes, and after edits.
// Usage (from tests/): ../node_modules/.bin/jiti bench/heap.ts file.meercad [featureId …] [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { nudged } from "../incremental-check.js";

const threads = process.argv.includes("--threads");
const [file, ...ids] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const oc = await loadOcct(undefined, threads);
const solver = await SketchSolver.create();
const mod = oc as unknown as Record<string, { length?: number; buffer?: { byteLength: number } } | undefined>;

const heap = () => {
  const bytes = mod["HEAPU8"]?.length ?? mod["HEAP8"]?.length ?? mod["wasmMemory"]?.buffer?.byteLength;
  const m = process.memoryUsage();

  return `${bytes === undefined ? "?" : (bytes / 2 ** 20).toFixed(0)} MB (process ${(m.rss / 2 ** 20).toFixed(0)} MB, buffers ${((m.arrayBuffers + m.external) / 2 ** 20).toFixed(0)} MB)`;
};

console.log(
  Object.keys(mod)
    .filter((k) => /heap|memory|wasm/i.test(k))
    .join(" "),
);

let doc = JSON.parse(readFileSync(file!, "utf8")) as MeercadDocument;
const s = new KernelSession(oc, solver);
console.log("start", heap());
s.rebuild(doc, { mesh: false, props: false });
console.log("features", heap());

const census = new Map<string, number>();
let st = s.state;
st!.arena.census(census);
console.log(
  [...census]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, n]) => `${k} ${n}`)
    .join(", "),
);
s.rebuild(doc, { props: false });
console.log("meshed", heap());

for (const id of ids) {
  doc = nudged(doc, id);

  let n = 0;
  const r = s.rebuild(doc, { props: false, onFeature: () => n++ });
  console.log(
    `edit ${id}: ${n} steps, kernel ${r.report.rebuildMs.toFixed(0)} ms, mesh ${r.report.meshMs.toFixed(0)} ms, heap ${heap()}`,
  );
}

process.exit(0);
