import { describe, expect, it } from "vitest";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** Copies get ids from the feature that made them ("tr_knee_ex1"); later features must find them by that id. */
describe("copied bodies in later features", () => {
  it("mirrors, moves and cuts copies whose feature ids hold underscores", async () => {
    const s = await newSession();
    const r = s.rebuild(
      doc([
        sketch("sk1", { ref: "origin.XY" }, rect("l", 10, 0, 10, 10)),
        { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
        { id: "tr_knee", op: "transform", bodies: ["ex1"], translate: [0, 30, 0], copy: true },
        { id: "mi_leg", op: "mirror", source: { bodies: ["tr_knee_ex1"] }, plane: { ref: "origin.YZ" } },
        { id: "tr_up", op: "transform", bodies: ["mi_leg_1"], translate: [0, 0, 5] },
        sketch("sk2", { ref: "origin.XY" }, rect("c", -15, 30, 4, 4)),
        { id: "cut1", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, mode: "cut", targets: ["mi_leg_1"] },
      ]),
    ).report;
    expect(r.features.filter((f) => f.status !== "ok")).toEqual([]);
    const copy = r.bodies.find((b) => b.id === "mi_leg_1")!;
    expect(copy.bbox.min[0]).toBeCloseTo(-20, 3);
    expect(copy.bbox.min[2]).toBeCloseTo(5, 3);
    expect(copy.volume).toBeCloseTo(1000 - 160, 1);
  });
});
