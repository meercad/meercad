import { describe, expect, it } from "vitest";
import { fitSection, sectionMesh, type SectionPiece, type Vec2 } from "./meshsection.js";

const XY = { origin: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };

/** Side walls of a prism over closed outlines, z 0 to 10, as a triangle soup. */
function walls(loops: Vec2[][]): number[] {
  const out: number[] = [];
  for (const loop of loops)
    for (let i = 0; i < loop.length; i++) {
      const [a, b] = [loop[i]!, loop[(i + 1) % loop.length]!];
      out.push(a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], 10, a[0], a[1], 0, b[0], b[1], 10, a[0], a[1], 10);
    }
  return out;
}

/** 40 × 20 rectangle centred on the origin with corners rounded to `r`, as a polygon. */
function roundedRect(r: number, perQuarter = 16): Vec2[] {
  const out: Vec2[] = [];
  const corners: [number, number, number][] = [[20 - r, -10 + r, -Math.PI / 2], [20 - r, 10 - r, 0], [-20 + r, 10 - r, Math.PI / 2], [-20 + r, -10 + r, Math.PI]];
  for (const [cx, cy, a0] of corners) for (let k = 0; k <= perQuarter; k++) out.push([cx + r * Math.cos(a0 + (k * Math.PI) / 2 / perQuarter), cy + r * Math.sin(a0 + (k * Math.PI) / 2 / perQuarter)]);
  return out;
}

const circle = (cx: number, cy: number, r: number, n = 48): Vec2[] => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((-2 * Math.PI * k) / n), cy + r * Math.sin((-2 * Math.PI * k) / n)]);
const count = (pieces: SectionPiece[], kind: SectionPiece["kind"]) => pieces.filter((p) => p.kind === kind).length;

describe("sectionMesh", () => {
  it("cuts a prism into one closed chain per wall", () => {
    const chains = sectionMesh(walls([roundedRect(5), circle(10, 0, 4)]), null, XY);
    expect(chains).toHaveLength(2);
    expect(chains.every((c) => c.closed)).toBe(true);
    const outer = chains.find((c) => c.points.length > 96)!;
    expect(Math.max(...outer.points.map((p) => p[0]))).toBeCloseTo(20, 6);
    expect(Math.min(...outer.points.map((p) => p[1]))).toBeCloseTo(-10, 6);
  });

  it("joins the triangles of an indexed mesh whose vertices are repeated per face", () => {
    const soup = walls([circle(0, 0, 6)]);
    const indices = Array.from({ length: soup.length / 3 }, (_, i) => i);
    const chains = sectionMesh(new Float32Array(soup), indices, XY);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.closed).toBe(true);
    expect(chains[0]!.points).toHaveLength(96);
  });

  it("finds nothing where the plane misses the mesh", () => {
    expect(sectionMesh(walls([circle(0, 0, 6)]), null, { ...XY, origin: [0, 0, 20] })).toHaveLength(0);
  });
});

describe("fitSection", () => {
  it("traces a rounded rectangle as four lines and four arcs, and a hole as a circle", () => {
    const chains = sectionMesh(walls([roundedRect(5), circle(10, 0, 4)]), null, XY);
    const outer = fitSection(chains.find((c) => c.points.length > 96)!, 0.05);
    expect(count(outer, "line")).toBe(4);
    expect(count(outer, "arc")).toBe(4);
    for (const p of outer) if (p.kind === "arc") expect(p.radius).toBeCloseTo(5, 1);
    const lengths = outer.filter((p) => p.kind === "line").map((p) => (p.kind === "line" ? Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) : 0)).sort((a, b) => a - b);
    expect(lengths[0]).toBeCloseTo(10, 1);
    expect(lengths[3]).toBeCloseTo(30, 1);
    const hole = fitSection(chains.find((c) => c.points.length === 96)!, 0.05);
    expect(hole).toHaveLength(1);
    expect(hole[0]!.kind).toBe("circle");
    if (hole[0]!.kind === "circle") {
      expect(hole[0]!.radius).toBeCloseTo(4, 1);
      expect(hole[0]!.center[0]).toBeCloseTo(10, 3);
    }
  });

  it("gives sharp corners where the lines of a noisy outline meet", () => {
    // An L outline sampled every 0.2 mm with ±0.03 mm of noise, like a scan.
    const corners: Vec2[] = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 25], [0, 25]];
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.06;
    const points: Vec2[] = [];
    for (let i = 0; i < corners.length; i++) {
      const [a, b] = [corners[i]!, corners[(i + 1) % corners.length]!];
      const steps = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2);
      for (let k = 0; k < steps; k++) points.push([a[0] + ((b[0] - a[0]) * k) / steps + noise(), a[1] + ((b[1] - a[1]) * k) / steps + noise()]);
    }
    const pieces = fitSection({ points, closed: true }, 0.1);
    expect(pieces).toHaveLength(6);
    expect(count(pieces, "line")).toBe(6);
    for (const c of corners) {
      const nearest = Math.min(...pieces.map((p) => (p.kind === "line" ? Math.hypot(p.a[0] - c[0], p.a[1] - c[1]) : Infinity)));
      expect(nearest).toBeLessThan(0.05);
    }
  });

  it("keeps an open chain open, with a line into an arc", () => {
    const points: Vec2[] = [];
    for (let x = 0; x < 20; x += 0.5) points.push([x, 0]);
    for (let k = 0; k <= 30; k++) points.push([20 + 8 * Math.sin((k * Math.PI) / 60), 8 - 8 * Math.cos((k * Math.PI) / 60)]);
    const pieces = fitSection({ points, closed: false }, 0.05);
    expect(pieces.map((p) => p.kind)).toEqual(["line", "arc"]);
    const arc = pieces[1]!;
    if (arc.kind === "arc") {
      expect(arc.radius).toBeCloseTo(8, 2);
      expect(arc.ccw).toBe(true);
      expect(arc.b[0]).toBeCloseTo(28, 3);
    }
  });
});
