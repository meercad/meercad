// Feature evaluation time of a design by step kind (op), and the slowest steps.
// Usage (from tests/): node <jiti-cli> bench/feature-times.ts file.meercad [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const threads = process.argv.includes("--threads");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"))!;
const oc = await loadOcct(undefined, threads);
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(file, "utf8")) as MeercadDocument;
const s = new KernelSession(oc, solver);
const r = s.rebuild(doc, { mesh: false, props: false });
const op = new Map(doc.features.map((f) => [f.id, `${f.op}${"mode" in f && f.mode ? `/${f.mode}` : ""}`]));
const by = new Map<string, { n: number; ms: number }>();

for (const f of r.report.features) {
  const k = op.get(f.id) ?? "?";
  const e = by.get(k) ?? { n: 0, ms: 0 };
  e.n++;
  e.ms += f.ms;
  by.set(k, e);
}

console.log(`kernel ${r.report.rebuildMs.toFixed(0)} ms`);

for (const [k, e] of [...by].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(`${e.ms.toFixed(0).padStart(7)} ms ${String(e.n).padStart(4)}×  ${k}`);
}

console.log(
  "slowest:",
  [...r.report.features]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 12)
    .map((f) => `${f.id}(${op.get(f.id)})=${f.ms.toFixed(0)}`)
    .join(" "),
);
process.exit(0);
