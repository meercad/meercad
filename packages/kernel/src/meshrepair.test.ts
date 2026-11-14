import { describe, expect, it } from "vitest";
import { repairMesh } from "./meshrepair.js";

type V3 = [number, number, number];

/** Box from the origin to `size`, each face cut into n × n squares, as corners (outward). */
function box(size: V3, n: number, offset: V3 = [0, 0, 0], skipFace = -1): number[] {
  const out: number[] = [];
  // Each face: origin corner and two edge directions, ordered so u × v points out.
  const [x, y, z] = size;
  const faces: [V3, V3, V3][] = [
    [
      [0, 0, 0],
      [0, y, 0],
      [x, 0, 0],
    ],
    [
      [0, 0, z],
      [x, 0, 0],
      [0, y, 0],
    ],
    [
      [0, 0, 0],
      [x, 0, 0],
      [0, 0, z],
    ],
    [
      [0, y, 0],
      [0, 0, z],
      [x, 0, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, z],
      [0, y, 0],
    ],
    [
      [x, 0, 0],
      [0, y, 0],
      [0, 0, z],
    ],
  ];
  faces.forEach(([o, u, v], f) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (f === skipFace && i === 0 && j === 0) continue;

        const p = (a: number, b: number): V3 =>
          [0, 1, 2].map((k) => offset[k]! + o[k]! + (u[k]! * a) / n + (v[k]! * b) / n) as V3;
        const [a, b, c, d] = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  });

  return out;
}

function sphere(r: number, n: number): number[] {
  const out: number[] = [];

  const p = (i: number, j: number): V3 => {
    const th = (Math.PI * i) / n;
    const ph = (Math.PI * j) / n;

    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
  };

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 2 * n; j++) {
      const [a, b, c, d] = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
      if (i > 0) out.push(...a, ...b, ...d);
      if (i < n - 1) out.push(...b, ...c, ...d);
    }
  }

  return out;
}

function closed(indices: Uint32Array): boolean {
  const use = new Map<string, number>();

  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const [a, b] = [indices[t + e]!, indices[t + ((e + 1) % 3)]!];
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }

  return [...use.values()].every((u) => u === 2);
}

function volume(m: { positions: Float32Array; indices: Uint32Array }): number {
  let v = 0;
  const p = (i: number): V3 => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];

  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [p(m.indices[t]!), p(m.indices[t + 1]!), p(m.indices[t + 2]!)];
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }

  return v;
}

describe("repairMesh", () => {
  it("reduces a finely cut box to a few triangles, closed and the same size", () => {
    const m = repairMesh(box([20, 10, 5], 10), { reduce: 0.01 });
    expect(m.report.before).toBe(1200);
    expect(m.report.after).toBeLessThan(60);
    expect(closed(m.indices)).toBe(true);
    expect(volume(m)).toBeCloseTo(1000, 6);
  });

  it("keeps a reduced sphere within the tolerance", () => {
    const m = repairMesh(sphere(10, 40), { reduce: 0.05 });
    expect(m.report.after).toBeLessThan(m.report.before * 0.6);
    expect(closed(m.indices)).toBe(true);

    for (let i = 0; i < m.positions.length; i += 3) {
      expect(
        Math.abs(Math.hypot(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!) - 10),
      ).toBeLessThan(0.06);
    }
  });

  it("removes loose bits and closes holes", () => {
    const debris = box([0.5, 0.5, 0.5], 1, [40, 0, 0]);
    const m = repairMesh([...box([10, 10, 10], 4, [0, 0, 0], 2), ...debris], {
      removePieces: true,
      fillHoles: true,
    });
    expect(m.report.piecesRemoved).toBe(1);
    expect(m.report.holesFilled).toBe(1);
    expect(closed(m.indices)).toBe(true);
    expect(volume(m)).toBeCloseTo(1000, 6);
  });

  it("closes a missing face whichever way it looks, so the box is whole again", () => {
    for (let face = 0; face < 6; face++) {
      const m = repairMesh(box([10, 10, 10], 4, [0, 0, 0], face), { fillHoles: true });

      expect(m.report.holesFilled, `face ${face}`).toBe(1);
      expect(closed(m.indices), `face ${face}`).toBe(true);
      expect(volume(m), `face ${face}`).toBeCloseTo(1000, 6);
    }
  });

  it("closes a slit where one long edge meets three short ones, with a fan round its middle", () => {
    // A tetrahedron whose bottom face has two extra corners on the edge A–B; the face above uses
    // the edge in one piece, so the two do not join: a hole of four corners in a line.
    const A: V3 = [0, 0, 0];
    const B: V3 = [3, 0, 0];
    const C: V3 = [0, 3, 0];
    const D: V3 = [0, 0, 3];
    const P1: V3 = [1, 0, 0];
    const P2: V3 = [2, 0, 0];
    const triangles: V3[][] = [
      [A, C, P1],
      [P1, C, P2],
      [P2, C, B],
      [A, B, D],
      [A, D, C],
      [B, C, D],
    ];
    const m = repairMesh(triangles.flat(2), { fillHoles: true });

    expect(m.report.holesFilled).toBe(1);
    expect(closed(m.indices)).toBe(true);
    expect(volume(m)).toBeCloseTo(4.5, 9);
  });
});
