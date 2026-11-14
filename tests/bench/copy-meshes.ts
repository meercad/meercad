// Holds the meshes that copies of parts took over (CopyMeshes) against the meshes those parts get alone.
// Usage (from tests/): ../node_modules/.bin/jiti bench/copy-meshes.ts file.meercad [--coarse=2]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { copyMeshProblems } from "../copy-meshes-check.js";

const coarse = Number(process.argv.find((a) => a.startsWith("--coarse="))?.slice(9) ?? 1);
const file = process.argv.slice(2).find((a) => !a.startsWith("--"))!;
const oc = await loadOcct();
const s = new KernelSession(oc, await SketchSolver.create());
s.meshCoarse = coarse;

const r = s.rebuild(JSON.parse(readFileSync(file, "utf8")) as MeercadDocument, { props: false });
const { copies, problems } = copyMeshProblems(oc, s, r.meshes, coarse);
console.log(`${r.meshes.length} parts, ${copies} of them copies or copied; ${problems.length} differences`);
console.log(problems.slice(0, 40).join("\n"));
process.exit(problems.length ? 1 : 0);
