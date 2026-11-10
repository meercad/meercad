// Which kernel call keeps memory after its objects are freed? Each candidate runs many times in arenas that are disposed.
// Usage (from tests/): ../node_modules/.bin/jiti bench/leak3.ts
import { Arena, Body, loadOcct } from "@meercad/kernel";
import { booleanBodies, bounds, unify } from "../../packages/kernel/src/boolean.js";

const oc = await loadOcct(undefined, process.argv.includes("--threads"));
const heap = () => (oc as unknown as { wasmMemory: { buffer: ArrayBuffer } }).wasmMemory.buffer.byteLength / 2 ** 20;
const keep = new Arena();
const box = (a: Arena, x: number, y: number, z: number, w: number) => a.track(a.track(new oc.BRepPrimAPI_MakeBox(a.track(new oc.gp_Pnt(x, y, z)), w, w, w)).Shape());
const cyl = (a: Arena, x: number, r: number) => a.track(a.track(new oc.BRepPrimAPI_MakeCylinder(a.track(new oc.gp_Ax2(a.track(new oc.gp_Pnt(x, 5, -1)), a.track(new oc.gp_Dir(0, 0, 1)))), r, 30)).Shape());
// A part with some faces: a block with a row of holes.
let part = new Body(oc, keep, "part", box(keep, 0, 0, 0, 20));
for (let i = 0; i < 6; i++) part = booleanBodies(oc, keep, part, new Body(oc, keep, "t", cyl(keep, 2 + i * 3, 1)), "cut");
const tool = new Body(oc, keep, "tool", box(keep, 15, 15, 15, 10));
console.log(`part with ${part.faces.length} faces`);

const run = (name: string, n: number, fn: (a: Arena) => void) => {
  for (let i = 0; i < 20; i++) {
    const a = new Arena();
    fn(a);
    a.dispose();
  }
  const before = heap();
  for (let i = 0; i < n; i++) {
    const a = new Arena();
    fn(a);
    a.dispose();
  }
  console.log(`${name.padEnd(34)} ${((heap() - before) * 1024 / n).toFixed(1).padStart(8)} KB per call`);
};
const N = 800;
const list = (a: Arena, shapes: any[]) => {
  const l = a.track(new oc.NCollection_List_TopoDS_Shape());
  for (const x of shapes) l.Append(x);
  return l;
};
const built = (a: Arena, setup: (algo: any) => void, C: any = oc.BRepAlgoAPI_Cut) => {
  const algo = a.track(new C());
  algo.SetArguments(list(a, [part.shape]));
  algo.SetTools(list(a, [tool.shape]));
  setup(algo);
  algo.Build(a.track(new oc.Message_ProgressRange()));
  return algo;
};
const M = 6000;
run("two boxes cut", M, (a) => void a.track(new oc.BRepAlgoAPI_Cut(box(a, 0, 0, 0, 10), box(a, 5, 5, 5, 10))));
run("two boxes apart", M, (a) => void a.track(new oc.BRepAlgoAPI_Cut(box(a, 0, 0, 0, 10), box(a, 50, 50, 50, 10))));
run("two boxes, non destructive", M, (a) => {
  const algo = a.track(new oc.BRepAlgoAPI_Cut());
  algo.SetArguments(list(a, [box(a, 0, 0, 0, 10)]));
  algo.SetTools(list(a, [box(a, 5, 5, 5, 10)]));
  algo.SetNonDestructive(true);
  algo.Build(a.track(new oc.Message_ProgressRange()));
});
run("two boxes, no history", M, (a) => {
  const algo = a.track(new oc.BRepAlgoAPI_Cut());
  algo.SetArguments(list(a, [box(a, 0, 0, 0, 10)]));
  algo.SetTools(list(a, [box(a, 5, 5, 5, 10)]));
  algo.SetToFillHistory(false);
  algo.Build(a.track(new oc.Message_ProgressRange()));
});
run("boxes only (no boolean)", M, (a) => void [box(a, 0, 0, 0, 10), box(a, 5, 5, 5, 10)]);
run("part cut tool", M, (a) => void a.track(new oc.BRepAlgoAPI_Cut(part.shape, tool.shape)));
process.exit(0);
