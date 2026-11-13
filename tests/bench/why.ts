// After a change to one step: which later steps had to be computed again, and what they had read that
// changed.
// Usage (from tests/): ../node_modules/.bin/jiti bench/why.ts file.meercad featureId [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct, replayTrace } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { nudged } from "../incremental-check.js";

const [file, id] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const oc = await loadOcct(undefined, process.argv.includes("--threads"));
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(file!, "utf8")) as MeercadDocument;
const s = new KernelSession(oc, solver);
const first = s.rebuild(doc, { props: false });
const before = new Map([...s.state!.bodies].map(([k, b]) => [k, b]));
const reasons: string[] = [];
replayTrace.miss = (why) => reasons.push(why);

const computed: string[] = [];
const edited = nudged(doc, id!);
const r = s.rebuild(edited, { props: false, onFeature: (_i, _n, f) => computed.push(f) });
const ops = new Map(
  doc.features.map((f) => [
    f.id,
    `${f.op}${"mode" in f && f.mode ? `/${f.mode}` : ""}${"targets" in f && (f.targets as string[] | undefined)?.length ? "" : " (no targets)"}`,
  ]),
);
console.log(
  `first build kernel ${first.report.rebuildMs.toFixed(0)} ms, mesh ${first.report.meshMs.toFixed(0)} ms`,
);
console.log(
  `edit ${id}: ${computed.length} steps computed, kernel ${r.report.rebuildMs.toFixed(0)} ms, mesh ${r.report.meshMs.toFixed(0)} ms`,
);

const changed = [...s.state!.bodies].filter(([k, b]) => before.get(k) !== b).length;
console.log(`${changed} of ${s.state!.bodies.size} parts are new objects`);

const count = (list: string[]) =>
  [...list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].sort(
    (a, b) => b[1] - a[1],
  );
console.log(
  "computed by kind:",
  count(computed.map((f) => ops.get(f) ?? "?"))
    .map(([k, n]) => `${n}× ${k}`)
    .join(", "),
);
console.log(
  "what had changed:",
  count(reasons.map((w) => (w.startsWith("all") ? w : w.split(" ")[0]!)))
    .map(([k, n]) => `${n}× ${k}`)
    .join(", "),
);

const ms = new Map(r.report.features.map((f) => [f.id, f.ms]));
console.log(
  "first computed:",
  computed
    .slice(0, 40)
    .map((f, i) => `${f}[${ops.get(f)}; ${reasons[i - 1] ?? "-"}; ${ms.get(f)?.toFixed(0)}ms]`)
    .join("\n  "),
);
process.exit(0);
