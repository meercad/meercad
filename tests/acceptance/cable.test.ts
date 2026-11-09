import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { doc, newSession } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const info = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;

describe("cable", () => {
  it("lays a round cable through 3D points as a part of its own, with length and mass", async () => {
    const s = await newSession();
    const f: Feature[] = [{ id: "cab1", op: "cable", points: [{ at: [0, 0, 0] }, { at: [60, 0, 20] }, { at: [120, 40, 20] }], diameter: 3, material: "pvc" }];
    const { report } = s.rebuild(doc(f));
    ok(report);
    const b = report.bodies.find((x) => x.id === "cab1")!;
    const fi = info(report, "cab1");
    const length = fi.info!["length"]!;
    expect(length).toBeGreaterThan(Math.hypot(60, 20) + Math.hypot(60, 40));
    expect(length).toBeLessThan(160);
    // The volume of the tube: section × length.
    expect(b.volume / (Math.PI * 1.5 ** 2 * length)).toBeCloseTo(1, 3);
    expect(fi.info!["mass"]).toBeCloseTo((b.volume / 1000) * 2.9, 1);
    // The start is cut square to the cable, which leaves towards the second point.
    expect(b.bbox.min[0]).toBeCloseTo(-1.5 * Math.sin(Math.atan2(20, 60)), 2);
  });

  it("puts plugs on the ends and sweeps a flat ribbon", async () => {
    const s = await newSession();
    const plugged = s.rebuild(doc([{ id: "cab1", op: "cable", points: [{ at: [0, 0, 0] }, { at: [80, 0, 0] }], diameter: 2.6, start: { kind: "xt30" }, end: { kind: "jst_xh", pins: 3 } }])).report;
    ok(plugged);
    const bb = plugged.bodies[0]!.bbox;
    expect(bb.min[0]).toBeCloseTo(0, 3);
    expect(bb.max[0]).toBeCloseTo(80, 3);
    // The XT30 housing is wider than the cable.
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(10.2, 2);
    const ribbon = s.rebuild(doc([{ id: "cab1", op: "cable", shape: "ribbon", conductors: 10, points: [{ at: [0, 0, 0] }, { at: [50, 0, 0] }, { at: [80, 30, 0] }], end: { kind: "idc" } }])).report;
    ok(ribbon);
    expect(ribbon.bodies[0]!.volume).toBeGreaterThan(12.7 * 0.9 * 80);
  });

  it("explains bends tighter than the cable allows and plugs past the next point", async () => {
    const s = await newSession();
    const tight = s.rebuild(doc([{ id: "cab1", op: "cable", points: [{ at: [0, 0, 0] }, { at: [20, 0, 0] }, { at: [20, 8, 0] }, { at: [0, 8, 0] }], diameter: 2, bendRadius: 15 }])).report;
    expect(info(tight, "cab1").message).toMatch(/bend radius/);
    const past = s.rebuild(doc([{ id: "cab1", op: "cable", points: [{ at: [0, 0, 0] }, { at: [5, 0, 0] }], diameter: 2, start: { kind: "xt60" } }])).report;
    expect(info(past, "cab1").status).toBe("error");
    expect(info(past, "cab1").message).toMatch(/plug reaches past/);
  });
});
