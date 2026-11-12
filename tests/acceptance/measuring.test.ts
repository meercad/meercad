/**
 * Measuring by the numbers: edge lengths, a hole's radius and diameter, face areas, distances in
 * x, y and z, angles between faces, edges and both, a cylinder's radius, and stale picks refused.
 * These are the numbers a person copies into a drawing or an order.
 */
import { describe, expect, it } from "vitest";
import { exportMeshes, exportStep, measure, type PickRef } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

/** A 40 × 20 × 10 block with a Ø 8 hole through it at (10, 10). */
const part: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 40, 20), ...circle("h", 10, 10, 4)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];

async function setup() {
  const s = await newSession();
  const { meshes } = s.rebuild(doc(part));
  const m = meshes[0]!;
  const oc = await getOcct();
  const face = (tag: string): PickRef => ({ bodyId: "ex1", kind: "face", index: m.faceTags.findIndex((t) => t.includes(tag)) });
  /** The edge between two faces, by their tags. */
  const edge = (a: string, b: string): PickRef => {
    const fa = m.faceTags.findIndex((t) => t.includes(a));
    const fb = m.faceTags.findIndex((t) => t.includes(b));
    return { bodyId: "ex1", kind: "edge", index: m.edgeFaces.findIndex((f) => f.includes(fa) && f.includes(fb)) };
  };
  const rows = (a: PickRef, b?: PickRef) => Object.fromEntries(measure(oc, s.state!, a, b).rows);
  return { s, oc, face, edge, rows };
}

describe("measuring", () => {
  it("edge lengths and a face's area", async () => {
    const { edge, face, rows } = await setup();
    expect(rows(edge("ex1.end_cap", "ex1.side[sk1.l1]"))["Length"]).toBe("40 mm");
    expect(rows(edge("ex1.side[sk1.l1]", "ex1.side[sk1.l2]"))["Length"]).toBe("10 mm");
    // The top: 40 × 20 less the Ø 8 hole.
    expect(parseFloat(rows(face("ex1.end_cap"))["Area"]!)).toBeCloseTo(800 - 16 * Math.PI, 1);
  });

  it("a hole: the wall's radius, its rim's radius and diameter and circumference", async () => {
    const { edge, face, rows } = await setup();
    expect(rows(face("ex1.side[sk1.h]"))["Radius"]).toBe("4 mm");
    const rim = rows(edge("ex1.end_cap", "ex1.side[sk1.h]"));
    expect(rim["Radius"]).toBe("4 mm");
    expect(rim["Diameter"]).toBe("8 mm");
    expect(parseFloat(rim["Length"]!)).toBeCloseTo(8 * Math.PI, 2);
  });

  it("distance with its x, y and z parts, and angles", async () => {
    const { edge, face, rows } = await setup();
    const across = rows(face("ex1.side[sk1.l2]"), face("ex1.side[sk1.l4]"));
    expect(across["Distance"]).toBe("40 mm");
    expect(across["ΔX / ΔY / ΔZ"]!.split(" / ").map(Number).map(Math.abs)).toEqual([40, 0, 0]);
    expect(across["Angle"]).toBe("0 °");
    expect(rows(face("ex1.end_cap"), face("ex1.side[sk1.l1]"))["Angle"]).toBe("90 °");
    // Two edges at a corner: 90°; an edge along a face: 0° to it.
    expect(rows(edge("ex1.end_cap", "ex1.side[sk1.l1]"), edge("ex1.end_cap", "ex1.side[sk1.l2]"))["Angle"]).toBe("90 °");
    expect(rows(face("ex1.end_cap"), edge("ex1.end_cap", "ex1.side[sk1.l1]"))["Angle"]).toBe("0 °");
    // The hole's wall to its centre line: no angle for a round face.
    expect(rows(face("ex1.side[sk1.h]"), face("ex1.end_cap"))["Angle"]).toBeUndefined();
    // From the hole's wall to the left side: 10 − 4 = 6 mm.
    expect(rows(face("ex1.side[sk1.h]"), face("ex1.side[sk1.l4]"))["Distance"]).toBe("6 mm");
  });

  it("refuses a pick that no longer exists, and exports of nothing", async () => {
    const { s, oc } = await setup();
    expect(() => measure(oc, s.state!, { bodyId: "zz", kind: "face", index: 0 })).toThrow(/selection no longer exists/);
    expect(() => measure(oc, s.state!, { bodyId: "ex1", kind: "edge", index: 9999 })).toThrow(/selection no longer exists/);
    expect(() => exportStep(oc, s.state!, ["zz"])).toThrow(/nothing to export/);
    expect(() => exportMeshes(oc, s.state!, ["zz"])).toThrow(/nothing to export/);
  });

  it("export of the same part twice gives the same triangles (kept between exports)", async () => {
    const { s, oc } = await setup();
    const a = exportMeshes(oc, s.state!);
    const b = exportMeshes(oc, s.state!);
    expect(b[0]).toBe(a[0]);
  });
});
