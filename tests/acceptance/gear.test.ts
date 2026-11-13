import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import { GEAR_DEFAULTS, gearShape, outlineArea, type GearParams } from "@meercad/model";
import type { Feature, GearFeature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const gear = (id: string, g: Partial<GearFeature>): GearFeature => ({
  id,
  op: "gear",
  kind: "spur",
  teeth: 20,
  width: 10,
  mode: "new_body",
  ...g,
});
const params = (g: Partial<GearParams>): GearParams => ({
  kind: "spur",
  module: 2,
  teeth: 20,
  herringbone: false,
  ...GEAR_DEFAULTS,
  ...g,
});

/** Volume both bodies share: 0 when they do not overlap. */
const overlap = (r: RebuildReport, id: string) => {
  const f = r.features.find((x) => x.id === id)!;
  if (f.status === "error" && /do not overlap|no solid/.test(f.message ?? "")) return 0;

  return r.bodies.find((b) => b.id.startsWith(id) || b.id === "gr1")!.volume;
};

describe("gear", () => {
  it("builds a spur gear with a bore", async () => {
    const s = await newSession();
    const { report, meshes } = s.rebuild(doc([gear("gr1", { module: 2, bore: { diameter: 8 } })]));
    ok(report);

    const b = report.bodies[0]!;
    const area = outlineArea(gearShape(params({})).outer);
    expect(Math.abs(b.volume / ((area - Math.PI * 16) * 10) - 1)).toBeLessThan(0.005);
    expect(b.bbox.max[0]).toBeCloseTo(22, 2);
    expect(b.bbox.max[2]).toBeCloseTo(10, 6);

    const tags = new Set(meshes[0]!.faceTags.flat());

    for (const t of ["gr1.flank", "gr1.tip", "gr1.root", "gr1.bore", "gr1.start_cap", "gr1.end_cap"]) {
      expect(tags).toContain(t);
    }

    // Parameters are expressions.
    const r2 = s.rebuild(doc([gear("gr1", { module: "m", teeth: "z" })], { m: 1.5, z: 21 })).report;
    ok(r2);
    expect(r2.bodies[0]!.bbox.max[0]).toBeCloseTo((1.5 * 21) / 2 + 1.5, 2);
  });

  it("meshes a pair without the teeth touching, in any position", async () => {
    const s = await newSession();

    for (const turn of [0, 3, 7.5, 12]) {
      const features: Feature[] = [
        gear("gr1", { module: 1.5, teeth: 15, width: 8, rotation: turn }),
        gear("gr2", { teeth: 30, width: 8, meshWith: { gear: "gr1", direction: 30 } }),
        { id: "bo1", op: "boolean", operation: "intersect", target: "gr1", tools: ["gr2"], keepTools: true },
      ];
      const { report } = s.rebuild(doc(features));
      ok({ ...report, features: report.features.filter((f) => f.id !== "bo1") });
      expect(overlap(report, "bo1")).toBeLessThan(1e-3);

      if (turn === 0) {
        // The partner sits at the centre distance, 30° round.
        const g2 = s.rebuild(doc(features.slice(0, 2))).report.bodies.find((b) => b.id === "gr2")!;
        const cx = (g2.bbox.min[0] + g2.bbox.max[0]) / 2;
        const cy = (g2.bbox.min[1] + g2.bbox.max[1]) / 2;
        expect(Math.hypot(cx, cy)).toBeCloseTo(33.75, 1);
        expect((Math.atan2(cy, cx) * 180) / Math.PI).toBeCloseTo(30, 0);
      }
    }
  });

  it("builds helical and herringbone gears that mesh", async () => {
    const s = await newSession();

    for (const herringbone of [false, true]) {
      const pair: Feature[] = [
        gear("gr1", { module: 2, teeth: 20, width: 12, helix: 30, herringbone }),
        gear("gr2", { teeth: 13, width: 12, meshWith: { gear: "gr1" } }),
      ];
      const built = s.rebuild(doc(pair)).report;
      ok(built);

      const report = s.rebuild(
        doc([
          ...pair,
          {
            id: "bo1",
            op: "boolean",
            operation: "intersect",
            target: "gr1",
            tools: ["gr2"],
            keepTools: true,
          },
        ]),
      ).report;
      const g1 = built.bodies.find((b) => b.id === "gr1")!;
      // The helix keeps every cross-section's area: same volume as a straight gear of module mt.
      const area = outlineArea(gearShape(params({ module: 2, helix: 30, teeth: 20 })).outer);
      expect(Math.abs(g1.volume / (area * 12) - 1)).toBeLessThan(0.005);
      expect(g1.bbox.max[2]).toBeCloseTo(12, 4);
      expect(overlap(report, "bo1")).toBeLessThan(1e-3);
    }
  });

  it("puts planets into a ring gear and a pinion onto a rack", async () => {
    const s = await newSession();
    const ring = s.rebuild(
      doc([
        gear("gr1", { kind: "internal", module: 1, teeth: 60, width: 6, rim: 70 }),
        gear("gr2", { teeth: 18, width: 6, meshWith: { gear: "gr1", direction: 0 } }),
        gear("gr3", { teeth: 24, width: 6, meshWith: { gear: "gr2", direction: 180 } }),
        { id: "bo1", op: "boolean", operation: "intersect", target: "gr1", tools: ["gr2"], keepTools: true },
        { id: "bo2", op: "boolean", operation: "intersect", target: "gr2", tools: ["gr3"], keepTools: true },
      ]),
    ).report;
    ok({ ...ring, features: ring.features.filter((f) => !f.id.startsWith("bo")) });
    expect(overlap(ring, "bo1")).toBeLessThan(1e-3);
    expect(overlap(ring, "bo2")).toBeLessThan(1e-3);

    // The sun sits in the middle of the ring.
    const sun = ring.bodies.find((b) => b.id === "gr3")!;
    expect((sun.bbox.min[0] + sun.bbox.max[0]) / 2).toBeCloseTo(0, 1);

    const r1 = ring.bodies.find((b) => b.id === "gr1")!;
    expect(r1.bbox.max[0]).toBeCloseTo(35, 3);

    const rack = s.rebuild(
      doc([
        gear("gr1", { kind: "rack", module: 1.5, teeth: 20, width: 8, rim: 6 }),
        gear("gr2", { teeth: 16, width: 8, meshWith: { gear: "gr1" } }),
        { id: "bo1", op: "boolean", operation: "intersect", target: "gr1", tools: ["gr2"], keepTools: true },
      ]),
    ).report;
    ok({ ...rack, features: rack.features.filter((f) => f.id !== "bo1") });

    const bar = rack.bodies.find((b) => b.id === "gr1")!;
    expect(bar.bbox.max[0] - bar.bbox.min[0]).toBeCloseTo(20 * Math.PI * 1.5, 2);
    expect(bar.bbox.max[1] - bar.bbox.min[1]).toBeCloseTo(6 + 2.25 * 1.5, 3);

    const pinion = rack.bodies.find((b) => b.id === "gr2")!;
    expect((pinion.bbox.min[1] + pinion.bbox.max[1]) / 2).toBeCloseTo(12, 1);
    expect(overlap(rack, "bo1")).toBeLessThan(1e-3);
  });

  it("chamfers the tooth tips at both ends", async () => {
    const s = await newSession();

    for (const g of [
      {},
      { helix: 25, herringbone: true },
      { kind: "internal" as const, rim: 100, teeth: 40 },
    ]) {
      const plain = s.rebuild(doc([gear("gr1", { module: 2, width: 10, ...g })])).report;
      const { report, meshes } = s.rebuild(doc([gear("gr1", { module: 2, width: 10, chamfer: 0.6, ...g })]));
      ok(report);

      const removed = plain.bodies[0]!.volume - report.bodies[0]!.volume;
      expect(removed).toBeGreaterThan(0);
      // At most the tip ring that a 0.6 mm 45° chamfer can reach, at both ends.
      expect(removed).toBeLessThan(2 * Math.PI * 2 * 45 * 0.6 * 0.6);
      expect(meshes[0]!.faceTags.flat()).toContain("gr1.chamfer");
      expect(report.bodies[0]!.bbox.max[2]).toBeCloseTo(10, 6);
    }

    const bad = s.rebuild(doc([gear("gr1", { module: 1, width: 10, chamfer: 2 })])).report;
    expect(bad.features[0]!.message).toMatch(/at most the module/);
  });

  it("cuts teeth into a part and explains bad input", async () => {
    const s = await newSession();
    const cut = s.rebuild(
      doc([
        sketch("sk1", { ref: "origin.XY" }, rect("l", -30, -30, 60, 60)),
        {
          id: "ex1",
          op: "extrude",
          profile: { sketch: "sk1" },
          extent: "blind",
          distance: 10,
          mode: "new_body",
        },
        gear("gr1", { module: 2, teeth: 12, width: 10, mode: "cut" }),
      ]),
    ).report;
    ok(cut);
    expect(cut.bodies).toHaveLength(1);
    expect(cut.bodies[0]!.volume).toBeLessThan(36000);

    const bad = s.rebuild(doc([gear("gr1", { module: 2, teeth: 20, bore: { diameter: 40 } })])).report;
    expect(bad.features[0]!.message).toMatch(/bore must be smaller/);

    const small = s.rebuild(doc([gear("gr1", { module: 2, teeth: 10 })])).report;
    expect(small.features[0]!.status).not.toBe("error");
  });
});
