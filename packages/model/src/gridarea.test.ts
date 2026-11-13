import { describe, expect, it } from "vitest";
import { areaPlan, GridfinityError, pieceName, splitLine, type Poly2 } from "./gridfinity.js";

const P = 42;
const widths = (cuts: number[]) => cuts.slice(1).map((c, i) => +(c - cuts[i]!).toFixed(6));

describe("splitLine", () => {
  it("keeps a stretch that fits whole", () => {
    expect(splitLine(0, 300, 0, 320)).toEqual([0, 300]);
  });
  it("cuts only between cells, into as few and as even pieces as fit", () => {
    // 2982 mm of cells (71) plus 9 mm border on each side, for a 340 mm bed: at most 8 cells
    // (336 mm) a piece, 7 at the ends with their border (303 mm), so 10 pieces.
    const cuts = splitLine(-1500, 1500, -1491, 340)!;
    expect(cuts).toHaveLength(11);
    for (const w of widths(cuts)) expect(w).toBeLessThanOrEqual(340);
    for (const c of cuts.slice(1, -1)) expect(Math.abs(((c + 1491) / P) % 1)).toBeLessThan(1e-9);
    expect(Math.max(...widths(cuts)) - Math.min(...widths(cuts))).toBeLessThanOrEqual(P + 9);
  });
  it("gives up when the bed is narrower than a cell and its border", () => {
    expect(splitLine(0, 200, 20, 40)).toBeNull();
  });
});

describe("areaPlan", () => {
  it("fills a 3 m × 1.5 m area centred, cut for a Bambu H2S", () => {
    const plan = areaPlan({ rect: [2999, 1499] }, [340, 320]);
    expect(plan.units).toEqual([71, 35]);
    expect(plan.cells).toHaveLength(71 * 35);
    expect(plan.origin[0]).toBeCloseTo(-71 * 21, 9);

    const [xs, ys] = plan.cuts;
    const bed = plan.turned ? [320, 340] : [340, 320];
    for (const w of widths(xs)) expect(w).toBeLessThanOrEqual(bed[0]! + 1e-9);
    for (const d of widths(ys)) expect(d).toBeLessThanOrEqual(bed[1]! + 1e-9);
    expect(xs[0]).toBeCloseTo(-1499.5, 9);
    expect(xs.at(-1)).toBeCloseTo(1499.5, 9);
    // 10 columns (see above) and 5 rows of 7 cells (the ends 308.5 mm with their border).
    expect((xs.length - 1) * (ys.length - 1)).toBe(50);
  });
  it("takes a margin off the bed (2 cm at the back) and needs more pieces", () => {
    const full = areaPlan({ rect: [2999, 1499] }, [360, 360]);
    const less = areaPlan({ rect: [2999, 1499] }, [360, 340]);
    const n = (p: typeof full) => (p.cuts[0].length - 1) * (p.cuts[1].length - 1);
    expect(n(less)).toBeGreaterThanOrEqual(n(full));
    for (const d of widths(less.cuts[less.turned ? 0 : 1])) expect(d).toBeLessThanOrEqual(340 + 1e-9);
  });
  it("turns the pieces when that needs fewer", () => {
    // 6 × 1 cells on a 260 × 100 bed fit lying along x, 2 pieces; a 100 × 260 bed is the same bed turned.
    const plan = areaPlan({ rect: [252, 42] }, [100, 260]);
    expect(plan.turned).toBe(true);
    expect(plan.cuts[0]).toHaveLength(2);
  });
  it("fills an L-shaped outline with whole cells only, a gap from its edge", () => {
    // 300 × 200 with the top-right 150 × 100 missing.
    const L: Poly2 = [
      [0, 0],
      [300, 0],
      [300, 100],
      [150, 100],
      [150, 200],
      [0, 200],
    ];
    const plan = areaPlan({ loops: [L], gap: 0.5 });
    const inside = (x: number, y: number) =>
      x >= 0.5 - 1e-9 &&
      y >= 0.5 - 1e-9 &&
      ((x <= 299.5 + 1e-9 && y <= 99.5 + 1e-9) || (x <= 149.5 + 1e-9 && y <= 199.5 + 1e-9));

    for (const [i, j] of plan.cells) {
      const x = plan.origin[0] + i * P,
        y = plan.origin[1] + j * P;

      for (const [cx, cy] of [
        [x, y],
        [x + P, y],
        [x, y + P],
        [x + P, y + P],
      ]) {
        expect(inside(cx!, cy!)).toBe(true);
      }
    }

    // Lined up with the outline's corner, 7 cells fit along the bottom and 2 rows; 3 more in the upright.
    expect(plan.cells.length).toBe(7 * 2 + 3 * 2);
  });
  it("leaves out a hole in the outline", () => {
    const outer: Poly2 = [
      [0, 0],
      [210, 0],
      [210, 210],
      [0, 210],
    ];
    const hole: Poly2 = [
      [90, 90],
      [90, 120],
      [120, 120],
      [120, 90],
    ];
    const plan = areaPlan({ loops: [outer, hole], gap: 0 });
    expect(plan.cells).toHaveLength(24);
  });
  it("without the border measures the pieces from the grid's edge", () => {
    const plan = areaPlan({ rect: [499, 299] }, [256, 256], false);
    expect(plan.min).toEqual([-231, -147]);
    expect(plan.max).toEqual([231, 147]);
    // 11 cells: 6 + 5 fit two pieces once the 18.5 mm borders are gone (three with them).
    expect(plan.cuts[0]).toHaveLength(3);
    expect(areaPlan({ rect: [499, 299] }, [256, 256]).cuts[0]).toHaveLength(4);
  });
  it("says when nothing fits", () => {
    expect(() => areaPlan({ rect: [30, 300] })).toThrow(GridfinityError);
    expect(() => areaPlan({ rect: [400, 400] }, [30, 30])).toThrow(GridfinityError);
  });
});

describe("pieces", () => {
  it("names pieces by row letter and column number", () => {
    expect(pieceName(0, 0)).toBe("A1");
    expect(pieceName(2, 1)).toBe("B3");
    expect(pieceName(0, 26)).toBe("AA1");
  });
});
