/**
 * Drawings read from SVG (io.ts readSvg) keep their true sizes: units from width and viewBox,
 * rounded rectangles, ellipses, and the path commands: elliptical arcs on their circle, smooth
 * curves that mirror the control point before them, and lines after a closed outline. A drawing
 * imported as a sketch has the area it was drawn with.
 */
import { describe, expect, it } from "vitest";
import type { Curve2 } from "@meercad/io";
import { arcPoints, curvesToSketch, readDesignFile, readSvg } from "./io";

/** An SVG in millimetres: one unit is 1 mm. */
const mm = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">${body}</svg>`;
const ends = (cs: Curve2[]) => cs.map((c) => (c.kind === "line" ? c.a : [NaN, NaN]));
/** The area enclosed by a run of lines, in order. */
const area = (cs: Curve2[]) => {
  const p = ends(cs);
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]!;
    const [x1, y1] = p[(i + 1) % p.length]!;
    a += x0! * y1! - x1! * y0!;
  }
  return Math.abs(a / 2);
};
const allLines = (cs: Curve2[]) => cs.every((c) => c.kind === "line");

describe("SVG sizes", () => {
  it("reads millimetres, centimetres, inches and pixels", () => {
    expect(readSvg(mm(`<line x1="0" y1="0" x2="40" y2="0"/>`))).toEqual([{ kind: "line", a: [0, -0], b: [40, -0] }]);
    const cm = readSvg(`<svg width="10cm" viewBox="0 0 10 10"><line x1="0" y1="0" x2="4" y2="0"/></svg>`)[0] as { b: [number, number] };
    expect(cm.b[0]).toBeCloseTo(40, 9);
    const inch = readSvg(`<svg width="1in" viewBox="0 0 1 1"><line x1="0" y1="0" x2="1" y2="0"/></svg>`)[0] as { b: [number, number] };
    expect(inch.b[0]).toBeCloseTo(25.4, 9);
    // No size given: CSS pixels, 96 to the inch.
    const px = readSvg(`<svg><line x1="0" y1="0" x2="96" y2="0"/></svg>`)[0] as { b: [number, number] };
    expect(px.b[0]).toBeCloseTo(25.4, 9);
    expect(readSvg("<html/>")).toEqual([]);
  });

  it("turns y downwards into y upwards", () => {
    const [l] = readSvg(mm(`<line x1="0" y1="0" x2="0" y2="10"/>`)) as unknown as [{ b: [number, number] }];
    expect(l.b[1]).toBe(-10);
  });

  it("reads rectangles, circles, polygons and polylines at their size", () => {
    expect(area(readSvg(mm(`<rect x="5" y="5" width="40" height="20"/>`)))).toBeCloseTo(800, 9);
    expect(readSvg(mm(`<circle cx="10" cy="10" r="6"/>`))).toEqual([{ kind: "circle", center: [10, -10], radius: 6 }]);
    expect(area(readSvg(mm(`<polygon points="0,0 30,0 0,40"/>`)))).toBeCloseTo(600, 9);
    expect(readSvg(mm(`<polyline points="0 0 10 0 10 10"/>`))).toHaveLength(2);
  });

  it("rounds a rectangle's corners: 40 × 20 with 5 mm corners is 800 − (4 − π)·25 mm²", () => {
    const cs = readSvg(mm(`<rect x="0" y="0" width="40" height="20" rx="5"/>`));
    expect(allLines(cs)).toBe(true);
    // The corners are fine polylines: within 0.15 mm² of the true curve.
    expect(Math.abs(area(cs) - (800 - (4 - Math.PI) * 25))).toBeLessThan(0.15);
    // ry alone stands for both; each radius stops at half its side, as SVG says: rx 50 on 40 × 20 is a 40 × 20 ellipse (its 64 chords stay within 0.03 mm of it, 1 mm² of 628).
    expect(Math.abs(area(readSvg(mm(`<rect width="40" height="20" ry="5"/>`))) - (800 - (4 - Math.PI) * 25))).toBeLessThan(0.15);
    expect(Math.abs(area(readSvg(mm(`<rect width="40" height="20" rx="50"/>`))) - Math.PI * 200)).toBeLessThan(1.2);
  });

  it("reads ellipses: a circle stays a circle, others are fine polylines of their area", () => {
    expect(readSvg(mm(`<ellipse cx="5" cy="5" rx="3" ry="3"/>`))).toEqual([{ kind: "circle", center: [5, -5], radius: 3 }]);
    const e = readSvg(mm(`<ellipse cx="50" cy="50" rx="20" ry="10"/>`));
    expect(Math.abs(area(e) - Math.PI * 200)).toBeLessThan(0.5);
  });
});

