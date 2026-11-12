/**
 * Revolves about a model edge, about the axis of a round edge and symmetric to the sketch; sweeps
 * along a circle and from a model face; a coil from a model face. Each checked by its volume
 * (Pappus: area × path of the centroid) and where it lies.
 */
import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const box: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
const shaft: Feature[] = [
  sketch("skc", { ref: "origin.XY" }, circle("c", 100, 0, 5)),
  { id: "exc", op: "extrude", profile: { sketch: "skc" }, extent: "blind", distance: 10, mode: "new_body" },
];

async function build(features: Feature[], id: string) {
  const { report } = (await newSession()).rebuild(doc(features));
  expect(report.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
  return report.bodies.find((b) => b.id === id)!;
}

describe("axes from model edges", () => {
  it("revolves a profile a quarter turn about a straight edge of the box", async () => {
    // The box's edge at x = 40, y = 0 runs along Z; the 5 × 10 profile lies 5…10 mm from it.
    const b = await build(
      [...box, sketch("sk2", { ref: "origin.XZ" }, rect("p", 45, 0, 5, 10)), { id: "rv1", op: "revolve", profile: { sketch: "sk2" }, axis: { edge: { edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] } }, angle: 90, mode: "new_body" }],
      "rv1",
    );
    expect(b.volume).toBeCloseTo((Math.PI / 2) * 50 * 7.5, 1);
    // A quarter turn about the edge: from the XZ plane to the plane x = 40.
    expect(b.bbox.min[0]).toBeCloseTo(40, 3);
    expect(b.bbox.max[0]).toBeCloseTo(50, 3);
    expect(Math.max(Math.abs(b.bbox.min[1]), Math.abs(b.bbox.max[1]))).toBeCloseTo(10, 3);
  });

  it("revolves a ring about the axis of a round edge", async () => {
    // The shaft's top circle has its axis at x = 100, y = 0; the 2 × 4 profile lies 10…12 mm out.
    const b = await build(
      [...shaft, sketch("sk2", { ref: "origin.XZ" }, rect("p", 110, 0, 2, 4)), { id: "rv1", op: "revolve", profile: { sketch: "sk2" }, axis: { edge: { edge: ["exc.end_cap", "exc.side[skc.c]"] } }, angle: 360, mode: "new_body" }],
      "rv1",
    );
    expect(b.volume).toBeCloseTo(2 * Math.PI * 11 * 8, 1);
    expect(b.bbox.min[0]).toBeCloseTo(88, 3);
    expect(b.bbox.max[0]).toBeCloseTo(112, 3);
    expect(b.bbox.min[1]).toBeCloseTo(-12, 3);
  });

  it("revolves symmetric to the sketch: half the angle to each side", async () => {
    const b = await build(
      [...box, sketch("sk2", { ref: "origin.XZ" }, rect("p", 45, 0, 5, 10)), { id: "rv1", op: "revolve", profile: { sketch: "sk2" }, axis: { edge: { edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] } }, angle: 90, symmetric: true, mode: "new_body" }],
      "rv1",
    );
    expect(b.volume).toBeCloseTo((Math.PI / 2) * 50 * 7.5, 1);
    // ±45° about x = 40: from 40 + 5·cos 45° to 50, and ±10·sin 45° across.
    expect(b.bbox.max[0]).toBeCloseTo(50, 3);
    expect(b.bbox.min[1]).toBeCloseTo(-10 * Math.SQRT1_2, 3);
    expect(b.bbox.max[1]).toBeCloseTo(10 * Math.SQRT1_2, 3);
  });
});

describe("sweeps and coils", () => {
  it("sweeps a circle round a circle into a torus", async () => {
    const b = await build(
      [sketch("sk1", { ref: "origin.XZ" }, circle("c", 20, 0, 1)), sketch("sk2", { ref: "origin.XY" }, circle("o", 0, 0, 20)), { id: "sw1", op: "sweep", profile: { sketch: "sk1" }, path: { sketch: "sk2" }, mode: "new_body" }],
      "sw1",
    );
    expect(b.volume).toBeCloseTo(2 * Math.PI ** 2 * 20 * 1, 1);
    expect(b.bbox.max[0]).toBeCloseTo(21, 3);
    expect(b.bbox.max[2]).toBeCloseTo(1, 3);
  });

  /** A 2 × 2 bar lying in the XZ plane at x = 20…22, z = 0…2, 1 mm thick. */
  const bar: Feature[] = [
    sketch("skb", { ref: "origin.XZ" }, rect("q", 20, 0, 2, 2)),
    { id: "exb", op: "extrude", profile: { sketch: "skb" }, extent: "blind", distance: 1, mode: "new_body" },
  ];

  it("sweeps a model face along a line", async () => {
    const b = await build(
      [...bar, sketch("sk2", { ref: "origin.XY" }, [{ id: "a", type: "point", x: 21, y: 0 }, { id: "b", type: "point", x: 21, y: -30 }, { id: "ln", type: "line", p1: "a", p2: "b" }]), { id: "sw1", op: "sweep", profile: { face: { face: "exb.start_cap" } }, path: { sketch: "sk2" }, mode: "new_body" }],
      "sw1",
    );
    expect(b.volume).toBeCloseTo(4 * 30, 2);
    expect(b.bbox.max[1] - b.bbox.min[1]).toBeCloseTo(30, 3);
  });

  it("coils a model face once round the Z axis", async () => {
    // The profile lies in a plane through the axis: V = area × 2π × centroid radius per turn.
    const b = await build([...bar, { id: "co1", op: "coil", profile: { face: { face: "exb.start_cap" } }, axis: { ref: "origin.Z" }, pitch: 5, turns: 1, mode: "new_body" }], "co1");
    expect(b.volume / (4 * 2 * Math.PI * 21)).toBeCloseTo(1, 3);
    expect(b.bbox.max[2] - b.bbox.min[2]).toBeCloseTo(7, 2);
  });

  it("keeps a square profile upright over ten turns", async () => {
    // Until Nov 2026 the profile turned about the helix, ~14° a turn: after ten turns the square had
    // turned by more than 130°, its corners up to 0.4 mm beyond the drawn outline.
    const s = await newSession();
    const { report, meshes } = s.rebuild(doc([sketch("skb", { ref: "origin.XZ" }, rect("q", 20, 0, 2, 2)), { id: "co1", op: "coil", profile: { sketch: "skb" }, axis: { ref: "origin.Z" }, pitch: 5, turns: 10, mode: "new_body" }]));
    expect(report.features.filter((f) => f.status === "error")).toEqual([]);
    const b = report.bodies[0]!;
    expect(b.volume / (4 * 2 * Math.PI * 21 * 10)).toBeCloseTo(1, 3);
    expect(b.bbox.max[2] - b.bbox.min[2]).toBeCloseTo(52, 2);
    let rMax = 0;
    let rMin = Infinity;
    const p = meshes[0]!.positions;
    for (let i = 0; i < p.length; i += 3) {
      rMax = Math.max(rMax, Math.hypot(p[i]!, p[i + 1]!));
      rMin = Math.min(rMin, Math.hypot(p[i]!, p[i + 1]!));
    }
    expect(rMax).toBeCloseTo(22, 2);
    expect(rMin).toBeCloseTo(20, 2);
    // The four sides keep the names of the lines they came from.
    expect(new Set(meshes[0]!.faceTags.flat().filter((t) => t.startsWith("co1.side[")))).toEqual(new Set(["co1.side[skb.q1]", "co1.side[skb.q2]", "co1.side[skb.q3]", "co1.side[skb.q4]"]));
  });
});
