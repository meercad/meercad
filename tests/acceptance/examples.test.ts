import { describe, expect, it } from "vitest";
import { validateDocument } from "@meercad/schema";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";
import { newSession, withParams } from "./helpers.js";

describe("home-screen examples", () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))("%s validates, is fully defined and rebuilds", async (_, ex) => {
    expect(validateDocument(ex.doc).ok).toBe(true);
    const { report } = (await newSession()).rebuild(ex.doc);
    expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    for (const s of report.sketches) expect(s.diagnostics.dof, `${s.id} DOF`).toBe(0);
    // Most are one part; the gear pair has two, the hinged box three (box, lid, pin).
    expect(report.bodies).toHaveLength({ "Gear pair": 2, "Hinged box": 3 }[ex.name] ?? 1);
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
