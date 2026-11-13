import { describe, expect, it } from "vitest";
import { bendMeshes, BendError, makeBender, spiralAngle, spiralLength, weldClosed, type V3 } from "./bend.js";

/** Box from `min` to `max`, each face two triangles, wound outwards, as corners. */
function box(min: V3, max: V3): number[] {
  const out: number[] = [];
  const p = (i: number): V3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  for (const [a, b, c, d] of quads) out.push(...p(a!), ...p(b!), ...p(c!), ...p(a!), ...p(c!), ...p(d!));

  return out;
}

const volume = (c: ArrayLike<number>) => {
  let v = 0;

  for (let t = 0; t < c.length; t += 9) {
    v +=
      (c[t]! * (c[t + 4]! * c[t + 8]! - c[t + 5]! * c[t + 7]!) -
        c[t + 1]! * (c[t + 3]! * c[t + 8]! - c[t + 5]! * c[t + 6]!) +
        c[t + 2]! * (c[t + 3]! * c[t + 7]! - c[t + 4]! * c[t + 6]!)) /
      6;
  }

  return v;
};

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A 1 m folding-rule strip: 1000 × 20 × 3 mm lying flat on XY. */
const ruler = box([0, 0, 0], [1000, 20, 3]);

describe("spiral arc length", () => {
  it("inverts its length", () => {
    for (const s of [0.5, 10, 300, 1000]) {
      expect(spiralLength(21.5, 4 / (2 * Math.PI), spiralAngle(21.5, 4 / (2 * Math.PI), s))).toBeCloseTo(
        s,
        8,
      );
    }
  });
});

describe("bend mapping", () => {
  it("rolls a ruler into a flat spiral: length kept, radius right, turns apart", () => {
    const b = makeBender(ruler, { mode: "spiral", axis: [0, 0, 1], radius: 20, gap: 1 });
    // Length along X, thickness across Y (20 mm), axis Z: the coil lies flat.
    expect(b.frame.length).toBe(1000);
    expect(b.frame.thickness).toBe(20);

    const t = b.frame.thickness;
    // Middle of the thickness keeps its length.
    let len = 0;
    let prev = b.map(0, t / 2, 1.5);

    for (let i = 1; i <= 20000; i++) {
      const p = b.map(i / 20, t / 2, 1.5);
      len += dist(p, prev);
      prev = p;
    }

    expect(len).toBeCloseTo(1000, 1);

    // Inner face starts at the inner radius from the centre (where the strip's middle was).
    const c: V3 = [500, 10, 1.5];
    expect(dist(b.map(0, 0, 1.5), c)).toBeCloseTo(20, 6);

    // Every turn's outer face clears the next turn's inner face by the gap (measured along the radius,
    // slightly more than across the slanted strip).
    let minGap = Infinity;

    for (let x = 0; x < 1000; x += 2) {
      const phi = b.angleAt(x);
      const outer = dist(b.map(x, t, 1.5), c);
      // The point one turn further on, inner face.
      let lo = x,
        hi = 1000;
      if (b.angleAt(hi) < phi + 2 * Math.PI) break;

      for (let k = 0; k < 60; k++) {
        const m = (lo + hi) / 2;
        if (b.angleAt(m) < phi + 2 * Math.PI) lo = m;
        else hi = m;
      }

      minGap = Math.min(minGap, dist(b.map(lo, 0, 1.5), c) - outer);
    }

    expect(minGap).toBeGreaterThan(0.99);
    expect(minGap).toBeLessThan(1.03);
    expect(b.info.turns).toBeGreaterThan(2.5);
    expect(b.info.turns).toBeLessThan(3);
    expect(b.info.outerRadius * 2).toBeLessThan(220);
  });

  it("bends by an angle about the middle of the thickness", () => {
    const b = makeBender(box([0, 0, 0], [100, 10, 2]), { mode: "bend", axis: [0, 1, 0], angle: 90 });
    expect(b.info.radius).toBeCloseTo(100 / (Math.PI / 2), 9);
    expect(b.info.angle).toBeCloseTo(90, 9);

    const R = b.info.radius;
    // The ends turn by ±45°: their middles are R apart on a circle (chord of 90°).
    expect(dist(b.map(0, 1, 5), b.map(100, 1, 5))).toBeCloseTo(2 * R * Math.sin(Math.PI / 4), 6);

    // The middle stays where it was.
    const m = b.map(50, 1, 5);
    expect(m[0]).toBeCloseTo(50, 9);
    expect(m[2]).toBeCloseTo(1, 9);
  });

  it("wraps onto a cylinder with the inner face on it", () => {
    const r = 100 / (2 * Math.PI);
    const b = makeBender(box([0, 0, 0], [100, 10, 2]), { mode: "wrap", axis: [0, 1, 0], radius: r });
    expect(b.info.closed).toBe(true);
    expect(b.warnings).toEqual([]);

    // Inner face on the cylinder: its centre is r below the middle of the bottom face.
    const c: V3 = [50, 0, -r];

    for (const x of [0, 13, 50, 77, 100]) {
      expect(Math.hypot(b.map(x, 0, 0)[0] - c[0], b.map(x, 0, 0)[2] - c[2])).toBeCloseTo(r, 9);
    }
  });

  it("refuses overlapping and impossible bends", () => {
    expect(() => makeBender(ruler, { mode: "spiral", axis: [0, 0, 1], radius: 20, gap: 0 })).toThrow(
      BendError,
    );
    expect(() => makeBender(ruler, { mode: "spiral", axis: [0, 0, 1], radius: 20, gap: -1 })).toThrow(
      /overlap/,
    );
    expect(() => makeBender(ruler, { mode: "wrap", axis: [0, 0, 1], radius: 100 })).toThrow(/overlap itself/);
    expect(() =>
      makeBender(box([0, 0, 0], [10, 10, 4]), { mode: "bend", axis: [0, 1, 0], radius: 1.5 }),
    ).toThrow(/half the thickness/);
    expect(
      makeBender(ruler, { mode: "spiral", axis: [0, 0, 1], radius: 20, gap: 0.1 }).warnings.join(),
    ).toMatch(/may fuse/);
  });

  it("refuses a bend by no angle, by more than a full turn, and one too fine to triangulate", () => {
    const strip = box([0, 0, 0], [100, 10, 2]);

    expect(() => makeBender(strip, { mode: "bend", axis: [0, 1, 0], angle: 0 })).toThrow(
      /the bend angle must be greater than zero/,
    );
    expect(() => makeBender(strip, { mode: "bend", axis: [0, 1, 0], angle: 400 })).toThrow(
      /a bend goes at most once round/,
    );
    expect(() =>
      bendMeshes([ruler], { mode: "spiral", axis: [0, 0, 1], radius: 20, gap: 1, tolerance: 1e-9 }),
    ).toThrow(/bending this finely needs too many triangles/);
  });
});

