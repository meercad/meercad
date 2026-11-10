import { describe, expect, it } from "vitest";
import { clearances, type RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { doc, getOcct, newSession } from "./helpers.js";

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
    // The XT30 housing is wider than the cable; plugs and cable are one solid.
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(10.2, 2);
    const cableOnly = Math.PI * 1.3 ** 2 * plugged.features[0]!.info!["length"]!;
    const housings = 10.2 * 5.2 * 15.5 + (2.5 * 3 + 2.4) * 5.75 * 7;
    // (the cable reaches 1 mm into each plug)
    expect(Math.abs(plugged.bodies[0]!.volume - (cableOnly + housings - 2 * Math.PI * 1.3 ** 2)) / plugged.bodies[0]!.volume).toBeLessThan(0.01);
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

  it("sweeps straight cables in any direction and curved ones with straight ends, and meshes them quickly", async () => {
    const s = await newSession();
    // A straight cable along Z (plugged or not) used to sweep into a surface that meshing never
    // finished, and slanted straight cables failed to sweep at all.
    const dirs: [number, number, number][] = [[0, 0, 1], [0, 0, -1], [0.3, 0.5, -0.8], [1, 0, 0.2], [1, 0, 0]];
    for (const [i, d] of dirs.entries()) {
      const l = 24.6 / Math.hypot(...d);
      for (const plugged of [false, true]) {
        const f: Feature = {
          id: "cab1",
          op: "cable",
          points: [{ at: [10, 20, 30] }, { at: [10 + d[0] * l, 20 + d[1] * l, 30 + d[2] * l] }],
          diameter: 2.2,
          bendRadius: 6,
          slack: 15,
          ...(plugged ? { start: { kind: "jst_xh", pins: 3 }, end: { kind: "jst_xh", pins: 3 } } : {}),
        } as Feature;
        const t = performance.now();
        const { report, meshes } = s.rebuild(doc([f]));
        ok(report);
        expect(meshes[0]!.indices.length, `direction ${i}`).toBeGreaterThan(0);
        expect(performance.now() - t, `direction ${i}`).toBeLessThan(5000);
        if (!plugged) expect(report.bodies[0]!.volume / (Math.PI * 1.1 ** 2 * 24.6)).toBeCloseTo(1, 3);
      }
    }
    // A cable that winds round in 3D, with 20 mm straight behind each plug.
    const route: [number, number, number][] = [[0, 0, 0], [0, 0, 20], [8, 4, 32], [20, 0, 38], [30, -10, 34], [34, -20, 22], [34, -20, 2]];
    const t = performance.now();
    const curved = s.rebuild(doc([{ id: "cab1", op: "cable", points: route.map((at) => ({ at })), diameter: 2.2, bendRadius: 6, start: { kind: "jst_xh", pins: 3 }, end: { kind: "jst_ph", pins: 2 } }]));
    ok(curved.report);
    expect(curved.meshes[0]!.indices.length).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(5000);
    // Swept along the exact centre line: the volume is the section times the length (plugs aside).
    const bare = s.rebuild(doc([{ id: "cab1", op: "cable", points: route.map((at) => ({ at })), diameter: 2.2, bendRadius: 6 }])).report;
    expect(bare.bodies[0]!.volume / (Math.PI * 1.1 ** 2 * bare.features[0]!.info!["length"]!)).toBeCloseTo(1, 2);
  });

  it("leaves cables out of the gap check between moving parts when asked", async () => {
    const s = await newSession();
    // A cable plugged against a block: touching, which the gap check would work out with a boolean in every pose.
    const { report } = s.rebuild(doc([
      { id: "bx", op: "primitive", shape: "box", size: [20, 20, 20], center: [-10, 0, 0], mode: "new_body" },
      { id: "cab1", op: "cable", points: [{ at: [0, 0, 0] }, { at: [40, 0, 0] }], diameter: 2, start: { kind: "jst_xh", pins: 3 } },
    ] as Feature[]));
    ok(report);
    const oc = await getOcct();
    expect(clearances(oc, s.state!, ["bx"], {}, 2).some((c) => c.b === "cab1" || c.a === "cab1")).toBe(true);
    expect(clearances(oc, s.state!, ["bx"], {}, 2, ["cab1"])).toEqual([]);
  });
});
