// Does kernel memory keep growing when the same step is changed again and again?
// Usage (from tests/): ../node_modules/.bin/jiti bench/leak.ts file.meercad featureId rounds [--mesh] [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { nudged } from "../incremental-check.js";

const mesh = process.argv.includes("--mesh");
const [file, id, rounds] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const oc = await loadOcct(undefined, process.argv.includes("--threads"));
const solver = await SketchSolver.create();
const heap = () => `${((oc as unknown as { wasmMemory: { buffer: ArrayBuffer } }).wasmMemory.buffer.byteLength / 2 ** 20).toFixed(0)} MB`;
const doc = JSON.parse(readFileSync(file!, "utf8")) as MeercadDocument;
const other = nudged(doc, id!);
const s = new KernelSession(oc, solver);
s.rebuild(doc, { mesh, props: false });
console.log("built", heap());
for (let i = 0; i < Number(rounds); i++) {
  let n = 0;
  const r = s.rebuild(i % 2 ? doc : other, { mesh, props: false, onFeature: () => n++ });
  console.log(`round ${i}: ${n} steps, kernel ${r.report.rebuildMs.toFixed(0)} ms, mesh ${r.report.meshMs.toFixed(0)} ms, heap ${heap()}`);
}
process.exit(0);
