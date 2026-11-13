/**
 * Rebuild speed: how long a person waits after opening a design, after changing a value, and when
 * nothing changed at all. Same path as the app (`KernelSession.rebuild`, single-threaded build).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KernelSession, loadOcct, type OC } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { MODELS } from "../models/models.js";
import { check, report, time, timeAsync } from "./harness.js";

report();

/** What a person waits for at most (Mac, single-threaded kernel), unless a model says otherwise. */
const BUDGET = {
  /** Loading the OCCT and sketch solver WASM, once per app start. */
  startup: 3000,
  /** Opening a design: every feature plus the meshes for the viewport. */
  open: 2500,
  /** Rebuilding without a change (e.g. a click that changes nothing). */
  unchanged: 30,
  /** Changing a value: never slower than opening it again. */
  change: 2500,
};
/** Designs that are known to be heavy (threads, many booleans), with their own budget. */
const OPEN_BUDGET: Record<string, number> = {
  "model 10 Schraube M8": 5000,
  "model 11 Mutter M8": 6000,
  // The slowest model by far (about 12 s on a 4-core Linux runner): worth a look on its own.
  "model 19 Pfeilradpaar": 15000,
  "model 20 Planetengetriebe": 6000,
  "model 24 Lochplatte mit Normbohrungen": 4000,
  "model 32 Platte mit Normteilen": 4500,
};

const docs: [string, MeercadDocument, (typeof MODELS)[number] | undefined][] = MODELS.map((m) => [
  `model ${m.file}`,
  m.doc,
  m,
]);
const corpusDir = new URL("../corpus/", import.meta.url);

// feature-* files are the single-feature demos, already covered by the test models.
for (const f of readdirSync(corpusDir)
  .filter((f) => !f.startsWith("feature-"))
  .sort()) {
  docs.push([
    `corpus ${f.replace(/\.meercad\.json$/, "")}`,
    JSON.parse(readFileSync(new URL(f, corpusDir), "utf8")) as MeercadDocument,
    undefined,
  ]);
}

let oc: OC;
let solver: SketchSolver;

describe("rebuild performance", () => {
  it("starts the kernel", async () => {
    const t = performance.now();
    oc = await loadOcct();
    solver = await SketchSolver.create();
    check("startup: OCCT + sketch solver", { value: performance.now() - t, unit: "ms" }, BUDGET.startup);
    // Instantiating once more shows the cost without the module download/compile cache.
    check("startup: second sketch solver", await timeAsync(() => SketchSolver.create(), 3), 500);
  });

  it.each(docs.map((d) => [d[0], d] as const))("%s", (name, [, doc, model]) => {
    // Opening: a fresh session each time, like opening the file in a new tab.
    let tris = 0;
    let faces = 0;

    const openOnce = () => {
      const s = new KernelSession(oc, solver);
      const r = s.rebuild(doc);
      expect(
        r.report.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`),
      ).toEqual([]);
      tris = r.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
      faces = r.report.bodies.reduce((n, b) => n + b.faces, 0);
      s.dispose();
    };

    // Median of 3; small parts are measured again with 9 runs, where one slow run would weigh too much.
    let open = time(openOnce, 3);
    if (open.value < 300) open = time(openOnce, 9);

    check(`${name}: open`, open, OPEN_BUDGET[name] ?? BUDGET.open);
    // Counts are the same on every machine: a jump in triangles makes the viewport slow.
    check(`${name}: triangles`, { value: tris, unit: "tris" }, 2_000_000);
    check(`${name}: faces`, { value: faces, unit: "faces" }, 50_000);

    const s = new KernelSession(oc, solver);
    s.rebuild(doc);
    // Nothing changed: everything comes from the cache.
    check(
      `${name}: unchanged`,
      time(() => s.rebuild(doc), 5),
      BUDGET.unchanged,
    );

    // A value change, as in the variables panel, back and forth.
    const variant = model?.variants?.[0];

    if (variant) {
      const changed = { ...doc, params: { ...doc.params, ...variant.params } };
      let flip = false;
      const change = time(() => {
        flip = !flip;

        const r = s.rebuild(flip ? changed : doc);
        expect(r.report.firstRecomputed).toBeGreaterThanOrEqual(0);
      }, 4);
      check(`${name}: change value`, change, Math.max(BUDGET.change, OPEN_BUDGET[name] ?? 0));
    }

    s.dispose();
  });
});
