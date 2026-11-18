/**
 * A dimension's text laid into its plane with a true perspective (planeLabel.ts): the homography of a
 * box onto four projected corners, which way the text runs and stands, and how numbers are written.
 */
import { describe, expect, it } from "vitest";
import { boxToQuad, dimensionNumber, planeCorners, planeLabel, squareToQuad } from "./planeLabel";

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

describe("text lying in its plane like a sticker", () => {
  /** Looking at the plane z = 0 from low down: depth (y) shortened to a fifth. */
  const low = (p: V3) => [p[0] * 10, -p[1] * 2 - p[2] * 10] as const;
  const flat = (p: V3) => [p[0] * 10, -p[1] * 10] as const;
  const middle = (q: readonly V3[]) => [0, 1, 2].map((i) => q.reduce((sum, p) => sum + p[i]!, 0) / 4);

  it("keeps its size in the plane whatever angle it is seen at", () => {
    const m = planeLabel([0, 0, 0], [1, 0, 0], [0, 1, 0], 40, 10, 0.1, low)!;
    const [, top] = apply(m, 0, 0);
    const [, bottom] = apply(m, 0, 10);
    // 10 pixels of the plane seen from low down: 2 on the screen, not made larger.
    expect(bottom! - top!).toBeCloseTo(2, 6);

    const same = planeCorners([0, 0, 0], [1, 0, 0], [0, 1, 0], 40, 10, 0.1, flat)!.corners;
    expect(planeCorners([0, 0, 0], [1, 0, 0], [0, 1, 0], 40, 10, 0.1, low)!.corners).toEqual(same);
  });

  it("turns round about its middle, and only clearly past the turning point", () => {
    const along: V3 = [1, 0, 0];
    const away: V3 = [0, 1, 0];

    /** The plane seen straight on, the camera turned `deg` about its axis (y runs down the screen). */
    const turned = (deg: number) => (p: V3) => {
      const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
      const [x, y] = [p[0] * 10, -p[1] * 10];

      return [c * x - s * y, s * x + c * y] as const;
    };

    const first = planeCorners([0, 0, 0], along, away, 40, 10, 0.1, turned(30))!;
    expect(first.turn).toEqual({ x: 1, up: 1 });

    // A little past the vertical: it keeps its way.
    const kept = planeCorners([0, 0, 0], along, away, 40, 10, 0.1, turned(100), first.turn)!;
    expect(kept.turn).toEqual(first.turn);
    expect(kept.corners).toEqual(first.corners);
    // Without what it was before it would have turned.
    expect(planeCorners([0, 0, 0], along, away, 40, 10, 0.1, turned(100))!.turn).toEqual({ x: -1, up: -1 });

    // Well past it: turned round half a circle at once (both ways), its middle where it was.
    const round = planeCorners([0, 0, 0], along, away, 40, 10, 0.1, turned(120), first.turn)!;
    expect(round.turn).toEqual({ x: -1, up: -1 });
    close(middle(round.corners), middle(first.corners));

    // Seen from behind the plane (mirrored): the other side is its top, so the letters read right.
    const behind = (p: V3) => [p[0] * 10, p[1] * 10] as const;
    const back = planeCorners([0, 0, 0], along, away, 40, 10, 0.1, behind, first.turn)!;
    expect(back.turn).toEqual({ x: 1, up: -1 });
    close(middle(back.corners), middle(first.corners));
  });

  it("keeps which side of the plane it is seen from while the camera looks along the plane", () => {
    const along: V3 = [1, 0, 0];
    const away: V3 = [0, 1, 0];
    /** The plane seen from `k` above it (negative: below), nearly along it. */
    const grazing = (k: number) => (p: V3) => [p[0] * 10, -p[1] * k] as const;
    const above = planeCorners([0, 0, 0], along, away, 40, 10, 0.1, grazing(3))!;
    expect(above.turn).toEqual({ x: 1, up: 1 });

    // Just through the plane: kept (it cannot be read there anyway), no flicker.
    expect(planeCorners([0, 0, 0], along, away, 40, 10, 0.1, grazing(-0.5), above.turn)!.turn).toEqual(
      above.turn,
    );
    // Clearly below it: the letters read right from there.
    expect(planeCorners([0, 0, 0], along, away, 40, 10, 0.1, grazing(-3), above.turn)!.turn).toEqual({
      x: 1,
      up: -1,
    });
    // Its line running the other way, seen from the far side: turned round as well, still unmirrored.
    expect(planeCorners([0, 0, 0], [-1, 0, 0], away, 40, 10, 0.1, grazing(3))!.turn).toEqual({
      x: -1,
      up: 1,
    });
    // Coming back up, nearly along the plane: still from below.
    expect(planeCorners([0, 0, 0], along, away, 40, 10, 0.1, grazing(0.5), { x: 1, up: -1 })!.turn).toEqual({
      x: 1,
      up: -1,
    });
  });

  it("is none when a corner cannot be seen", () => {
    let calls = 0;
    const partly = (p: V3) => (++calls >= 4 && calls <= 5 ? null : flat(p));
    expect(planeLabel([0, 0, 0], [1, 0, 0], [0, 1, 0], 40, 10, 0.1, partly)).toBeNull();
  });
});