describe("SVG paths", () => {
  const pointsOf = (d: string) => {
    const cs = readSvg(mm(`<path d="${d}"/>`));
    return cs.flatMap((c) => (c.kind === "line" ? [c.a, c.b] : []));
  };

  it("draws an elliptical arc on its circle and on the side the sweep flag says", () => {
    // From (0,0) to (20,0) round (10,0), sweep 1: over the top on screen, so up in the sketch.
    const pts = pointsOf("M 0 0 A 10 10 0 0 1 20 0");
    for (const [x, y] of pts) expect(Math.hypot(x! - 10, y!)).toBeCloseTo(10, 9);
    expect(Math.max(...pts.map((p) => p[1]!))).toBeCloseTo(10, 2);
    const other = pointsOf("M 0 0 A 10 10 0 0 0 20 0");
    expect(Math.min(...other.map((p) => p[1]!))).toBeCloseTo(-10, 2);
  });

  it("takes the large arc when asked and scales radii too small to reach", () => {
    // Three quarters of a circle of 10 round (10, 0)... and its small quarter.
    const big = pointsOf("M 0 0 a 10 10 0 1 0 10 10");
    const small = pointsOf("M 0 0 a 10 10 0 0 0 10 10");
    expect(big.length).toBeGreaterThan(small.length * 2);
    // Radius 1 cannot span 20 mm: it becomes 10, a half circle.
    for (const [x, y] of pointsOf("M 0 0 A 1 1 0 0 1 20 0")) expect(Math.hypot(x! - 10, y!)).toBeCloseTo(10, 9);
    // A tilted ellipse keeps both ends where the path says.
    const tilted = arcPoints([0, 0], [30, 10], 20, 8, 30, false, true);
    expect(tilted.at(-1)).toEqual([30, 10]);
    // No radius: a straight line; no distance: nothing more.
    expect(arcPoints([0, 0], [5, 5], 0, 3, 0, false, false)).toEqual([[5, 5]]);
    expect(arcPoints([1, 1], [1, 1], 3, 3, 0, false, false)).toEqual([[1, 1]]);
  });

  it("mirrors the previous control point for smooth curves (S and T)", () => {
    // The second half of an S: its middle mirrors the first half's, at (15, 7.5) flipped.
    const s = pointsOf("M 0 0 C 0 10 10 10 10 0 S 20 -10 20 0");
    expect(s.some(([x, y]) => Math.abs(x! - 15) < 1e-9 && Math.abs(y! - 7.5) < 1e-9)).toBe(true);
    const t = pointsOf("M 0 0 Q 5 10 10 0 T 20 0");
    expect(t.some(([x, y]) => Math.abs(x! - 15) < 1e-9 && Math.abs(y! - 5) < 1e-9)).toBe(true);
    // An S or T with no curve before it uses the current point as its control.
    const lone = pointsOf("M 0 0 T 10 0");
    for (const [, y] of lone) expect(y).toBeCloseTo(0, 12);
  });

  it("draws relative and absolute lines, and goes on from the start after Z", () => {
    const sq = readSvg(mm(`<path d="M 0 0 h 10 v 10 H 0 V 0 Z"/>`));
    expect(area(sq)).toBeCloseTo(100, 9);
    // After Z a line starts where the outline began.
    const after = pointsOf("M 5 5 l 10 0 l 0 10 z l -5 0");
    expect(after.slice(-2)).toEqual([[5, -5], [0, -5]]);
  });
});

describe("drawings as sketches", () => {
  it("shares the points where curves meet, and skips lines of no length", () => {
    const sk = curvesToSketch([
      { kind: "line", a: [0, 0], b: [10, 0] },
      { kind: "line", a: [10, 0], b: [10, 0] },
      { kind: "line", a: [10, 0], b: [0, 0] },
      { kind: "circle", center: [0, 0], radius: 2 },
      { kind: "arc", center: [0, 0], radius: 10, a0: 0, a1: Math.PI / 2 },
    ]);
    expect(sk.entities.filter((e) => e.type === "line")).toHaveLength(2);
    // Two line ends, the circle's own centre, the arc's end at (0, 10) and its own centre.
    expect(sk.entities.filter((e) => e.type === "point")).toHaveLength(5);
  });

  it("reads a design file, a wrapped one, and says what is wrong with others", () => {
    const doc = { format: "meercad/1", features: [] };
    expect(readDesignFile(JSON.stringify(doc)).doc.features).toEqual([]);
    expect(readDesignFile(JSON.stringify({ name: "Box", document: doc })).name).toBe("Box");
    expect(() => readDesignFile("{")).toThrow(/Not a valid meerCAD file/);
    expect(() => readDesignFile(JSON.stringify({ format: "meercad/1", features: [{ op: "nope" }] }))).toThrow(/Not a valid meerCAD file/);
  });
});
