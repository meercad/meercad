// What an export costs on a big design in the kernel: the print-quality meshes part by part (cables
// apart from the rest, the slowest parts), the whole export again (kept meshes) and writing the 3MF.
// Usage (from tests/): ../node_modules/.bin/jiti bench/export-time.ts file.meercad
import { readFileSync } from "node:fs";
import { write3mf } from "@meercad/io";
import { exportMeshes, KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const file = process.argv[2]!;
const oc = await loadOcct();
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(file, "utf8")) as MeercadDocument;
const s = new KernelSession(oc, solver);
let t = performance.now();
s.rebuild(doc, { mesh: false, props: false });
console.log(`rebuild ${((performance.now() - t) / 1000).toFixed(1)} s, ${s.state!.bodies.size} bodies`);
// Part by part, to see which parts the time goes to (cables are the features of op "cable").
const cables = new Set(doc.features.filter((f) => (f as { op?: string }).op === "cable").map((f) => f.id));
const per: { id: string; ms: number; tris: number; cable: boolean }[] = [];
t = performance.now();
for (const b of s.state!.bodies.values()) {
  const t1 = performance.now();
  const [m] = exportMeshes(oc, s.state!, [b.bodyId]);
  per.push({ id: b.bodyId, ms: performance.now() - t1, tris: m!.indices.length / 3, cable: [...cables].some((c) => b.bodyId.startsWith(c)) });
}
console.log(`part by part ${((performance.now() - t) / 1000).toFixed(1)} s`);
const sum = (xs: typeof per) => `${xs.length} parts, ${(xs.reduce((n, x) => n + x.ms, 0) / 1000).toFixed(1)} s, ${(xs.reduce((n, x) => n + x.tris, 0) / 1e6).toFixed(2)} M triangles`;
console.log("cables:", sum(per.filter((x) => x.cable)), "| others:", sum(per.filter((x) => !x.cable)));
for (const x of per.sort((a, b) => b.ms - a.ms).slice(0, 15)) console.log(`  ${x.id.padEnd(28)} ${(x.ms / 1000).toFixed(2)} s ${(x.tris / 1e3).toFixed(0)} k${x.cable ? " cable" : ""}`);
t = performance.now();
const meshes = exportMeshes(oc, s.state!);
const tris = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
console.log(`whole export (meshes kept) ${((performance.now() - t) / 1000).toFixed(1)} s, ${(tris / 1e6).toFixed(2)} M triangles`);
t = performance.now();
const data = write3mf(meshes.map((m) => ({ name: m.bodyId, positions: m.positions, indices: m.indices })) as never);
console.log(`write 3mf ${((performance.now() - t) / 1000).toFixed(1)} s, ${(data.length / 2 ** 20).toFixed(0)} MB`);
process.exit(0);
