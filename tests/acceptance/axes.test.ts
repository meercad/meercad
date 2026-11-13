/**
 * Revolving about axes taken from the model: a hole's round edge (its axis through the centre),
 * a straight edge of a part, and a sketch line. The rings that come out have the volume Pappus's
 * rule gives: 2π × the profile's distance from the axis × its area.
 */
import { describe, expect, it } from "vitest";
import type { AxisRef, Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

/** A 40 × 20 × 10 block with an Ø8 hole whose axis is the line x = 20, y = 10. */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("sk2", { ref: "origin.XY" }, circle("k", 20, 10, 4)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "symmetric", distance: 40, mode: "cut" },
];
/** A 5 × 5 square on the plane x = 20 (through the hole's axis), 20 to 25 mm from it, 30..35 above. */
const profile: Feature[] = [
  { id: "pl1", op: "plane", base: { ref: "origin.YZ" }, offset: 20 },
  sketch("sk3", { ref: "pl1" }, rect("q", 30, 30, 5, 5)),
];

async function ring(axis: AxisRef, extra: Feature[] = [], shape: Feature[] = profile) {
  const { report } = (await newSession()).rebuild(
    doc([
      ...block,
      ...shape,
      ...extra,
      { id: "rv1", op: "revolve", profile: { sketch: "sk3" }, axis, angle: 360, mode: "new_body" },
    ]),
  );
  const st = report.features.find((f) => f.id === "rv1")!;
  expect(st.status, st.message ?? "").toBe("ok");

  return report.bodies.find((b) => b.id === "rv1")!;
}

describe("revolving about axes from the model", () => {
  it("about a hole's round edge: the axis through its centre", async () => {
    const r = await ring({ edge: { edge: ["ex1.end_cap", "ex2.side[sk2.k]"] } });
    // The square's centre is 22.5 mm from the axis y = 10.
    expect(r.volume).toBeCloseTo(2 * Math.PI * 22.5 * 25, 6);
    expect(r.bbox.max[0]! - r.bbox.min[0]!).toBeCloseTo(50, 6);
    expect((r.bbox.max[0]! + r.bbox.min[0]!) / 2).toBeCloseTo(20, 6);
    expect((r.bbox.max[1]! + r.bbox.min[1]!) / 2).toBeCloseTo(10, 6);
  });

  it("about a straight edge of the part: the block's long top edge at y = 20, z = 10", async () => {
    // A 5 × 5 square on the plane y = 20 through that edge (XZ moved to y = 20), at x 10..15 and
    // z 20..25: 10..15 mm above the edge, so 12.5 mm out on average.
    const r = await ring(
      { edge: { edge: ["ex1.end_cap", "ex1.side[sk1.l3]"] } },
      [],
      [
        { id: "pl2", op: "plane", base: { ref: "origin.XZ" }, offset: -20 },
        sketch("sk3", { ref: "pl2" }, rect("q", 10, 20, 5, 5)),
      ],
    );
    expect(r.volume).toBeCloseTo(2 * Math.PI * 12.5 * 25, 6);
  });

  it("refuses an axis square to the sketch: it would make no solid", async () => {
    const { report } = (await newSession()).rebuild(
      doc([
        ...block,
        ...profile,
        {
          id: "rv1",
          op: "revolve",
          profile: { sketch: "sk3" },
          axis: { ref: "origin.X" },
          angle: 360,
          mode: "new_body",
        },
      ]),
    );
    expect(report.features.find((f) => f.id === "rv1")).toMatchObject({
      status: "error",
      message: expect.stringMatching(/stands square to the sketch/),
    });
  });

  it("about a sketch line", async () => {
    const line = sketch("sk4", { ref: "pl1" }, [
      { id: "a", type: "point", x: 10, y: 0 },
      { id: "b", type: "point", x: 10, y: 50 },
      { id: "ax", type: "line", p1: "a", p2: "b", construction: true } as never,
    ]);
    const r = await ring({ line: "sk4.ax" }, [line]);
    // The line y = 10 on that plane is the hole's axis again.
    expect(r.volume).toBeCloseTo(2 * Math.PI * 22.5 * 25, 6);
  });
});
