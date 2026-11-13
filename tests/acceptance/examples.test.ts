import { describe, expect, it } from "vitest";
import { validateDocument } from "@meercad/schema";
import { EXAMPLES, examplePacks } from "../../apps/web/src/lib/examples.js";
import { newSession, withParams } from "./helpers.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = join(import.meta.dirname, "../../apps/web/public");
const CORPUS = join(import.meta.dirname, "../corpus");

/** The small one-feature demos: test models only, never shipped with the app. */
describe("feature demos (tests/corpus)", () => {
  const demos = readdirSync(CORPUS).filter((f) => f.startsWith("feature-"));
  it("are all there", () => expect(demos.length).toBe(34));
  it.each(demos)("%s validates and rebuilds", async (f) => {
    const doc = JSON.parse(readFileSync(join(CORPUS, f), "utf8"));
    expect(validateDocument(doc).ok).toBe(true);
    const { report } = (await newSession()).rebuild(doc);
    expect(report.features.filter((x) => x.status !== "ok").map((x) => `${x.id}: ${x.message}`)).toEqual([]);
    expect(report.bodies.length).toBeGreaterThan(0);
  });
});

describe("home-screen examples", () => {
  it("names are unique", () => expect(new Set(EXAMPLES.map((e) => e.name)).size).toBe(EXAMPLES.length));

  // The home screen shows an example only with the packs it needs.
  it("know the packs they need", () => {
    const of = (name: string) => examplePacks(EXAMPLES.find((e) => e.name === name)!);
    expect(of("Mounting plate")).toEqual([]);
    expect(of("Gear pair")).toContain("mechanics");
    // Its variants are a shortcut; the din variable changes it without the versions pack.
    expect(of("Stackable DIN box")).toEqual([]);
  });

  it.each(EXAMPLES.filter((e) => !e.url).map((e) => [e.name, e] as const))("%s validates, is fully defined and rebuilds", async (_, ex) => {
    expect(validateDocument(ex.doc).ok).toBe(true);
    const { report } = (await newSession()).rebuild(ex.doc);
    expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    expect(report.bodies.length).toBeGreaterThan(0);
    // The per-feature examples show a feature; only the starters are fully dimensioned.
    if (ex.feature) return;
    for (const s of report.sketches) expect(s.diagnostics.dof, `${s.id} DOF`).toBe(0);
    // Most are one part; the gear pair has two, the hinged box three (box, lid, pin).
    expect(report.bodies).toHaveLength({ "Gear pair": 2, "Hinged box": 3, "Two-material grip": 2, "Linear axis": 9 }[ex.name] ?? 1);
    // The coil takes about 145 s on the CI runner, longer than the usual limit.
  }, 300_000);

  it("the examples fetched when opened are there and valid", () => {
    for (const ex of EXAMPLES.filter((e) => e.url)) {
      const v = validateDocument(JSON.parse(readFileSync(join(PUBLIC, ex.url!), "utf8")));
      expect(v.ok, ex.name).toBe(true);
      if (v.ok) expect(v.value.references?.[0]?.marks?.length, ex.name).toBeGreaterThan(0);
      expect(existsSync(join(PUBLIC, ex.thumbnail!)), `${ex.name} picture`).toBe(true);
    }
  });

  it("gear pair and hinged box follow their variables", async () => {
    const s = await newSession();
    const gears = EXAMPLES.find((e) => e.name === "Gear pair")!.doc;
    for (const p of [{ pinion: "12", wheel: "40" }, { module: "2 mm" }] as Record<string, string>[]) {
      const { report } = s.rebuild(withParams(gears, p));
      expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    }
    const box = EXAMPLES.find((e) => e.name === "Hinged box")!.doc;
    const { report } = s.rebuild(withParams(box, { width: "80 mm", height: "30 mm" }));
    expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    // The pin still lies along the back edge on top of the box.
    const pin = report.bodies.find((b) => b.id === "ex3")!.bbox;
    expect(pin.max[0] - pin.min[0]).toBeCloseTo(80, 3);
    expect((pin.min[2] + pin.max[2]) / 2).toBeCloseTo(30, 3);
  });

  it("mounting plate survives parameter changes", async () => {
    const s = await newSession();
    const ex = EXAMPLES[0]!.doc;
    for (const p of [{ width: "90 mm" }, { depth: "30 mm", hole: "3 mm" }, { thickness: "8 mm", corner: "2 mm" }] as Record<string, string>[]) {
      const { report } = s.rebuild(withParams(ex, p));
      expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    }
  });
});
