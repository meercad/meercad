import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);

describe("coil", () => {
  it("sweeps a round profile into a helix of the right volume", async () => {
    const s = await newSession();
    // Ø2 circle 10 mm from the Z axis on XZ: 5 turns at 4 mm pitch.
    const f: Feature[] = [sketch("sk1", { ref: "origin.XZ" }, circle("c1", 10, 0, 1)), { id: "co1", op: "coil", profile: { sketch: "sk1" }, axis: { ref: "origin.Z" }, pitch: 4, turns: 5, mode: "new_body" }];
    const { report } = s.rebuild(doc(f));
    ok(report);
    const len = 5 * Math.hypot(2 * Math.PI * 10, 4);
    // Pappus: area × path of the centre (the profile lies in a plane through the axis, slightly slanted to the path).
    expect(report.bodies[0]!.volume).toBeGreaterThan(Math.PI * len * 0.95);
    expect(report.bodies[0]!.volume).toBeLessThan(Math.PI * len * 1.05);
    const bb = report.bodies[0]!.bbox;
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(22, 1);
    expect(bb.max[0]).toBeCloseTo(11, 1);
  });
});

describe("coil variants", () => {
  it("tapers into a cone and explains overlapping turns and profiles on the axis", async () => {
    const s = await newSession();
    const prof = sketch("sk1", { ref: "origin.XZ" }, circle("c1", 10, 0, 1));
    const cone = s.rebuild(doc([prof, { id: "co1", op: "coil", profile: { sketch: "sk1" }, axis: { ref: "origin.Z" }, pitch: 4, turns: 3, taper: 20, mode: "new_body" }])).report;
    ok(cone);
    // The radius grows by 12·tan 20° ≈ 4.4 mm over the height.
    expect(cone.bodies[0]!.bbox.max[0]).toBeGreaterThan(13);
    const tight = s.rebuild(doc([prof, { id: "co1", op: "coil", profile: { sketch: "sk1" }, axis: { ref: "origin.Z" }, pitch: 1.5, turns: 3, mode: "new_body" }])).report;
    expect(tight.features.find((x) => x.id === "co1")!.message).toMatch(/run into each other/);
    const onAxis = s.rebuild(doc([sketch("sk1", { ref: "origin.XZ" }, circle("c1", 0, 0, 1)), { id: "co1", op: "coil", profile: { sketch: "sk1" }, axis: { ref: "origin.Z" }, pitch: 4, turns: 3, mode: "new_body" }])).report;
    expect(onAxis.features.find((x) => x.id === "co1")!.message).toMatch(/axis/);
  });

  it("cuts a square thread into a rod (left-handed too)", async () => {
    const s = await newSession();
    const rod: Feature[] = [
      sketch("sk1", { ref: "origin.XY" }, circle("c1", 0, 0, 10)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
      sketch("sk2", { ref: "origin.XZ" }, rect("r", 8, 5, 2.5, 2)),
    ];
    const plain = s.rebuild(doc(rod)).report;
    for (const leftHanded of [false, true]) {
      const { report } = s.rebuild(doc([...rod, { id: "co1", op: "coil", profile: { sketch: "sk2" }, axis: { ref: "origin.Z" }, pitch: 4, turns: 4, leftHanded, mode: "cut" }]));
      ok(report);
      const removed = plain.bodies[0]!.volume - report.bodies[0]!.volume;
      // The part of the 2 × 2.5 square inside the rod (2 × 2) along 4 turns at about r = 9.
      expect(removed).toBeGreaterThan(4 * 4 * 2 * Math.PI * 9 * 0.9);
      expect(removed).toBeLessThan(4 * 4 * 2 * Math.PI * 9 * 1.1);
    }
  });
});

describe("spring", () => {
  it("builds compression springs with ground, closed and open ends to the free length", async () => {
    const s = await newSession();
    for (const ends of ["ground", "closed", "open"] as const) {
      const { report } = s.rebuild(doc([{ id: "spr1", op: "spring", kind: "compression", wire: 1.5, diameter: 15, coils: 6, length: 40, ends, mode: "new_body" }]));
      ok(report);
      const bb = report.bodies[0]!.bbox;
      // Ground ends are flat at 0 and 40; closed and open ones end in the wire's slanted round end.
      expect(bb.min[2]).toBeCloseTo(0, ends === "ground" ? 3 : 1);
      expect(bb.max[2]).toBeCloseTo(40, ends === "ground" ? 3 : 1);
      expect(bb.max[0] - bb.min[0]).toBeCloseTo(15, 0);
      const info = report.features.find((x) => x.id === "spr1")!.info!;
      // Wire volume ≈ (π/4)d² × coil length.
      const turns = ends === "open" ? 6 : 8;
      const wire = (Math.PI / 4) * 1.5 ** 2 * turns * Math.PI * 13.5;
      expect(report.bodies[0]!.volume).toBeGreaterThan(wire * (ends === "ground" ? 0.85 : 0.97));
      expect(report.bodies[0]!.volume).toBeLessThan(wire * 1.05);
      // k = G d⁴ / (8 D³ n) with G = 81.5 GPa.
      expect(info["rateSteel"]).toBeCloseTo((81500 * 1.5 ** 4) / (8 * 13.5 ** 3 * 6), 2);
    }
    const tooShort = s.rebuild(doc([{ id: "spr1", op: "spring", kind: "compression", wire: 2, diameter: 15, coils: 10, length: 20, mode: "new_body" }])).report;
    expect(tooShort.features[0]!.message).toMatch(/too many coils/);
  });

  it("builds extension springs with loops and torsion springs with legs", async () => {
    const s = await newSession();
    const ext = s.rebuild(doc([{ id: "spr1", op: "spring", kind: "extension", wire: 1, diameter: 10, coils: 10, mode: "new_body" }])).report;
    ok(ext);
    const bb = ext.bodies[0]!.bbox;
    expect(bb.min[2]).toBeCloseTo(0, 2);
    // Body 10 × 1.3 + loops of the mean diameter at each end.
    expect(bb.max[2]).toBeCloseTo(10 * 1.3 + 2 * 9 + 1, 1);
    const tor = s.rebuild(doc([{ id: "spr1", op: "spring", kind: "torsion", wire: 1.5, diameter: 12, coils: 5.25, legs: 20, mode: "new_body" }])).report;
    ok(tor);
    const t = tor.bodies[0]!.bbox;
    expect(Math.max(t.max[0] - t.min[0], t.max[1] - t.min[1])).toBeGreaterThan(25);
  });
});
