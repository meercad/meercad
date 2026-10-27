// Per-face cache potential: after nudging one feature, which faces of the new body are the same TShape
// (IsSame, handles kept alive outside the arena) as faces of the previous body, and what share of the
// whole-body meshing time do the changed faces cost?
import { KernelSession, loadOcct } from "@meercad/kernel";
import { SketchSolver } from "@meercad/sketch";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";
// Usage (from tests/): ../node_modules/.bin/jiti bench/face-reuse.ts
const oc: any = await loadOcct();
const solver = await SketchSolver.create();
const lin = 0.03, ang = 0.25;
const time = (f: () => void) => { const a = performance.now(); f(); return performance.now() - a; };
const keepFaces = (shape: any) => { const out: any[] = []; const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); for (; ex.More(); ex.Next()) out.push(ex.Current()); ex.delete(); return out; };
for (const ex of EXAMPLES) {
  for (const feat of [...ex.doc.features].reverse()) {
    const key = ["distance", "radius", "thickness"].find((k) => k in feat);
    if (!key) continue;
    const s = new KernelSession(oc, solver);
    s.rebuild(ex.doc, { mesh: false, props: false });
    const prev = keepFaces(([...s.state!.bodies.values()][0] as any).shape);
    const d = structuredClone(ex.doc) as any;
    const g = d.features.find((x: any) => x.id === feat.id);
    g[key] = (parseFloat(String(g[key])) || 2) * 1.03;
    const r = s.rebuild(d, { mesh: false, props: false });
    if (r.report.features.some((x) => x.status !== "ok")) continue;
    const b: any = [...s.state!.bodies.values()][0];
    const same = b.faces.map((f: any) => prev.some((p) => p.IsSame(f)));
    oc.BRepTools.Clean(b.shape, true);
    const all = time(() => { for (let i = 0; i < 3; i++) { oc.BRepTools.Clean(b.shape, true); for (const f of b.faces) oc.ReplicadMeshExtractor.extract(f, lin, ang, false).delete(); } }) / 3;
    const changed = time(() => { for (let i = 0; i < 3; i++) { oc.BRepTools.Clean(b.shape, true); b.faces.forEach((f: any, k: number) => { if (!same[k]) oc.ReplicadMeshExtractor.extract(f, lin, ang, false).delete(); }); } }) / 3;
    console.log(`${ex.name} ${feat.id}.${key}: ${same.filter(Boolean).length}/${b.faces.length} faces unchanged; mesh all faces ${all.toFixed(1)} ms, only changed ${changed.toFixed(1)} ms`);
    s.dispose();
  }
}
process.exit(0);
