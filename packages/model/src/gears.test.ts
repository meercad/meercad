import { describe, expect, it } from "vitest";
import { centerDistance, GEAR_DEFAULTS, gearDims, gearShape, inverseInvolute, involute, meshPlacement, outlineArea, type GearParams } from "./gears.js";

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
