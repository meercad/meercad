/**
 * Closed regions of a sketch, by area worked out by hand: overlapping and touching circles, arcs
 * meeting circles, concave outlines, and what makes no region at all.
 */
import { describe, expect, it } from "vitest";
import { findRegions, intersectionPoints, pointInPolygon, regionAt, type SolvedCurve } from "./index.js";

const PI = Math.PI;
const line = (id: string, a: [number, number], b: [number, number], construction = false): SolvedCurve => ({ id, kind: "line", a, b, p1: "", p2: "", construction, external: false });
const circle = (id: string, center: [number, number], radius: number): SolvedCurve => ({ id, kind: "circle", center, radius, c: "", construction: false, external: false });
const arc = (id: string, center: [number, number], radius: number, a0: number, a1: number): SolvedCurve => ({ id, kind: "arc", center, radius, a0, a1, c: "", start: "", end: "", construction: false, external: false });
const areas = (cs: SolvedCurve[]) => findRegions(cs).map((r) => +r.area.toFixed(3)).sort((a, b) => a - b);
/** Polygon areas sag inside the arcs: to 0.5 % here. */
const near = (got: number, want: number) => expect(Math.abs(got - want) / want, `${got} vs ${want}`).toBeLessThan(5e-3);

describe("regions", () => {
  it("nothing closed, or only construction lines, makes no region", () => {
    expect(findRegions([])).toEqual([]);
    expect(findRegions([line("l1", [0, 0], [10, 0], true), line("l2", [10, 0], [10, 10], true), line("l3", [10, 10], [0, 0], true)])).toEqual([]);
    expect(findRegions([line("l1", [0, 0], [10, 0]), line("l2", [10, 0], [10, 10])])).toEqual([]);
  });

  it("two overlapping circles: two crescents and the lens between them", () => {
    const r = 5, d = 6;
    const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
    const got = areas([circle("k1", [0, 0], r), circle("k2", [d, 0], r)]);
    expect(got).toHaveLength(3);
    near(got[0]!, lens);
    near(got[1]!, PI * r * r - lens);
    near(got[2]!, PI * r * r - lens);
  });

  it("two circles touching at one point stay two whole circles", () => {
    const got = areas([circle("k1", [0, 0], 5), circle("k2", [10, 0], 5)]);
    expect(got).toHaveLength(2);
    got.forEach((a) => near(a, 25 * PI));
  });

  it("a half-circle arc closed by a line across a circle", () => {
    // A D shape (half disc r = 10) and a circle r = 3 inside it: the D with a hole, and the circle.
    const got = findRegions([arc("a", [0, 0], 10, 0, PI), line("l", [-10, 0], [10, 0]), circle("k", [0, 4], 3)]);
    const d = got.find((x) => x.holes.length === 1)!;
    near(d.area, 50 * PI - 9 * PI);
    expect(got.find((x) => x.holes.length === 0)!.area).toBeCloseTo(9 * PI, 0);
  });

  it("an arc cutting a circle twice splits it", () => {
    const pts = intersectionPoints(circle("k", [0, 0], 5), arc("a", [6, 0], 5, PI / 2, (3 * PI) / 2));
    expect(pts).toHaveLength(2);
    for (const p of pts) {
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(5, 9);
      expect(Math.hypot(p[0] - 6, p[1])).toBeCloseTo(5, 9);
    }
    // An arc on the far side misses.
    expect(intersectionPoints(circle("k", [0, 0], 5), arc("a", [6, 0], 5, -PI / 4, PI / 4))).toHaveLength(0);
    // Circles apart, nested or concentric never meet.
    expect(intersectionPoints(circle("k", [0, 0], 5), circle("m", [20, 0], 5))).toEqual([]);
    expect(intersectionPoints(circle("k", [0, 0], 5), circle("m", [1, 0], 1))).toEqual([]);
    expect(intersectionPoints(circle("k", [0, 0], 5), circle("m", [0, 0], 5))).toEqual([]);
  });

  it("a concave outline: the sample point lies inside, and a tap finds the smallest region there", () => {
    // A U shape: 30 wide, 20 high, with a 10 × 15 notch from the top.
    const u: [number, number][] = [[0, 0], [30, 0], [30, 20], [20, 20], [20, 5], [10, 5], [10, 20], [0, 20]];
    const cs = u.map((p, i) => line(`l${i}`, p, u[(i + 1) % u.length]!));
    const regions = findRegions([...cs, circle("h", [5, 10], 2)]);
    const outer = regions.find((r) => r.holes.length)!;
    expect(outer.area).toBeCloseTo(30 * 20 - 10 * 15 - 4 * PI, 1);
    expect(pointInPolygon(outer.sample, outer.polygons[0]!)).toBe(true);
    expect(regionAt(regions, [5, 10])!.area).toBeCloseTo(4 * PI, 0);
    expect(regionAt(regions, [25, 10])).toBe(outer);
    expect(regionAt(regions, [15, 15])).toBeUndefined();
  });
});
