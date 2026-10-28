// WASM counterpart of bench.cpp: replays the calls recorded by record.ts from the same BREP files,
// so both sides do identical work outside the kernel's own bookkeeping.
// Usage (from tests/): ../node_modules/.bin/jiti bench/native/replay.ts <recordDir> [single|multi]
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadOcct } from "@meercad/kernel";

const [dir, mode = "single"] = process.argv.slice(2);
if (!dir) throw new Error("usage: replay.ts <recordDir> [single|multi]");
const oc: any = await loadOcct(undefined, mode === "multi");
const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { recs: { op: string; files: string[] }[]; bodies: string[] };
const load = (f: string) => oc.BRepToolsWrapper.Read(readFileSync(join(dir, f), "utf8"));
const median = (fn: () => void, runs = 5) => {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const a = performance.now();
    fn();
    t.push(performance.now() - a);
  }
  return t.sort((x, y) => x - y)[runs >> 1]!;
};

const sums = new Map<string, [number, number]>();
for (const r of index.recs) {
  const [a, b] = r.files.map(load);
  const ms = median(() => {
    if (r.op === "UnifySameDomain") {
      const u = new oc.ShapeUpgrade_UnifySameDomain(a, true, true, false);
      u.Build();
      u.delete();
    } else {
      const algo = new oc[r.op](a, b);
      algo.Shape().delete();
      algo.delete();
    }
  });
  const [n, t] = sums.get(r.op) ?? [0, 0];
  sums.set(r.op, [n + 1, t + ms]);
}
let total = 0;
for (const [op, [n, ms]] of [...sums].sort()) {
  console.log(`${op.padEnd(20)} ${String(n).padStart(3)} calls  wasm ${ms.toFixed(1).padStart(8)} ms`);
  total += ms;
}
console.log(`${"total".padEnd(20)}            wasm ${total.toFixed(1).padStart(8)} ms`);

for (const f of index.bodies) {
  const s = load(f);
  const box = new oc.Bnd_Box();
  oc.BRepBndLib.Add(s, box, false);
  const lo = box.CornerMin();
  const hi = box.CornerMax();
  const lin = Math.max(0.01, Math.hypot(hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z()) * 5e-4);
  const mesh = median(() => {
    oc.BRepTools.Clean(s, true);
    new oc.BRepMesh_IncrementalMesh(s, lin, false, 0.06, mode === "multi").delete();
  });
  const props = median(() => {
    const v = new oc.GProp_GProps();
    const a = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(s, v, false, false, false);
    oc.BRepGProp.SurfaceProperties(s, a, false, false);
    v.delete();
    a.delete();
  });
  console.log(`${f}: mesh ${mesh.toFixed(1)} ms, volume+area ${props.toFixed(1)} ms`);
}
process.exit(0);
