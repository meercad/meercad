// The two steps of an interference check for one pair of parts: distance, then the common volume.
// Usage (from tests/): ../node_modules/.bin/jiti bench/pair-time.ts file.meercad partA partB [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const threads = process.argv.includes("--threads");
const [file, a, b] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const oc = await loadOcct(undefined, threads);
const s = new KernelSession(oc, await SketchSolver.create());
s.rebuild(JSON.parse(readFileSync(file!, "utf8")) as MeercadDocument, { mesh: false, props: false });
const A = s.state!.bodies.get(a!)!;
const B = s.state!.bodies.get(b!)!;
console.log(`${a}: ${A.faces.length} faces, ${b}: ${B.faces.length} faces`);
let t = performance.now();
const d = new oc.BRepExtrema_DistShapeShape(A.shape, B.shape);
console.log(`distance ${d.Value().toFixed(3)} mm in ${((performance.now() - t) / 1000).toFixed(1)} s`);
t = performance.now();
const c = new oc.BRepAlgoAPI_Common(A.shape, B.shape);
console.log(`common done ${c.IsDone()} in ${((performance.now() - t) / 1000).toFixed(1)} s`);
process.exit(0);
