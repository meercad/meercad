// Splits the meshing time of a design into its steps (bbox, props, face mesh, edge mesh, our JS).
// Usage (from tests/): ../node_modules/.bin/jiti bench/mesh-breakdown.ts file.meercad [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct, meshBody, summarizeBody } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const threads = process.argv.includes("--threads");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"))!;
const oc = await loadOcct(undefined, threads);
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(file, "utf8")) as MeercadDocument;
const s = new KernelSession(oc, solver);
const r = s.rebuild(doc, { mesh: false, props: false });
console.log(`kernel ${r.report.rebuildMs.toFixed(0)} ms, ${s.state!.bodies.size} bodies`);

const tot = { bbox: 0, props: 0, mesh: 0, tris: 0, faces: 0 };
const per: [number, string, number, number, string][] = [];

for (const body of s.state!.bodies.values()) {
  let t = performance.now();
  const sum = summarizeBody(oc, body, false);
  tot.bbox += performance.now() - t;
  t = performance.now();
  summarizeBody(oc, body, true);
  tot.props += performance.now() - t;
  t = performance.now();

  const m = meshBody(oc, body, sum.bbox, 1);
  const dt = performance.now() - t;
  tot.mesh += dt;
  tot.tris += m.indices.length / 3;
  tot.faces += body.faces.length;

  const kinds = new Map<string, number>();

  for (const f of body.faces) {
    const a = new oc.BRepAdaptor_Surface(f, true);
    const k = String(a.GetType()).replace("GeomAbs_", "");
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
    a.delete();
  }

  per.push([
    dt,
    body.bodyId,
    m.indices.length / 3,
    body.faces.length,
    [...kinds].map(([k, n]) => `${k}:${n}`).join(","),
  ]);
}

console.log(
  `bbox ${tot.bbox.toFixed(0)}  props ${tot.props.toFixed(0)}  mesh ${tot.mesh.toFixed(0)}  tris ${tot.tris}  faces ${tot.faces}`,
);

for (const p of per.sort((a, b) => b[0] - a[0]).slice(0, 12)) {
  console.log(
    `${p[0].toFixed(0).padStart(6)} ms ${String(p[2]).padStart(7)} tris ${String(p[3]).padStart(4)} faces  ${p[1]}  ${p[4]}`,
  );
}

process.exit(0);
