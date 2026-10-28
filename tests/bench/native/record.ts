// Records the OCCT calls that dominate a rebuild (booleans, UnifySameDomain, fillets) with their
// operands as BREP files and their time in WASM, so bench.cpp can replay exactly the same work
// natively. Also writes each final body as BREP for the meshing comparison.
// Usage (from tests/): ../node_modules/.bin/jiti bench/native/record.ts <file.meercad> <outDir> [single|multi]
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const [file, out, mode = "single"] = process.argv.slice(2);
if (!file || !out) throw new Error("usage: record.ts <file.meercad> <outDir> [single|multi]");
mkdirSync(out, { recursive: true });
const oc: any = await loadOcct(undefined, mode === "multi");
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(file, "utf8")) as MeercadDocument;

// Warm-up rebuild (JIT, wasm tier-up), not recorded.
new KernelSession(oc, solver).rebuild(doc, { props: false }).report;

interface Rec {
  op: string;
  files: string[];
  wasmMs: number;
  /** Fillet/chamfer: radius and edge indices into the input shape's TopExp map. */
  extra?: unknown;
}
const recs: Rec[] = [];
const save = (shape: any) => {
  const name = `${String(recs.length).padStart(3, "0")}-${Math.random().toString(36).slice(2, 6)}.brep`;
  writeFileSync(join(out, name), oc.BRepToolsWrapper.Write(shape));
  return name;
};
let recording = true;
for (const op of ["BRepAlgoAPI_Cut", "BRepAlgoAPI_Fuse", "BRepAlgoAPI_Common"]) {
  const Orig = oc[op];
  oc[op] = new Proxy(Orig, {
    construct(target, args) {
      const t = performance.now();
      const r = new target(...args);
      const ms = performance.now() - t;
      if (recording && args.length === 2) {
        recording = false;
        recs.push({ op, files: [save(args[0]), save(args[1])], wasmMs: ms });
        recording = true;
      }
      return r;
    },
  });
}
const OrigUnify = oc.ShapeUpgrade_UnifySameDomain;
oc.ShapeUpgrade_UnifySameDomain = new Proxy(OrigUnify, {
  construct(target, args) {
    const r = new target(...args);
    const build = r.Build.bind(r);
    r.Build = () => {
      const t = performance.now();
      build();
      const ms = performance.now() - t;
      if (recording) recs.push({ op: "UnifySameDomain", files: [save(args[0])], wasmMs: ms });
    };
    return r;
  },
});

const t = performance.now();
const s = new KernelSession(oc, solver);
const r = s.rebuild(doc, { props: false });
const total = performance.now() - t;
recording = false;
const bodies = [...s.state!.bodies.values()].map((b: any) => {
  const name = `body-${b.bodyId.replace(/\W+/g, "_")}.brep`;
  writeFileSync(join(out, name), oc.BRepToolsWrapper.Write(b.shape));
  return name;
});
writeFileSync(join(out, "index.json"), JSON.stringify({ file, mode, rebuildMs: r.report.rebuildMs, meshMs: r.report.meshMs, totalMs: total, recs, bodies }, null, 1));
const covered = recs.reduce((n, x) => n + x.wasmMs, 0);
console.log(`${recs.length} calls recorded, ${covered.toFixed(0)} of ${r.report.rebuildMs.toFixed(0)} ms rebuild (recording overhead included in total ${total.toFixed(0)} ms)`);
process.exit(0);
