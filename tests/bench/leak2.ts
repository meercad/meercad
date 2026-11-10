// Kernel memory over repeated changes to one step, without meshing (the engine alone) or with it.
// Usage (from tests/): ../node_modules/.bin/jiti bench/leak2.ts file.meercad featureId rounds [--mesh] [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct, OcctBackend } from "@meercad/kernel";
import { RebuildEngine } from "@meercad/model";
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
const session = mesh ? new KernelSession(oc, solver) : null;
const engine = mesh ? null : new RebuildEngine(new OcctBackend(oc, solver));
const build = (d: MeercadDocument) => {
  let n = 0;
  if (session) session.rebuild(d, { props: false, onFeature: () => n++ });
  else engine!.rebuild(d, () => n++);
  return n;
};
build(doc);
console.log(mesh ? "with meshing" : "engine only", "built", heap());
for (let i = 0; i < Number(rounds); i++) console.log(`round ${i}: ${build(i % 2 ? doc : other)} steps, heap ${heap()}`);
process.exit(0);
