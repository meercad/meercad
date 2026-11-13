// Writes every corpus part's final bodies (faces, volume, face tags) as JSON, to diff kernel changes.
// Usage (from tests/): ../node_modules/.bin/jiti bench/snapshot.ts out.json
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";

const oc = await loadOcct(undefined, false);
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

const out: Record<string, unknown> = {};

for (const [name, doc] of docs) {
  const s = new KernelSession(oc, solver);
  const r = s.rebuild(doc, { mesh: false });
  out[name] = {
    errors: r.report.features
      .filter((f) => f.status !== "ok")
      .map((f) => `${f.id}: ${f.status} ${f.message ?? ""}`),
    bodies: [...s.state!.bodies.values()].map((b, i) => ({
      id: b.bodyId,
      faces: b.faces.length,
      volume: Number(r.report.bodies[i]!.volume?.toFixed(3)),
      tags: b.faceTags.map((t) => t.join(" ")).sort(),
    })),
  };
  s.dispose();
}

writeFileSync(process.argv[2]!, JSON.stringify(out, null, 1));
process.exit(0);
