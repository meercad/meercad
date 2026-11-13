// Display tessellation: triangles and meshing time of a design at several tolerances.
// Usage (from tests/): node <jiti-cli> bench/mesh-density.ts file.meercad [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct, summarizeBody } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const threads = process.argv.includes("--threads");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"))!;
const oc = await loadOcct(undefined, threads);
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(file, "utf8")) as MeercadDocument;
const s = new KernelSession(oc, solver);
const r = s.rebuild(doc, { mesh: false, props: false });
const bodies = [...s.state!.bodies.values()];
console.log(`kernel ${r.report.rebuildMs.toFixed(0)} ms, ${bodies.length} bodies`);

const diags = bodies.map((b) => {
  const { bbox } = summarizeBody(oc, b, false);

  return Math.hypot(...bbox.max.map((v, i) => v - bbox.min[i]!));
});
// [name, linear(diag), angular]
const settings: [string, (d: number) => number, number][] = [
  ["now (5e-4·d ≥0.01, 0.06)", (d) => Math.max(0.01, d * 5e-4), 0.06],
  ["ang 0.1", (d) => Math.max(0.01, d * 5e-4), 0.1],
  ["ang 0.15", (d) => Math.max(0.01, d * 5e-4), 0.15],
  ["ang 0.2", (d) => Math.max(0.01, d * 5e-4), 0.2],
  ["lin 1e-3·d ≥0.02, ang 0.15", (d) => Math.max(0.02, d * 1e-3), 0.15],
  ["lin 2e-3·d ≥0.02, ang 0.2", (d) => Math.max(0.02, d * 2e-3), 0.2],
];

for (const [name, lin, ang] of settings) {
  let tris = 0;
  const t = performance.now();
  bodies.forEach((b, i) => {
    if (b.sourceMesh) return;

    // Meshing again needs the old triangulation gone.
    oc.BRepTools.Clean(b.shape, true);

    const m = oc.ReplicadMeshExtractor.extract(b.shape, lin(diags[i]!), ang, false);
    const em = oc.ReplicadEdgeMeshExtractor.extract(b.shape, lin(diags[i]!), ang);
    tris += m.getTrianglesSize() / 3;
    m.delete();
    em.delete();
  });
  console.log(
    `${(performance.now() - t).toFixed(0).padStart(6)} ms  ${String(tris).padStart(8)} tris  ${name}`,
  );
}

process.exit(0);
