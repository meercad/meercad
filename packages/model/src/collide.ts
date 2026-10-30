/**
 * Quick collision test between triangle meshes, fast enough to run while parts are dragged: each
 * mesh gets a bounding-volume tree once (in its own, rest coordinates), and two meshes in given
 * poses are tested by walking both trees and checking triangle pairs only where boxes overlap.
 * It answers "do these surfaces cross?" on the display triangles, so it is approximate by the
 * tessellation; exact gaps and overlap volumes come from the kernel's clearance check.
 */
import { IDENTITY, multiply, type Mat4, type V3 } from "./motion.js";

const LEAF = 8;

interface Node {
  min: V3;
  max: V3;
  /** Children (inner node) or a range of `order` (leaf). */
  left?: Node;
  right?: Node;
  start: number;
  count: number;
}

export class MeshCollider {
  /** Triangle corners (9 numbers each) in the tree's order: a leaf's triangles lie together. */
  readonly tri: Float64Array;
  readonly root: Node;
  /** Corners after placing in another mesh's coordinates, filled per test (see `stamp`). */
  readonly placed: Float64Array;
  /** Test number each triangle in `placed` was filled for. */
  readonly stamp: Uint32Array;

  /** `positions` as x, y, z per vertex; `indices` three per triangle. */
  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>) {
    const n = Math.floor(indices.length / 3);
    const tri = new Float64Array(n * 9);
    for (let t = 0; t < n; t++)
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k]! * 3;
        tri[t * 9 + k * 3] = positions[v]!;
        tri[t * 9 + k * 3 + 1] = positions[v + 1]!;
        tri[t * 9 + k * 3 + 2] = positions[v + 2]!;
      }
    const order = Uint32Array.from({ length: n }, (_, i) => i);
    const centre = new Float64Array(n * 3);
    for (let t = 0; t < n; t++) for (let a = 0; a < 3; a++) centre[t * 3 + a] = (tri[t * 9 + a]! + tri[t * 9 + 3 + a]! + tri[t * 9 + 6 + a]!) / 3;
    this.root = build(tri, order, 0, n, centre);
    this.tri = new Float64Array(n * 9);
    for (let i = 0; i < n; i++) this.tri.set(tri.subarray(order[i]! * 9, order[i]! * 9 + 9), i * 9);
    this.placed = new Float64Array(n * 9);
    this.stamp = new Uint32Array(n);
  }

  get triangles(): number {
    return this.stamp.length;
  }
}

