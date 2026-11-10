// A change somewhere in the timeline: how long the rebuild after it takes, and whether its result
// equals a rebuild from scratch (part by part: volume, box, faces, face tags).
// Usage (from tests/): node <jiti-cli> bench/incremental.ts file.meercad featureId … [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { nudged, sameModel } from "../incremental-check.js";

const threads = process.argv.includes("--threads");
const [file, ...ids] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const oc = await loadOcct(undefined, threads);
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(file!, "utf8")) as MeercadDocument;
const a = new KernelSession(oc, solver);
let t = performance.now();
let r = a.rebuild(doc, { props: false });
console.log(`first build ${(performance.now() - t).toFixed(0)} ms (kernel ${r.report.rebuildMs.toFixed(0)}, mesh ${r.report.meshMs.toFixed(0)})`);
let current = doc;
for (const id of ids) {
  current = nudged(current, id);
  t = performance.now();
  let computed = 0;
  r = a.rebuild(current, { props: false, onFeature: () => computed++ });
  const ms = performance.now() - t;
  // From scratch in a kernel of its own: OCCT keeps memory of every boolean, so a second full build
  // in the same kernel would soon fill it.
  const ocB = await loadOcct();
  const b = new KernelSession(ocB, await SketchSolver.create());
  const fresh = b.rebuild(current, { props: false, mesh: false });
  const diff = sameModel(oc, a.state!, b.state!, ocB);
  console.log(`edit ${id}: ${ms.toFixed(0)} ms (kernel ${r.report.rebuildMs.toFixed(0)}, mesh ${r.report.meshMs.toFixed(0)}), ${computed} steps computed; from scratch ${fresh.report.rebuildMs.toFixed(0)} ms; ${diff ?? "same result"}`);
  b.dispose();
}
process.exit(0);
