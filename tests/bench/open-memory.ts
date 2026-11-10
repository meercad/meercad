// Memory of opening a design as the iPad does: kernel heap after the steps and after meshing, and
// the size of the meshes sent to the page. Usage (from tests/):
//   ../node_modules/.bin/jiti bench/open-memory.ts file.meercad [--coarse=2] [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const threads = process.argv.includes("--threads");
const coarse = Number(process.argv.find((a) => a.startsWith("--coarse="))?.slice(9) ?? 2);
const file = process.argv.slice(2).find((a) => !a.startsWith("--"))!;
const oc = await loadOcct(undefined, threads);
const solver = await SketchSolver.create();
const MB = 2 ** 20;
const heap = () => (oc as unknown as { wasmMemory: { buffer: ArrayBuffer } }).wasmMemory.buffer.byteLength / MB;
const doc = JSON.parse(readFileSync(file, "utf8")) as MeercadDocument;
const s = new KernelSession(oc, solver);
s.meshCoarse = coarse;
console.log(`start heap ${heap().toFixed(0)} MB`);
let t = performance.now();
const r = s.rebuild(doc, { props: false });
console.log(`built ${doc.features.length} steps in ${((performance.now() - t) / 1000).toFixed(1)} s (mesh ${(r.report.meshMs / 1000).toFixed(1)} s), heap ${heap().toFixed(0)} MB`);
let bytes = 0, tris = 0, lines = 0, tags = 0;
const parts = { positions: 0, normals: 0, indices: 0, faceRanges: 0, edgeLines: 0, edgeRanges: 0 };
for (const m of r.meshes) {
  for (const k of Object.keys(parts) as (keyof typeof parts)[]) parts[k] += m[k].byteLength;
  tris += m.indices.length / 3;
  lines += m.edgeLines.length / 6;
  tags += m.faceTags.reduce((n, f) => n + f.length, 0);
}
bytes = Object.values(parts).reduce((a, b) => a + b, 0);
console.log(`meshes: ${r.meshes.length} parts, ${(tris / 1e6).toFixed(2)} M triangles, ${(lines / 1e6).toFixed(2)} M edge segments, ${(bytes / MB).toFixed(0)} MB (${Object.entries(parts).map(([k, v]) => `${k} ${(v / MB).toFixed(0)}`).join(", ")}), ${tags} face tags`);
t = performance.now();
const json = JSON.stringify(doc).length;
console.log(`document ${(json / MB).toFixed(1)} MB as JSON`);
process.exit(0);