function build(tri: Float64Array, order: Uint32Array, start: number, count: number, centre: Float64Array): Node {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = start; i < start + count; i++) {
    const t = order[i]! * 9;
    for (let k = 0; k < 9; k++) {
      const a = k % 3;
      const v = tri[t + k]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const node: Node = { min, max, start, count };
  if (count <= LEAF) return node;
  // Split the longest side at the median of the triangle centres.
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axis = ext[0]! >= ext[1]! && ext[0]! >= ext[2]! ? 0 : ext[1]! >= ext[2]! ? 1 : 2;
  const part = Array.from(order.subarray(start, start + count)).sort((p, q) => centre[p * 3 + axis]! - centre[q * 3 + axis]!);
  order.set(part, start);
  const half = count >> 1;
  node.left = build(tri, order, start, half, centre);
  node.right = build(tri, order, start + half, count - half, centre);
  return node;
}

let tests = 0;

/**
 * Whether the surfaces of `a` placed by `poseA` and `b` placed by `poseB` cross anywhere. Each of
 * b's faces is set `inset` (mm) inwards first: parts resting flush stay apart, while two plates of
 * the same thickness pushed into each other (whose faces would only meet along their edges) cross.
 */
export function meshesCollide(a: MeshCollider, b: MeshCollider, poseA: Mat4 = IDENTITY, poseB: Mat4 = IDENTITY, inset = 0.005): boolean {
  // Work in a's coordinates: b's points go through m = poseA⁻¹ · poseB.
  const m = multiply(invertRigid(poseA), poseB);
  const xf = (p: V3): V3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
  const boxOf = (n: Node): { min: V3; max: V3 } => {
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = xf([c & 1 ? n.max[0] : n.min[0], c & 2 ? n.max[1] : n.min[1], c & 4 ? n.max[2] : n.min[2]]);
      for (let k = 0; k < 3; k++) {
        if (p[k]! < min[k]!) min[k] = p[k]!;
        if (p[k]! > max[k]!) max[k] = p[k]!;
      }
    }
    return { min, max };
  };
  const overlap = (p: { min: V3; max: V3 }, q: { min: V3; max: V3 }) => p.min[0] <= q.max[0] && q.min[0] <= p.max[0] && p.min[1] <= q.max[1] && q.min[1] <= p.max[1] && p.min[2] <= q.max[2] && q.min[2] <= p.max[2];
  // b's triangles placed in a's coordinates and set inwards, each once per test.
  const test = ++tests;
  const B = b.placed;
  const place = (j: number) => {
    const o = j * 9;
    for (let k = 0; k < 9; k += 3) {
      const x = b.tri[o + k]!, y = b.tri[o + k + 1]!, z = b.tri[o + k + 2]!;
      B[o + k] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      B[o + k + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      B[o + k + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    }
    if (inset) {
      const ux = B[o + 3]! - B[o]!, uy = B[o + 4]! - B[o + 1]!, uz = B[o + 5]! - B[o + 2]!;
      const vx = B[o + 6]! - B[o]!, vy = B[o + 7]! - B[o + 1]!, vz = B[o + 8]! - B[o + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l) for (let k = 0; k < 9; k += 3) {
        B[o + k] = B[o + k]! - (nx / l) * inset;
        B[o + k + 1] = B[o + k + 1]! - (ny / l) * inset;
        B[o + k + 2] = B[o + k + 2]! - (nz / l) * inset;
      }
    }
    b.stamp[j] = test;
  };
  const moved = new Map<Node, { min: V3; max: V3 }>();
  const boxB = (n: Node) => moved.get(n) ?? moved.set(n, boxOf(n)).get(n)!;
  const stack: [Node, Node][] = [[a.root, b.root]];
  while (stack.length) {
    const [na, nb] = stack.pop()!;
    if (!overlap(na, boxB(nb))) continue;
    const leafA = !na.left;
    const leafB = !nb.left;
    if (leafA && leafB) {
      const A = a.tri;
      for (let j = nb.start; j < nb.start + nb.count; j++) if (b.stamp[j] !== test) place(j);
      for (let i = na.start; i < na.start + na.count; i++) {
        const ao = i * 9;
        const x0 = Math.min(A[ao]!, A[ao + 3]!, A[ao + 6]!), x1 = Math.max(A[ao]!, A[ao + 3]!, A[ao + 6]!);
        const y0 = Math.min(A[ao + 1]!, A[ao + 4]!, A[ao + 7]!), y1 = Math.max(A[ao + 1]!, A[ao + 4]!, A[ao + 7]!);
        const z0 = Math.min(A[ao + 2]!, A[ao + 5]!, A[ao + 8]!), z1 = Math.max(A[ao + 2]!, A[ao + 5]!, A[ao + 8]!);
        for (let j = nb.start; j < nb.start + nb.count; j++) {
          const bo = j * 9;
          if (Math.max(B[bo]!, B[bo + 3]!, B[bo + 6]!) < x0 || Math.min(B[bo]!, B[bo + 3]!, B[bo + 6]!) > x1) continue;
          if (Math.max(B[bo + 1]!, B[bo + 4]!, B[bo + 7]!) < y0 || Math.min(B[bo + 1]!, B[bo + 4]!, B[bo + 7]!) > y1) continue;
          if (Math.max(B[bo + 2]!, B[bo + 5]!, B[bo + 8]!) < z0 || Math.min(B[bo + 2]!, B[bo + 5]!, B[bo + 8]!) > z1) continue;
          if (crossAt(A, ao, B, bo)) return true;
        }
      }
      continue;
    }
    // Descend the bigger box first.
    const sizeA = na.max[0] - na.min[0] + na.max[1] - na.min[1] + na.max[2] - na.min[2];
    const sizeB = nb.max[0] - nb.min[0] + nb.max[1] - nb.min[1] + nb.max[2] - nb.min[2];
    if (leafB || (!leafA && sizeA >= sizeB)) stack.push([na.left!, nb], [na.right!, nb]);
    else stack.push([na, nb.left!], [na, nb.right!]);
  }
  return false;
}

/** Inverse of a rotation + translation (the poses of moving parts). */
function invertRigid(m: Mat4): Mat4 {
  const r = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!];
  const t = [m[12]!, m[13]!, m[14]!];
  // Transpose of the rotation, and −Rᵀ·t.
  return [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, -(r[0]! * t[0]! + r[1]! * t[1]! + r[2]! * t[2]!), -(r[3]! * t[0]! + r[4]! * t[1]! + r[5]! * t[2]!), -(r[6]! * t[0]! + r[7]! * t[1]! + r[8]! * t[2]!), 1];
}


/**
 * Whether two triangles cross (Möller's interval test). Touching does not count: flush faces, a
 * shared edge or a corner on the other triangle are surfaces resting on each other.
 */
export function trianglesCross(t1: readonly [V3, V3, V3], t2: readonly [V3, V3, V3]): boolean {
  return crossAt(Float64Array.from(t1.flat()), 0, Float64Array.from(t2.flat()), 0);
}

const EPS = 1e-9;

/** Signed distances of triangle `T` (at `to`) from the plane through `P` (at `po`), into `out`; false if degenerate. */
function distances(P: Float64Array, po: number, T: Float64Array, to: number, out: Float64Array, normal: Float64Array): boolean {
  const ux = P[po + 3]! - P[po]!, uy = P[po + 4]! - P[po + 1]!, uz = P[po + 5]! - P[po + 2]!;
  const vx = P[po + 6]! - P[po]!, vy = P[po + 7]! - P[po + 1]!, vz = P[po + 8]! - P[po + 2]!;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!l) return false;
  nx /= l;
  ny /= l;
  nz /= l;
  normal[0] = nx;
  normal[1] = ny;
  normal[2] = nz;
  for (let k = 0; k < 3; k++) out[k] = nx * (T[to + k * 3]! - P[po]!) + ny * (T[to + k * 3 + 1]! - P[po + 1]!) + nz * (T[to + k * 3 + 2]! - P[po + 2]!);
  return true;
}

