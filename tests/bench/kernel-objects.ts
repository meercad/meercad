// What the kernel keeps for an open design besides OCCT's own memory: the wrapper objects of every
// step's state by kind, and the JavaScript memory of the kernel. Usage (from tests/):
//   NODE_OPTIONS=--expose-gc ../node_modules/.bin/jiti bench/kernel-objects.ts file.meercad
import { readFileSync } from "node:fs";
import { Arena, KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const oc = await loadOcct();
const gc = (globalThis as { gc?: () => void }).gc;
const mem = () => {
  gc?.();
  const u = process.memoryUsage();
  return `js ${(u.heapUsed / 2 ** 20).toFixed(0)} MB, process ${(u.rss / 2 ** 20).toFixed(0)} MB, kernel heap ${((oc as unknown as { wasmMemory: { buffer: ArrayBuffer } }).wasmMemory.buffer.byteLength / 2 ** 20).toFixed(0)} MB`;
};
const all = new Set<Arena>();
const track = Arena.prototype.track;
Arena.prototype.track = function <T extends { delete(): void }>(this: Arena, o: T): T {
  all.add(this);
  return track.call(this, o) as T;
};
const s = new KernelSession(oc, await SketchSolver.create());
s.meshCoarse = 2;
const doc = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as MeercadDocument;
delete doc.versions;
console.log("before:", mem());
const t = performance.now();
s.rebuild(doc, { props: false });
console.log(`built in ${((performance.now() - t) / 1000).toFixed(1)} s:`, mem());
const c = new Map<string, number>();
for (const a of all) if (a.size) a.census(c);
console.log([...c].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", "));
process.exit(0);
