import { describe, expect, it } from "vitest";
import { applyOp, formatMass, massProperties, materialById } from "@meercad/model";
import type { Feature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** Two blocks: 10 × 10 × 10 at the origin, 20 × 10 × 10 from x = 30. */
const two: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 10, 10)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("sk2", { ref: "origin.XY" }, rect("b", 30, 0, 20, 10)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];

describe("mass and centre of gravity", () => {
  it("reports each part's centre of volume", async () => {
    const s = await newSession();
    const { report } = s.rebuild(doc(two));
    expect(report.bodies.find((b) => b.id === "ex1")!.centroid).toEqual([5, 5, 5].map((v) => expect.closeTo(v, 9)));
    expect(report.bodies.find((b) => b.id === "ex2")!.centroid).toEqual([40, 5, 5].map((v) => expect.closeTo(v, 9)));
  });

  it("weighs parts by their material and finds the centre of gravity", async () => {
    const s = await newSession();
    let d = doc(two);
    d = applyOp(d, { type: "set_material", part: "ex1", material: "steel" });
    d = applyOp(d, { type: "set_material", part: "ex2", material: "pla" });
    expect(d.partMaterials).toEqual({ ex1: "steel", ex2: "pla" });
    const { report } = s.rebuild(d);
    const parts = report.bodies.map((b) => ({ volume: b.volume, centroid: b.centroid!, material: materialById(d.partMaterials![b.id])! }));
    const m = massProperties(parts);
    // 1 cm³ of steel (7.85 g) and 2 cm³ of PLA (2.48 g).
    expect(m.mass).toBeCloseTo(7.85 + 2.48, 6);
    expect(m.center![0]).toBeCloseTo((5 * 7.85 + 40 * 2.48) / (7.85 + 2.48), 6);
    expect(formatMass(m.mass)).toBe("10.3 g");
    expect(formatMass(2500)).toBe("2.50 kg");
    // Taking the material away, and unknown materials.
    expect(applyOp(d, { type: "set_material", part: "ex1", material: null }).partMaterials).toEqual({ ex2: "pla" });
    expect(() => applyOp(d, { type: "set_material", part: "ex1", material: "unobtainium" })).toThrow(/unknown material/);
  });
});
