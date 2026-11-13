// Times of what MCP calls do in the kernel for a big design (rebuild, small edit, sandbox, gap check),
// without the app.
// Usage (from tests/): ../node_modules/.bin/jiti bench/mcp-timeouts.ts path/to/design.meercad
import { clearances, KernelSession, loadOcct } from "@meercad/kernel";
import { motion } from "@meercad/model";

import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { readFileSync } from "node:fs";

const doc = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as MeercadDocument;
const oc = await loadOcct(undefined, false);
const solver = await SketchSolver.create();
const s = new KernelSession(oc, solver);

const time = <T>(label: string, fn: () => T): T => {
  const t = performance.now();
  const r = fn();
  console.log(`${label}: ${(performance.now() - t).toFixed(0)} ms`);

  return r;
};

const r = time("first rebuild", () => s.rebuild(doc));
console.log(
  `  ${r.report.bodies.length} bodies, ${r.report.features.filter((f) => f.status === "error").length} feature errors`,
);

const moving = [...new Set((doc.mechanism?.joints ?? []).filter((x) => x.type !== "fixed").map((x) => x.a))];
const skip: string[] = [];
const out = time(`clearances at rest (${moving.length} moving)`, () =>
  clearances(oc, s.state!, moving, {}, 2, skip),
);
console.log(`  ${out.length} pairs, ${out.filter((c) => c.distance < 1e-6).length} touching`);

const rigid = motion.rigidGroups(doc.mechanism?.joints ?? []);
const kept = time("clearances at rest, rigid pairs left out", () =>
  clearances(oc, s.state!, moving, {}, 2, skip, rigid),
);
console.log(`  ${kept.length} pairs, ${kept.filter((c) => c.distance < 1e-6).length} touching`);
process.exit(0);