const d1 = new Float64Array(3), d2 = new Float64Array(3), n1 = new Float64Array(3), n2 = new Float64Array(3), proj = new Float64Array(3), span = new Float64Array(2);
/** Corners on both sides of the other plane (a triangle that only touches it rests against it). */
const through = (d: Float64Array) => (d[0]! > EPS || d[1]! > EPS || d[2]! > EPS) && (d[0]! < -EPS || d[1]! < -EPS || d[2]! < -EPS);

/** Where triangle `T` (distances `d`) meets the planes' common line, as a stretch along `dir`, into `span`. */
function stretch(T: Float64Array, to: number, d: Float64Array, dx: number, dy: number, dz: number): boolean {
  for (let k = 0; k < 3; k++) proj[k] = dx * T[to + k * 3]! + dy * T[to + k * 3 + 1]! + dz * T[to + k * 3 + 2]!;
  let lo = Infinity, hi = -Infinity, hits = 0;
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const di = d[i]!, dj = d[j]!;
    if (Math.abs(di) <= EPS) {
      lo = Math.min(lo, proj[i]!);
      hi = Math.max(hi, proj[i]!);
      hits++;
    }
    if ((di > EPS && dj < -EPS) || (di < -EPS && dj > EPS)) {
      const p = proj[i]! + ((proj[j]! - proj[i]!) * di) / (di - dj);
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
      hits++;
    }
  }
  span[0] = lo;
  span[1] = hi;
  return hits >= 2;
}

function crossAt(A: Float64Array, ao: number, B: Float64Array, bo: number): boolean {
  if (!distances(B, bo, A, ao, d1, n2) || !through(d1)) return false;
  if (!distances(A, ao, B, bo, d2, n1) || !through(d2)) return false;
  // Both triangles meet the line where their planes cross; they cross if their stretches overlap.
  const dx = n1[1]! * n2[2]! - n1[2]! * n2[1]!, dy = n1[2]! * n2[0]! - n1[0]! * n2[2]!, dz = n1[0]! * n2[1]! - n1[1]! * n2[0]!;
  if (!stretch(A, ao, d1, dx, dy, dz)) return false;
  const a0 = span[0]!, a1 = span[1]!;
  if (!stretch(B, bo, d2, dx, dy, dz)) return false;
  const b0 = span[0]!, b1 = span[1]!;
  // Overlapping in a single point or along an edge only is not a crossing.
  const tol = 1e-9 * Math.max(1, Math.abs(a0), Math.abs(a1));
  return a0 < b1 - tol && b0 < a1 - tol;
}
