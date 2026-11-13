/**
 * Placing holes from an edge: a tap on an edge of the hole's face puts a hole beside it, far
 * enough in that the wall to the edge holds (an insert's minimum wall, for screws 1½ times the
 * hole's diameter between centre and edge).
 */

import { holeShape, type HoleShape } from "@meercad/model";
import type { Feature } from "@meercad/schema";

type Vec3 = [number, number, number];

/** The parts of a body mesh this needs (kernel BodyMesh and viewport ViewMesh both have them). */
export interface EdgeMesh {
  positions: Float32Array;
  indices: Uint32Array;
  faceRanges: Int32Array;
  edgeLines: Float32Array;
  edgeRanges: Int32Array;
  faceTags: string[][];
  edgeFaces: number[][];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** How far from the edge the hole's centre goes, mm; undefined when the hole's size is not known yet. */
export function edgeInset(feature: Extract<Feature, { op: "hole" }>): number | undefined {
  let shape: HoleShape;

  try {
    const num = (e: unknown) => (typeof e === "number" ? e : undefined);
    shape = holeShape(feature.kind, {
      size: feature.size,
      diameter: num(feature.diameter),
      fit: feature.fit,
      depth: num(feature.depth),
      allowance: num(feature.allowance),
      length: num(feature.length),
    });
  } catch {
    return undefined;
  }

  const r = shape.diameter / 2;
  const outer = Math.max(r, (shape.counterbore?.diameter ?? 0) / 2, (shape.countersink?.diameter ?? 0) / 2);

  return shape.insert ? r + shape.insert.wall : outer + shape.diameter;
}

/** A face's triangles, as corner triples. */
function triangles(m: EdgeMesh, face: number): [Vec3, Vec3, Vec3][] {
  const out: [Vec3, Vec3, Vec3][] = [];
  const at = (i: number): Vec3 => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];

  for (let g = 0; g < m.faceRanges.length; g += 3) {
    if (m.faceRanges[g + 2] !== face) continue;

    const start = m.faceRanges[g]!,
      count = m.faceRanges[g + 1]!;

    for (let k = start; k + 2 < start + count; k += 3) {
      out.push([at(m.indices[k]!), at(m.indices[k + 1]!), at(m.indices[k + 2]!)]);
    }
  }

  return out;
}

/** The flat face's outward normal, from its triangles; null when it is not flat. */
function flatNormal(tris: [Vec3, Vec3, Vec3][]): Vec3 | null {
  let n: Vec3 | null = null;

  for (const [a, b, c] of tris) {
    const m = cross(sub(b, a), sub(c, a));
    const l = len(m);
    if (l < 1e-9) continue;

    const u = scale(m, 1 / l);
    if (!n) n = u;
    else if (dot(n, u) < 1 - 1e-4) return null;
  }

  return n;
}

function inTriangle(p: Vec3, [a, b, c]: [Vec3, Vec3, Vec3], n: Vec3): boolean {
  const s = (x: Vec3, y: Vec3) => dot(cross(sub(y, x), sub(p, x)), n);
  const d1 = s(a, b),
    d2 = s(b, c),
    d3 = s(c, a);

  return (d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9) || (d1 <= 1e-9 && d2 <= 1e-9 && d3 <= 1e-9);
}

/**
 * Where a hole goes for a tap on an edge: on the flat face next to the edge (the one named by
 * `faceTag` when it borders the edge, else any flat one), `inset` in from the edge at the point
 * nearest the tap. Returns the point and the face's normal, or null for an edge with no flat face.
 */
export function holeBesideEdge(
  m: EdgeMesh,
  edge: number,
  tap: Vec3,
  inset: number,
  faceTag?: string,
): { point: Vec3; normal: Vec3 } | null {
  // The edge's segment nearest the tap.
  let best: { q: Vec3; t: Vec3; d: number } | null = null;

  for (let g = 0; g < m.edgeRanges.length; g += 3) {
    if (m.edgeRanges[g + 2] !== edge) continue;

    const start = m.edgeRanges[g]!,
      count = m.edgeRanges[g + 1]!;

    for (let k = start; k + 1 < start + count; k++) {
      const a: Vec3 = [m.edgeLines[k * 3]!, m.edgeLines[k * 3 + 1]!, m.edgeLines[k * 3 + 2]!];
      const b: Vec3 = [m.edgeLines[k * 3 + 3]!, m.edgeLines[k * 3 + 4]!, m.edgeLines[k * 3 + 5]!];
      const ab = sub(b, a);
      const l2 = dot(ab, ab);
      if (l2 < 1e-12) continue;

      const s = Math.min(1, Math.max(0, dot(sub(tap, a), ab) / l2));
      const q = add(a, scale(ab, s));
      const d = len(sub(tap, q));
      if (!best || d < best.d) best = { q, t: scale(ab, 1 / Math.sqrt(l2)), d };
    }
  }

  if (!best) return null;

  const faces = (m.edgeFaces[edge] ?? [])
    .map((fi) => ({ fi, tris: triangles(m, fi) }))
    .map((x) => ({ ...x, n: flatNormal(x.tris) }))
    .filter((x) => x.n);
  const face = faces.find((x) => faceTag && m.faceTags[x.fi]?.includes(faceTag)) ?? faces[0];
  if (!face) return null;

  const n = face.n!;
  // Across the edge in the face's plane, towards the face.
  const across = cross(n, best.t);
  const probe = 0.01;
  const inward = face.tris.some((tri) => inTriangle(add(best.q, scale(across, probe)), tri, n))
    ? across
    : scale(across, -1);

  return { point: add(best.q, scale(inward, inset)), normal: n };
}