describe("bent meshes", () => {
  it("stay closed, keep their volume and follow the curve", () => {
    const [m] = bendMeshes([ruler], { mode: "spiral", axis: [0, 0, 1], radius: 20, gap: 1, tolerance: 0.05 });
    // Closed: welds back into a mesh whose every edge has two triangles.
    expect(() => weldClosed(m!.corners, 1e-5)).not.toThrow();
    expect(volume(m!.corners)).toBeGreaterThan(0);
    expect(volume(m!.corners) / 60000).toBeCloseTo(1, 2);
    expect(m!.triangles.after).toBeGreaterThan(1000);
    expect(m!.triangles.after).toBeLessThan(20000);

    // Every corner lies inside the coil's ring.
    const c: V3 = [500, 10, 0];

    for (let i = 0; i < m!.corners.length; i += 3) {
      const r = Math.hypot(m!.corners[i]! - c[0], m!.corners[i + 1]! - c[1]);
      expect(r).toBeGreaterThan(19.99);
      expect(r).toBeLessThan(m!.info.outerRadius + 0.01);
    }
  });

  it("bends several parts as one piece and rejects open meshes", () => {
    const out = bendMeshes([box([0, 0, 0], [50, 10, 2]), box([50, 0, 0], [100, 10, 2])], {
      mode: "bend",
      axis: [0, 1, 0],
      angle: 180,
    });
    expect(out).toHaveLength(2);

    // The two halves still meet at the middle, which stays put.
    const xs = (c: Float32Array) => Array.from({ length: c.length / 3 }, (_, i) => c[i * 3]!);
    expect(Math.max(...xs(out[0]!.corners))).toBeCloseTo(Math.min(...xs(out[1]!.corners)), 3);
    expect(() => bendMeshes([ruler.slice(18)], { mode: "bend", axis: [0, 1, 0], angle: 90 })).toThrow(
      /not closed/,
    );
  });
});
