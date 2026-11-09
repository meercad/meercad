// Where the time goes when a design is opened: feature evaluation (per feature) vs. meshing.
// Usage (from tests/): ../node_modules/.bin/jiti bench/open-profile.ts [filter] [--threads]
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { readdirSync, readFileSync } from "node:fs";
import { MODELS } from "../models/models.js";

const threads = process.argv.includes("--threads");
const filter = process.argv.slice(2).find((a) => !a.startsWith("--"));
const oc = await loadOcct(undefined, threads);
const solver = await SketchSolver.create();
const docs: [string, MeercadDocument][] = [...MODELS.map((m) => [`model ${m.file}`, m.doc] as [string, MeercadDocument]), ...readdirSync(new URL("../../apps/web/src/examples/", import.meta.url)).filter((f) => f.endsWith(".meercad")).map((f) => [`example ${f}`, JSON.parse(readFileSync(new URL(`../../apps/web/src/examples/${f}`, import.meta.url), "utf8"))] as [string, MeercadDocument])];
// Extra .meercad files (e.g. a copy of the user's projects): MEERCAD_PROFILE_DIR=/path
const extra = process.env.MEERCAD_PROFILE_DIR;
if (extra) for (const f of readdirSync(extra).filter((f) => f.endsWith(".meercad"))) docs.push([`file ${f}`, JSON.parse(readFileSync(`${extra}/${f}`, "utf8")) as MeercadDocument]);
const rows: string[] = [];
for (const [name, doc] of docs) {
  if (filter && !name.includes(filter)) continue;
  const s = new KernelSession(oc, solver);
  const t = performance.now();
  const r = s.rebuild(doc);
  const total = performance.now() - t;
  const tris = r.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const json = JSON.stringify(r.meshes.map((m) => ({ ...m, positions: [...m.positions], normals: [...m.normals], indices: [...m.indices] }))).length;
  const top = [...r.report.features].sort((a, b) => b.ms - a.ms).slice(0, 4).map((f) => `${f.id}=${f.ms.toFixed(0)}`).join(" ");
  rows.push(`${total.toFixed(0).padStart(6)} ms  kernel ${r.report.rebuildMs.toFixed(0).padStart(6)}  mesh ${r.report.meshMs.toFixed(0).padStart(5)}  tris ${String(tris).padStart(7)}  meshKB ${(json / 1024).toFixed(0).padStart(6)}  ${name}  [${top}]`);
  console.log(rows.at(-1));
  s.dispose();
}
process.exit(0);
