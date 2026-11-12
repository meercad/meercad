import { describe, expect, it } from "vitest";
import { centerDistance, GEAR_DEFAULTS, gearDims, gearShape, helixTwist, inverseInvolute, involute, meshHelix, meshPlacement, outlineArea, type GearParams } from "./gears.js";

const spur = (teeth: number, module = 2, extra: Partial<GearParams> = {}): GearParams => ({ kind: "spur", module, teeth, herringbone: false, ...GEAR_DEFAULTS, ...extra });

describe("gears", () => {
  it("sizes a spur gear", () => {
    const d = gearDims(spur(20));
    expect(d.d).toBeCloseTo(40, 9);
    expect(d.da).toBeCloseTo(44, 9);
    expect(d.df).toBeCloseTo(35, 9);
    expect(d.span!.k).toBe(3);
    expect(d.span!.w).toBeCloseTo(15.321 - 0.075 * Math.cos(Math.PI / 9), 3);
    expect(d.warnings).toEqual([]);
    expect(gearDims(spur(10)).warnings[0]).toMatch(/undercut/);
  });

  it("inverts the involute", () => {
    expect(inverseInvolute(involute(0.4))).toBeCloseTo(0.4, 12);
  });

  it("finds centre distances", () => {
    expect(centerDistance(spur(15, 1.5), spur(30, 1.5))).toBeCloseTo(33.75, 9);
    expect(centerDistance({ ...spur(60, 1), kind: "internal" }, spur(18, 1))).toBeCloseTo(21, 9);
    expect(centerDistance(spur(18, 1), { ...spur(60, 1), kind: "internal" })).toBeCloseTo(21, 9);
    // Positive profile shifts push the gears apart.
    expect(centerDistance(spur(12, 1, { profileShift: 0.3 }), spur(30, 1))).toBeGreaterThan(21);
  });

  it("outlines teeth of the right thickness", () => {
    const shape = gearShape(spur(20, 2, { backlash: 0 }));
    expect(shape.outer).toHaveLength(20 * 6);
    const area = outlineArea(shape.outer);
    expect(area).toBeGreaterThan((Math.PI * 35 ** 2) / 4);
    expect(area).toBeLessThan((Math.PI * 44 ** 2) / 4);
    // Every point lies between the root and tip circles.
    for (const s of shape.outer) for (const [u, v] of s.pts) expect(Math.hypot(u, v)).toBeGreaterThan(17.5 - 1e-9), expect(Math.hypot(u, v)).toBeLessThan(22 + 1e-9);
    const rack = gearShape({ ...spur(10), kind: "rack" });
    expect(outlineArea(rack.outer)).toBeGreaterThan(0);
  });

  it("puts a tooth into a gap", () => {
    const a = { params: spur(15, 1.5), center: [0, 0] as [number, number], rotation: 0, width: 8 };
    const b = meshPlacement(a, spur(30, 1.5), 0);
    expect(b.center[0]).toBeCloseTo(33.75, 9);
    // The gear on the right faces gear 1's tooth (at 0°) with a gap: half a tooth from pointing back.
    expect(((b.rotation - Math.PI - Math.PI / 30) / ((2 * Math.PI) / 30)) % 1).toBeCloseTo(0, 9);
  });
});

describe("gears by the standard (DIN 867 / DIN 3960)", () => {
  const ring = (teeth: number, module = 2) => spur(teeth, module, { kind: "internal" });
  const rack = (teeth: number, module = 2, extra: Partial<GearParams> = {}) => spur(teeth, module, { kind: "rack", ...extra });

  it("a ring gear: tips inside the pitch circle, roots outside; centre distance to its pinion", () => {
    const d = gearDims(ring(60));
    expect(d.d).toBeCloseTo(120, 9);
    expect(d.da).toBeCloseTo(116, 9);
    expect(d.df).toBeCloseTo(125, 9);
    expect(centerDistance(ring(60), spur(20))).toBeCloseTo(40, 9);
    expect(gearDims(ring(20)).warnings[0]).toMatch(/below the base circle/);
  });

  it("helical: transverse module m / cos β, and the mate turns the other way", () => {
    const h = spur(20, 2, { helix: 30 });
    expect(gearDims(h).d).toBeCloseTo(40 / Math.cos(Math.PI / 6), 9);
    expect(meshHelix(h, "spur")).toBe(-30);
    expect(meshHelix(ring(60), "spur")).toBe(0);
    // Over 10 mm of width the section turns tan β · 10 / r.
    expect(helixTwist(h, 10, 10)).toBeCloseTo((Math.tan(Math.PI / 6) * 10) / (gearDims(h).d / 2), 9);
    expect(helixTwist({ ...h, herringbone: true }, 10, 10)).toBeCloseTo(0, 9);
    expect(helixTwist(rack(10, 2, { helix: 30 }), 10, 4)).toBeCloseTo(Math.tan(Math.PI / 6) * 4, 9);
    expect(helixTwist(spur(20), 10, 10)).toBe(0);
  });

  it("warns or refuses teeth that cannot be made", () => {
    expect(gearDims(spur(4, 2, { clearance: 2 })).warnings.join()).toMatch(/root circle is smaller than zero/);
    expect(() => gearShape(spur(12, 2, { profileShift: 1.2 }))).toThrow(/come to a point/);
    expect(() => gearShape(ring(60), { rim: 125 })).toThrow(/outside diameter above 125.00 mm/);
    expect(() => gearShape(rack(10, 2, { pressureAngle: 35, backlash: 3 }))).toThrow(/rack's teeth come to a point/);
  });

  it("a rack: trapezoid teeth one pitch apart, length teeth × π m", () => {
    const shape = gearShape(rack(10));
    const xs = shape.outer.flatMap((s) => s.pts.map((p) => p[0]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10 * 2 * Math.PI, 9);
    expect(shape.outer.filter((s) => s.part === "tip")).toHaveLength(10);
  });

  it("refuses pairs that cannot mesh, and places a gear on a rack and a rack on a gear", () => {
    const at = (params: GearParams) => ({ params, center: [0, 0] as [number, number], rotation: 0, width: 5 });
    expect(() => meshPlacement(at(rack(10)), rack(10), 0)).toThrow(/two racks/);
    expect(() => meshPlacement(at(ring(60)), ring(40), 0)).toThrow(/two ring gears/);
    expect(() => meshPlacement(at(ring(60)), rack(10), 0)).toThrow(/rack cannot mesh with a ring/);
    expect(() => meshPlacement(at(rack(10)), ring(60), 0)).toThrow(/ring gear cannot mesh with a rack/);
    // A pinion on a rack sits one pitch radius above its pitch line.
    expect(meshPlacement(at(rack(11)), spur(20), 0).center.map((v) => +v.toFixed(9))).toEqual([0, 20]);
    // A rack on a pinion lies one pitch radius out, along the direction.
    const r = meshPlacement(at(spur(20)), rack(10), 0);
    expect(r.center[0]).toBeCloseTo(20, 9);
    expect(Math.abs(r.center[1])).toBeLessThanOrEqual(Math.PI);
    // A ring around a pinion: centre distance (60 − 20) · 2 / 2 = 40.
    const around = meshPlacement(at(spur(20)), ring(60), 0);
    expect(around.center[0]).toBeCloseTo(40, 9);
  });
});
