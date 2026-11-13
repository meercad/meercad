import { describe, expect, it } from "vitest";
import { compareShapes, nearestTriangle, scanMesh, shapeAt, shapeValues, type ScanShape } from "./scanfit.js";

/**
 * Closed mesh of a solid of revolution about Z with the radius profile r(z), every vertex moved by
 * up to ±0.02 mm of repeatable noise (the same place always moves the same way), like a scan.
 */
function lathe(profile: [number, number][], segments = 64): number[] {
  const out: number[] = [];
  const noise = (x: number, y: number, z: number) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return (s - Math.floor(s) - 0.5) * 0.04;
  };
  const ring = (i: number, k: number): number[] => {
    const [z, r] = profile[i]!;
    const a = (2 * Math.PI * (k % segments)) / segments;
    const [x, y] = [r * Math.cos(a), r * Math.sin(a)];
    if (r === 0) return [0, 0, z];
    const e = noise(Math.round(x * 1e3), Math.round(y * 1e3), Math.round(z * 1e3));
    return [x + e * Math.cos(a), y + e * Math.sin(a), z + e];
  };
  for (let i = 0; i + 1 < profile.length; i++)
    for (let k = 0; k < segments; k++) {
      const a = ring(i, k), b = ring(i, k + 1), c = ring(i + 1, k + 1), d = ring(i + 1, k);
      if (profile[i]![1] > 0) out.push(...a, ...b, ...c);
      if (profile[i + 1]![1] > 0) out.push(...a, ...c, ...d);
    }
  return out;
}

/** Rows every `step` mm between two profile points, so walls have many triangles along the axis. */
function rows(a: [number, number], b: [number, number], step = 1): [number, number][] {
  const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  return Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
}

// A disc (r 20, 5 high) with a boss (r 6) up to z 15.
const boss = scanMesh(lathe([...rows([0, 0], [0, 20]), ...rows([0, 20], [5, 20]), ...rows([5, 20], [5, 6]), ...rows([5, 6], [15, 6]), ...rows([15, 6], [15, 0]), [15, 0]]));
const at = (x: number, y: number, z: number) => shapeAt(boss, nearestTriangle(boss, [x, y, z]), 0.1)!;
const value = (vs: { label: string; value: number }[], label: string) => vs.find((v) => v.label === label)?.value;

describe("shapeAt", () => {
  it("fits the boss as a cylinder of its diameter and height", () => {
    const s = at(6, 0, 10);
    expect(s.kind).toBe("cylinder");
    expect(value(shapeValues(s), "Diameter")).toBeCloseTo(12, 1);
    expect(s.length).toBeCloseTo(10, 0);
    if (s.kind === "cylinder") expect(Math.abs(s.axis[2])).toBeCloseTo(1, 3);
  });

  it("fits the flat faces as planes and does not run over the edges", () => {
    const top = at(0, 0, 15);
    const step = at(12, 0, 5);
    expect(top.kind).toBe("plane");
    expect(step.kind).toBe("plane");
    // The ring between boss and rim: π (20² − 6²).
    expect(step.area).toBeGreaterThan(Math.PI * 364 * 0.9);
    expect(step.area).toBeLessThan(Math.PI * 364 * 1.05);
    expect(value(shapeValues(step), "Flatness")).toBeLessThan(0.1);
  });

  it("fits a sphere and a cone", () => {
    const ball = scanMesh(lathe(Array.from({ length: 41 }, (_, i): [number, number] => [-8 * Math.cos((i * Math.PI) / 40), 8 * Math.sin((i * Math.PI) / 40)])));
    const s = shapeAt(ball, nearestTriangle(ball, [8, 0, 0]), 0.1)!;
    expect(s.kind).toBe("sphere");
    expect(value(shapeValues(s), "Diameter")).toBeCloseTo(16, 1);
    // 90° countersink-like cone: r = 10 − z.
    const cone = scanMesh(lathe([...rows([0, 0], [0, 10]), ...rows([0, 10], [8, 2]), ...rows([8, 2], [8, 0]), [8, 0]]));
    const c = shapeAt(cone, nearestTriangle(cone, [6, 0, 4]), 0.1)!;
    expect(c.kind).toBe("cone");
    expect(value(shapeValues(c), "Cone angle")).toBeCloseTo(90, 0);
  });
});

describe("compareShapes", () => {
  const get = (a: ScanShape, b: ScanShape, label: string) => value(compareShapes(a, b), label);

  it("measures between parallel faces", () => {
    expect(get(at(0, 0, 15), at(12, 0, 5), "Distance")).toBeCloseTo(10, 1);
    expect(get(at(0, 0, 15), at(12, 0, 5), "Angle")).toBeLessThan(0.5);
  });

  it("gives the angle between a face and an axis, and the distance between parallel axes", () => {
    expect(get(at(12, 0, 5), at(6, 0, 10), "Angle to axis")).toBeCloseTo(90, 0);
    // Rim and boss share the axis.
    expect(get(at(20, 0, 2), at(6, 0, 10), "Distance between axes")).toBeLessThan(0.05);
  });
});

describe("compareShapes, worked by hand", () => {
  const base = { triangles: [], area: 1, deviation: 0, centroid: [0, 0, 0] as [number, number, number] };
  const plane = (z: number): ScanShape => ({ ...base, kind: "plane", origin: [0, 0, z], normal: [0, 0, 1], centroid: [3, 4, z] });
  const rod = (origin: [number, number, number], axis: [number, number, number], centroid: [number, number, number] = origin): ScanShape => ({ ...base, kind: "cylinder", origin, axis, radius: 2, centroid });
  const ball = (center: [number, number, number]): ScanShape => ({ ...base, kind: "sphere", center, radius: 3, centroid: center });
  const cone = (apex: [number, number, number]): ScanShape => ({ ...base, kind: "cone", apex, axis: [0, 0, 1], halfAngle: Math.PI / 4, centroid: apex });
  const get = (a: ScanShape, b: ScanShape, label: string) => value(compareShapes(a, b), label);

  it("an axis lying along a face: how high above it it runs", () => {
    // A rod along X, 7 mm above the face z = 2, its triangles' centre off to one side.
    const r = rod([0, 0, 9], [1, 0, 0], [40, 0, 11]);
    expect(get(plane(2), r, "Angle to axis")).toBeCloseTo(0, 9);
    expect(get(r, plane(2), "Distance to axis")).toBeCloseTo(7, 9);
  });

  it("two skew axes: their closest distance, and the angle between them", () => {
    // One along X through the origin, one along Y through (0, 0, 5): 5 mm apart where they cross.
    const out = compareShapes(rod([0, 0, 0], [1, 0, 0]), rod([3, -8, 5], [0, 1, 0]));
    expect(value(out, "Angle between axes")).toBeCloseTo(90, 9);
    expect(value(out, "Closest distance between axes")).toBeCloseTo(5, 9);
    // At 30° to each other, still 5 mm apart.
    const tilted = compareShapes(cone([0, 0, 0]), rod([1, 1, 5], [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)]));
    expect(value(tilted, "Angle between axes")).toBeCloseTo(30, 9);
  });

  it("a ball: from a face, from an axis, from another ball", () => {
    expect(get(ball([1, 2, 10]), plane(4), "Distance to centre")).toBeCloseTo(6, 9);
    expect(get(ball([3, 4, 7]), rod([0, 0, 0], [0, 0, 1]), "Distance centre to axis")).toBeCloseTo(5, 9);
    expect(get(ball([0, 0, 0]), ball([2, 3, 6]), "Distance between centres")).toBeCloseTo(7, 9);
  });
});
