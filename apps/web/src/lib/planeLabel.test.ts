/**
 * A dimension's text laid into its plane with a true perspective (planeLabel.ts): the homography of a
 * box onto four projected corners, which way the text runs and stands, and how numbers are written.
 */
import { describe, expect, it } from "vitest";
import { boxToQuad, dimensionNumber, levelLabel, planeLabel, squareToQuad } from "./planeLabel";

type V3 = readonly [number, number, number];

/** Applies a CSS matrix3d (column-major) to a point of the box. */
const apply = (m: number[], x: number, y: number) => {
  const w = m[3]! * x + m[7]! * y + m[15]!;

  return [(m[0]! * x + m[4]! * y + m[12]!) / w, (m[1]! * x + m[5]! * y + m[13]!) / w];
};

/** A simple perspective camera looking down -z from z = 10 (focal 100 px). */
const camera = (p: V3) =>
  p[2] >= 10 ? null : ([(p[0] * 100) / (10 - p[2]), (-p[1] * 100) / (10 - p[2])] as const);
const close = (a: number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe("the box onto its quadrilateral", () => {
  it("maps each corner to its place, also in perspective", () => {
    const quad = [
      [10, 10],
      [50, 12],
      [45, 30],
      [12, 25],
    ] as const;
    const m = boxToQuad(80, 20, quad);
    close(apply(m, 0, 0), quad[0]);
    close(apply(m, 80, 0), quad[1]);
    close(apply(m, 80, 20), quad[2]);
    close(apply(m, 0, 20), quad[3]);
  });

  it("is plain (no perspective) for a parallelogram, and safe for a degenerate one", () => {
    const flat = squareToQuad([
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ]);
    expect(flat.slice(6).map(Math.abs)).toEqual([0, 0]);
    expect(
      squareToQuad([
        [0, 0],
        [0, 0],
        [0, 0],
        [1, 1],
      ])
        .slice(6)
        .map(Math.abs),
    ).toEqual([0, 0]);
  });
});

describe("text laid into the plane", () => {
  const along: V3 = [1, 0, 0];
  const away: V3 = [0, 1, 0];

  it("runs along its line, stands on the side away from what it measures, readable", () => {
    const m = planeLabel([0, 0, 0], along, away, 40, 10, 0.1, camera)!;
    const [left, top] = apply(m, 0, 0);
    const [right, bottom] = apply(m, 40, 10);
    expect(right).toBeGreaterThan(left!);
    // Above the line on the screen (y up is negative), its bottom just off it.
    expect(bottom).toBeLessThan(0);
    expect(top).toBeLessThan(bottom!);
  });

  it("is turned round in the plane when its line runs right to left, or its side faces down", () => {
    const m = planeLabel([0, 0, 0], [-1, 0, 0], [0, -1, 0], 40, 10, 0.1, camera)!;
    const [left, top] = apply(m, 0, 0);
    const [right, bottom] = apply(m, 40, 10);
    expect(right).toBeGreaterThan(left!);
    expect(top).toBeLessThan(bottom!);
    // Its far side faces down the screen: the text hangs below the line, still upright.
    expect(top).toBeGreaterThan(0);
  });

  it("is none for a line seen end on or a corner behind the camera", () => {
    expect(planeLabel([0, 0, 0], [0, 0, 1], away, 40, 10, 0.1, () => [0, 0])).toBeNull();
    expect(planeLabel([0, 0, 20], along, away, 40, 10, 0.1, camera)).toBeNull();

    let calls = 0;
    const fewCorners = (p: V3) => (++calls > 3 ? null : camera(p));
    expect(planeLabel([0, 0, 0], along, away, 40, 10, 0.1, fewCorners)).toBeNull();
  });
});

describe("numbers", () => {
  it("have at most two decimals, no trailing zeros, a comma where asked", () => {
    expect(dimensionNumber(25.829, true)).toBe("25,83");
    expect(dimensionNumber(114, true)).toBe("114");
    expect(dimensionNumber(12.5, false)).toBe("12.5");
    expect(dimensionNumber(1.004, true)).toBe("1");
  });
});

describe("text on a slanted plane", () => {
  /** Looking at the plane z = 0 from low down: depth (y) shortened to a fifth. */
  const low = (p: V3) => [p[0] * 10, -p[1] * 2 - p[2] * 10] as const;

  it("is made larger in the plane so it reads as tall as on the screen, within bounds", () => {
    const m = planeLabel([0, 0, 0], [1, 0, 0], [0, 1, 0], 40, 10, 0.1, low)!;
    const [, top] = apply(m, 0, 0);
    const [, bottom] = apply(m, 0, 10);
    // Without it, 10 pixels shortened to 2; stretched at most 2.5 times: 5.
    expect(bottom! - top!).toBeCloseTo(5, 6);
  });

  it("keeps its size where the plane is seen straight on, and copes with a corner it cannot see", () => {
    const m = planeLabel([0, 0, 0], [1, 0, 0], [0, 1, 0], 40, 10, 0.1, (p) => [p[0] * 10, -p[1] * 10])!;
    const [left] = apply(m, 0, 0);
    const [right] = apply(m, 40, 0);
    expect(right! - left!).toBeCloseTo(40, 6);

    // The stretch probes fall behind the camera: no stretch, still laid out from what can be seen.
    let calls = 0;
    const partly = (p: V3) => (++calls >= 4 && calls <= 7 ? null : ([p[0] * 10, -p[1] * 10] as const));
    expect(planeLabel([0, 0, 0], [1, 0, 0], [0, 1, 0], 40, 10, 0.1, partly)).not.toBeNull();
  });
});

describe("an angle's value", () => {
  /** The plane z = 0 seen from above at a slant (y shortened, x as it is). */
  const slant = (p: V3) => (p[2] >= 10 ? null : ([p[0] * 10, -p[1] * 5 - p[2] * 10] as const));
  const normal: V3 = [0, 0, 1];

  it("looks level on the screen, upright, centred on its arc", () => {
    // The arc's middle points up and to the right in the plane.
    const outward: V3 = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const m = levelLabel([0, 0, 0], outward, normal, 30, 10, 0.1, slant)!;
    const [lx, ly] = apply(m, 0, 10);
    const [rx, ry] = apply(m, 30, 10);
    expect(rx).toBeGreaterThan(lx!);
    expect(Math.abs(ry! - ly!)).toBeLessThan(1);

    const [, top] = apply(m, 15, 0);
    expect(top).toBeLessThan(ly!);

    // Centred on the arc's middle.
    const [cx, cy] = apply(m, 15, 5);
    expect(cx).toBeCloseTo(0, 6);
    expect(cy).toBeCloseTo(0, 6);
  });

  it("is none where its spot or every way through it cannot be seen", () => {
    expect(levelLabel([0, 0, 20], [1, 0, 0], normal, 30, 10, 0.1, slant)).toBeNull();

    let calls = 0;
    const onlySpot = (p: V3) => (++calls === 1 ? slant(p) : null);
    expect(levelLabel([0, 0, 0], [1, 0, 0], normal, 30, 10, 0.1, onlySpot)).toBeNull();
  });

  it("turns its top up when the plane is seen from below", () => {
    const below = (p: V3) => [p[0] * 10, p[1] * 5] as const;
    const m = levelLabel([0, 0, 0], [0, 1, 0], normal, 30, 10, 0.1, below)!;
    const [, top] = apply(m, 15, 0);
    const [, bottom] = apply(m, 15, 10);
    expect(top).toBeLessThan(bottom!);
  });
});
