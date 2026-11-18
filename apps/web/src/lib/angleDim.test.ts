/**
 * The arc of an angle between two sketch lines (angleDim.ts): where the lines meet, which corner the
 * arc spans, its value and label, and the lines that draw it.
 */
import { describe, expect, it } from "vitest";
import { angleArc, angleArcLines, lineCorner, type Segment } from "./angleDim";

const seg = (a: [number, number], b: [number, number]): Segment => ({ a, b });
const along = seg([0, 0], [40, 0]);
const up45 = seg([0, 0], [20, 20]);

describe("where two lines meet", () => {
  it("is their crossing, also beyond their ends; parallel ones meet nowhere", () => {
    expect(lineCorner(along, up45)).toEqual([0, 0]);

    const corner = lineCorner(seg([10, 0], [20, 0]), seg([0, 5], [0, 10]))!;
    expect(corner[0]).toBeCloseTo(0, 9);
    expect(corner[1]).toBeCloseTo(0, 9);
    expect(lineCorner(along, seg([0, 5], [40, 5]))).toBeNull();
    expect(lineCorner(along, seg([3, 3], [3, 3]))).toBeNull();
  });
});

describe("the arc of an angle", () => {
  it("spans the corner the lines lie in, with its value half way round", () => {
    const arc = angleArc(along, up45)!;
    expect(arc.degrees).toBeCloseTo(45, 9);
    expect(arc.radius).toBeCloseTo(Math.hypot(20, 20) * 0.35, 9);
    expect(Math.atan2(arc.label[1], arc.label[0])).toBeCloseTo(Math.PI / 8, 9);
  });

  it("spans the corner its label was put in, at the label's distance", () => {
    const arc = angleArc(along, up45, [-10, 3])!;
    expect(arc.degrees).toBeCloseTo(135, 9);
    expect(arc.radius).toBeCloseTo(Math.hypot(10, 3), 9);

    const below = angleArc(along, up45, [0, -10])!;
    expect(below.degrees).toBeCloseTo(135, 9);
    expect(below.label[1]).toBeLessThan(0);
  });

  it("without a label, takes the corner nearest the angle it should show", () => {
    expect(angleArc(along, up45, null, 130)!.degrees).toBeCloseTo(135, 9);
    expect(angleArc(along, up45, null, 50)!.degrees).toBeCloseTo(45, 9);
    expect(angleArc(along, seg([0, 0], [0, 30]), null, 90)!.degrees).toBeCloseTo(90, 9);
  });

  it("goes counter-clockwise, whichever order the lines come in or way they were drawn", () => {
    const arc = angleArc(up45, seg([40, 0], [0, 0]))!;
    expect(arc.to).toBeGreaterThan(arc.from);
    expect(arc.degrees).toBeCloseTo(45, 9);
  });

  it("is none for parallel lines", () => {
    expect(angleArc(along, seg([0, 5], [40, 5]))).toBeNull();
  });
});

describe("drawing the arc", () => {
  it("is the arc in short pieces, plus a ray to where a line does not reach", () => {
    const short = seg([0, 0], [2, 0]);
    const arc = angleArc(short, up45, [5, 1])!;
    const lines = angleArcLines(arc, short, up45);
    const pieces = lines.filter((x) => Math.hypot(...x.a) > 0.1);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    for (const piece of pieces) expect(Math.hypot(...piece.a)).toBeCloseTo(arc.radius, 9);

    // The short line ends before the arc: a ray from the corner shows the side; the long one needs none.
    const rays = lines.filter((x) => x.a[0] === 0 && x.a[1] === 0);
    expect(rays).toHaveLength(1);
  });
});

describe("an angle's arc with its value placed elsewhere", () => {
  it("keeps showing the angle it measures, in the matching corner nearest the value", () => {
    // 45° wanted, value put below the lines: the arc stays a 45° one, the corner opposite.
    const arc = angleArc(along, up45, [-5, -10], 45)!;
    expect(arc.degrees).toBeCloseTo(45, 9);
    expect(arc.label[0]).toBeLessThan(0);
    expect(arc.label[1]).toBeLessThan(0);

    // Just below the lower line: the 45° corner above it is nearer than the one opposite.
    expect(angleArc(along, up45, [10, -3], 45)!.label[1]).toBeGreaterThan(0);
    // Put inside the corner it shows: that corner.
    expect(angleArc(along, up45, [10, 3], 45)!.label[1]).toBeGreaterThan(0);
    // An angle the lines do not make (being solved): the corner the value lies in.
    expect(angleArc(along, up45, [-10, 3], 70)!.degrees).toBeCloseTo(135, 9);
  });
});
