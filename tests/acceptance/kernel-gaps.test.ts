/**
 * Kernel paths the other tests leave out, each checked by its sizes: a pattern of two new parts at
 * once, a coil of a ring-shaped profile (a tube), a mesh part moved before it is converted, and a
 * snap hook whose barbs reach no part to click into.
 */
import { describe, expect, it } from "vitest";
import { exportMeshes } from "@meercad/kernel";
import { writeStl } from "@meercad/io";
import type { Feature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

async function build(features: Feature[]) {
  const s = await newSession();
  return { session: s, ...s.rebuild(doc(features)) };
}
const okAll = (r: { features: { id: string; status: string; message?: string }[] }) => expect(r.features.filter((f) => f.status === "error")).toEqual([]);

describe("kernel corners", () => {
  it("patterns two new parts at once: each copy its own part, the same size", async () => {
    const { report } = await build([
      sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 10, 10)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
      sketch("sk2", { ref: "origin.XY" }, circle("c", 30, 5, 4)),
      { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 8, mode: "new_body" },
      { id: "lp1", op: "linear_pattern", source: { features: ["ex1", "ex2"] }, direction: { ref: "origin.Y" }, count: 3, spacing: 20 },
    ]);
    okAll(report);
    const ids = report.bodies.map((b) => b.id).sort();
    expect(ids).toEqual(["ex1", "ex2", "lp1_ex1_1", "lp1_ex1_2", "lp1_ex2_1", "lp1_ex2_2"]);
    const vol = (id: string) => report.bodies.find((b) => b.id === id)!.volume;
    expect(vol("lp1_ex1_2")).toBeCloseTo(500, 6);
    expect(vol("lp1_ex2_1")).toBeCloseTo(Math.PI * 16 * 8, 6);
    // The second copy of the cylinder stands 2 × 20 mm along Y.
    const bb = report.bodies.find((b) => b.id === "lp1_ex2_2")!.bbox;
    expect((bb.min[1] + bb.max[1]) / 2).toBeCloseTo(45, 6);
  });

  it("coils a ring-shaped profile into a tube: volume = ring area × path length", async () => {
    // A ring 4 mm across with a 2 mm hole, its centre 20 mm from the axis, 8 mm pitch, a quarter turn.
    const { report } = await build([
      sketch("sk1", { ref: "origin.XZ" }, [...circle("o", 20, 0, 2), ...circle("i", 20, 0, 1)]),
      { id: "co1", op: "coil", profile: { sketch: "sk1" }, axis: { ref: "origin.Z" }, pitch: 8, turns: 0.25, mode: "new_body" },
    ]);
    okAll(report);
    const area = Math.PI * (2 * 2 - 1 * 1);
    // The profile stands in a plane through the axis: Pappus with the centroid's helix.
    const path = 0.25 * Math.hypot(2 * Math.PI * 20, 8);
    const v = report.bodies.find((b) => b.id === "co1")!.volume;
    // A profile in the axis plane (not square to the helix) sweeps a little less than area × path.
    expect(v).toBeGreaterThan(area * 0.25 * 2 * Math.PI * 20 * 0.995);
    expect(v).toBeLessThan(area * path * 1.005);
  });

  it("converts a mesh part that was moved first, keeping its size", async () => {
    const s = await newSession();
    const box = s.rebuild(doc([sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 20, 10)), { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 6, mode: "new_body" }]));
    okAll(box.report);
    const data = Buffer.from(writeStl(exportMeshes(await getOcct(), s.state!))).toString("base64");
    const { report } = await build([
      { id: "im1", op: "import", format: "stl", fileName: "box.stl", data },
      { id: "mv1", op: "transform", bodies: ["im1"], translate: [5, 0, 0] },
      { id: "mc1", op: "mesh_convert", body: "im1" },
    ]);
    okAll(report);
    const b = report.bodies.find((x) => x.id === "im1")!;
    expect(b.volume).toBeCloseTo(1200, 3);
    expect(b.bbox.min[0]).toBeCloseTo(5, 4);
    expect(b.bbox.max[0]).toBeCloseTo(25, 4);
  });

  it("warns when a snap hook's barbs reach no part to click into, and cuts no window", async () => {
    const { report } = await build([
      sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 40, 30)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, distance: 3, mode: "new_body" } as Feature,
      sketch("sk2", { ref: "origin.XY" }, rect("b", 200, 0, 2, 30)),
      { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, distance: 17, mode: "new_body" } as Feature,
      { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 3 },
      { id: "sh1", op: "snap_hook", plane: { ref: "pl1" }, points: [[20, 15]], catchIn: ["ex2"] } as Feature,
    ]);
    const st = report.features.find((f) => f.id === "sh1")!;
    expect(st.status).toBe("warning");
    expect(st.message).toMatch(/do not reach "ex2": no window cut/);
    expect(report.bodies.find((b) => b.id === "ex2")!.volume).toBeCloseTo(2 * 30 * 17, 6);
  });
});
