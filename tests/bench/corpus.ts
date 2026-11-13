// Cold rebuild and meshing times on real parts (examples, tests/corpus, ~/Documents/leocad), plus
// time per feature type, so a faster kernel can be judged against where the time actually goes.
// Usage (from tests/): ../node_modules/.bin/jiti bench/corpus.ts single|multi [stepDir]
// With stepDir, the final bodies are written there as STEP for bench/native (the C++ comparison).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KernelSession, exportStep, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";

const mode = process.argv[2] ?? "single";
const stepDir = process.argv[3];
const t0 = performance.now();
const oc = await loadOcct(undefined, mode === "multi");
console.log(mode, "init", Math.round(performance.now() - t0), "ms");

const solver = await SketchSolver.create();

const docs: [string, MeercadDocument][] = EXAMPLES.map((e) => [`example ${e.name}`, e.doc]);
const corpusDir = new URL("../corpus/", import.meta.url);

for (const f of readdirSync(corpusDir)) {
  docs.push([`corpus ${f}`, JSON.parse(readFileSync(new URL(f, corpusDir), "utf8")) as MeercadDocument]);
}

const userDir = join(homedir(), "Documents", "leocad");

if (existsSync(userDir)) {
  for (const f of readdirSync(userDir)) {
    const p = join(userDir, f);

    if (f.endsWith(".meercad") && statSync(p).size > 1000) {
      docs.push([`user ${f}`, JSON.parse(readFileSync(p, "utf8")) as MeercadDocument]);
    }
  }
}

const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
const RUNS = 7;
if (stepDir) mkdirSync(stepDir, { recursive: true });

for (const [name, doc] of docs) {
  const rebuild: number[] = [];
  const mesh: number[] = [];
  const props: number[] = [];
  const byType = new Map<string, number[]>();
  const byFeature = new Map<string, number[]>();
  const types = new Map(doc.features.map((f) => [f.id, f.op as string]));
  let faces = 0;
  let tris = 0;

  for (let i = 0; i < RUNS; i++) {
    const s = new KernelSession(oc, solver);
    const r = s.rebuild(doc, { props: false });
    rebuild.push(r.report.rebuildMs);
    mesh.push(r.report.meshMs);

    const a = performance.now();
    s.bodyProps();
    props.push(performance.now() - a);

    const sums = new Map<string, number>();

    for (const f of r.report.features) {
      sums.set(types.get(f.id) ?? "?", (sums.get(types.get(f.id) ?? "?") ?? 0) + f.ms);
    }

    for (const [k, v] of sums) byType.set(k, [...(byType.get(k) ?? []), v]);

    for (const f of r.report.features) {
      byFeature.set(`${f.id} (${types.get(f.id)})`, [
        ...(byFeature.get(`${f.id} (${types.get(f.id)})`) ?? []),
        f.ms,
      ]);
    }

    faces = r.report.bodies.reduce((n, b) => n + b.faces, 0);
    tris = r.meshes.reduce((n, m) => n + m.indices.length / 3, 0);

    if (i === 0 && stepDir && s.state!.bodies.size) {
      writeFileSync(join(stepDir, `${name.replace(/[^\w.-]+/g, "_")}.step`), exportStep(oc, s.state!));
    }

    s.dispose();
  }

  const slowest = [...byFeature]
    .map(([k, v]) => [k, med(v)] as const)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5);
  const top = [...byType]
    .map(([k, v]) => [k, med(v)] as const)
    .sort((x, y) => y[1] - x[1])
    .filter(([, v]) => v >= 0.5);
  console.log(
    `${name} (${doc.features.length} features, ${faces} faces, ${tris} tris): rebuild ${med(rebuild).toFixed(1)} mesh ${med(mesh).toFixed(1)} props ${med(props).toFixed(1)} ms | ${top.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`,
  );

  if (doc.features.length > 10) {
    console.log(`  slowest: ${slowest.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`);
  }
}

process.exit(0);
