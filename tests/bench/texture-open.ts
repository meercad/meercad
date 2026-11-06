// Time to open a textured part: rebuild, plain mesh and textured display mesh, separately.
// Usage (from tests/): ../node_modules/.bin/jiti bench/texture-open.ts <file.meercad>
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import { SketchSolver } from "@meercad/sketch";
const oc: any = await loadOcct();
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const plain = structuredClone(doc);
for (const f of plain.features) if (f.op === "texture") f.suppressed = true;
for (const [name, d] of [["plain", plain], ["textured", doc], ["textured again", doc]] as const) {
  const s = new KernelSession(oc, solver);
  const t = performance.now();
  const r = s.rebuild(d);
  const tris = r.meshes.reduce((n: number, m: any) => n + m.indices.length / 3, 0);
  console.log(`${name}: total ${(performance.now() - t).toFixed(0)} ms, rebuild ${r.report.rebuildMs.toFixed(0)} ms, mesh ${r.report.meshMs.toFixed(0)} ms, ${tris} triangles`);
}
