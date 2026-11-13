// Single vs multi-threaded OCCT build: feature rebuild and meshing times on the home-screen examples.
// Usage (from tests/): ../node_modules/.bin/jiti bench/threads.ts single|multi
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";

const mode = process.argv[2] ?? "single";
const t0 = performance.now();
const oc: any = await loadOcct(undefined, mode === "multi");
console.log(mode, "init", Math.round(performance.now() - t0), "ms");

const solver = await SketchSolver.create();

const corpus = (n: string) =>
  JSON.parse(readFileSync(new URL(`../corpus/${n}`, import.meta.url), "utf8")) as MeercadDocument;
const docs: [string, MeercadDocument][] = [
  ...EXAMPLES.map((e) => [e.name, e.doc] as [string, MeercadDocument]),
  ["corpus box-fillet", corpus("box-fillet.meercad.json")],
];
const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;

for (const [name, doc] of docs) {
  const rb: number[] = [];

  for (let i = 0; i < 5; i++) {
    const s = new KernelSession(oc, solver);
    rb.push(s.rebuild(doc, { mesh: false, props: false }).report.rebuildMs);
    s.dispose();
  }

  const s = new KernelSession(oc, solver);
  s.rebuild(doc, { mesh: false, props: false });

  const shape = ([...s.state!.bodies.values()][0] as any).shape;
  const row: string[] = [`${name}: rebuild ${med(rb).toFixed(1)}`];

  for (const lin of [0.03, 0.005]) {
    const t: Record<string, number[]> = { extract: [], par: [], seq: [] };
    let tris = 0;

    for (let i = 0; i < 5; i++) {
      for (const k of Object.keys(t)) {
        oc.BRepTools.Clean(shape, true);

        const a = performance.now();
        if (k !== "extract") new oc.BRepMesh_IncrementalMesh(shape, lin, false, 0.25, k === "par").delete();

        const m = oc.ReplicadMeshExtractor.extract(shape, lin, 0.25, false);
        t[k]!.push(performance.now() - a);
        tris = m.getTrianglesSize() / 3;
        m.delete();
      }
    }

    row.push(
      `lin ${lin} (${tris} tris): ${Object.entries(t)
        .map(([k, v]) => `${k} ${med(v).toFixed(1)}`)
        .join(" ")}`,
    );
  }

  console.log(row.join(" | "));
  s.dispose();
}

process.exit(0);
