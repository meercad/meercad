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
  /**
   * Inward direction at each corner (9 numbers per triangle, tree order): the averaged normal of
   * all faces meeting at that point, so setting a mesh in shrinks it at edges and corners too.
   */
  readonly inward: Float32Array;
  /** Corners after placing in another mesh's coordinates, filled per test (see `stamp`). */
  readonly placed: Float64Array;
  /** Test number each triangle in `placed` was filled for. */
  readonly stamp: Uint32Array;

  /** `positions` as x, y, z per vertex; `indices` three per triangle. */
  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>) {
    const n = Math.floor(indices.length / 3);
    const tri = new Float64Array(n * 9);

    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k]! * 3;
        tri[t * 9 + k * 3] = positions[v]!;
        tri[t * 9 + k * 3 + 1] = positions[v + 1]!;
        tri[t * 9 + k * 3 + 2] = positions[v + 2]!;
      }
    }

    const order = Uint32Array.from({ length: n }, (_, i) => i);
    const centre = new Float64Array(n * 3);

    for (let t = 0; t < n; t++) {
      for (let a = 0; a < 3; a++) {
        centre[t * 3 + a] = (tri[t * 9 + a]! + tri[t * 9 + 3 + a]! + tri[t * 9 + 6 + a]!) / 3;
      }
    }

    this.root = build(tri, order, 0, n, centre);
    this.tri = new Float64Array(n * 9);
    for (let i = 0; i < n; i++) this.tri.set(tri.subarray(order[i]! * 9, order[i]! * 9 + 9), i * 9);
    this.placed = new Float64Array(n * 9);
    this.stamp = new Uint32Array(n);

    // Corners at the same place (faces of a B-rep part keep their own vertices) share one normal.
    const corner = pointIds(this.tri, n * 3);
    let points = 0;
    for (let c = 0; c < n * 3; c++) if (corner[c]! >= points) points = corner[c]! + 1;

    const sums = new Float64Array(points * 3);

    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const T = this.tri;
      const ux = T[o + 3]! - T[o]!,
        uy = T[o + 4]! - T[o + 1]!,
        uz = T[o + 5]! - T[o + 2]!;
      const vx = T[o + 6]! - T[o]!,
        vy = T[o + 7]! - T[o + 1]!,
        vz = T[o + 8]! - T[o + 2]!;
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (!l) continue;

      // Each face counts once per point, whatever its size.
      for (let k = 0; k < 3; k++) {
        const q = corner[t * 3 + k]! * 3;
        sums[q] = sums[q]! + nx / l;
        sums[q + 1] = sums[q + 1]! + ny / l;
        sums[q + 2] = sums[q + 2]! + nz / l;
      }
    }

    this.inward = new Float32Array(n * 9);

    for (let c = 0; c < n * 3; c++) {
      const q = corner[c]! * 3;
      const l = Math.hypot(sums[q]!, sums[q + 1]!, sums[q + 2]!);
      if (l) for (let a = 0; a < 3; a++) this.inward[c * 3 + a] = -sums[q + a]! / l;
    }
  }

  get triangles(): number {
    return this.stamp.length;
  }
}

/**
 * The same number for corners at the same place (to 0.01 µm), counting from 0: an open-addressing
 * table over the rounded coordinates. String keys in a Map took several seconds for a few million
 * triangles, the bulk of building the trees of a large assembly.
 */
function pointIds(xyz: Float64Array, count: number): Uint32Array {
  let cap = 1;
  while (cap < count * 2) cap <<= 1;

  const mask = cap - 1;
  const keys = new Int32Array(cap * 3);
  const slot = new Int32Array(cap).fill(-1);
  const out = new Uint32Array(count);
  let next = 0;

  for (let c = 0; c < count; c++) {
    // Rounded to 1e-5 mm; `| 0` wraps beyond ±21 m, which only ever merges points 43 m apart.
    const x = Math.round(xyz[c * 3]! * 1e5) | 0;
    const y = Math.round(xyz[c * 3 + 1]! * 1e5) | 0;
    const z = Math.round(xyz[c * 3 + 2]! * 1e5) | 0;
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;

    for (;;) {
      const id = slot[h]!;

      if (id < 0) {
        slot[h] = next;
        keys[h * 3] = x;
        keys[h * 3 + 1] = y;
        keys[h * 3 + 2] = z;
        out[c] = next++;
        break;
      }

      if (keys[h * 3] === x && keys[h * 3 + 1] === y && keys[h * 3 + 2] === z) {
        out[c] = id;
        break;
      }

      h = (h + 1) & mask;
    }
  }

  return out;
}

function build(
  tri: Float64Array,
  order: Uint32Array,
  start: number,
  count: number,
  centre: Float64Array,
): Node {
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
  // Partitioned round the median only (no full sort): linear per level.
  const half = count >> 1;
  selectNth(order, start, start + count - 1, start + half, centre, axis);
  node.left = build(tri, order, start, half, centre);
  node.right = build(tri, order, start + half, count - half, centre);

  return node;
}

/**
 * Reorders order[lo..hi] so the k-th holds the triangle it would in sorted order, smaller centres before it,
 * larger after (Hoare's select).
 */
function selectNth(
  order: Uint32Array,
  lo: number,
  hi: number,
  k: number,
  centre: Float64Array,
  axis: number,
): void {
  const at = (i: number) => centre[order[i]! * 3 + axis]!;

  while (hi > lo) {
    const pivot = at((lo + hi) >> 1);
    let i = lo;
    let j = hi;

    while (i <= j) {
      while (at(i) < pivot) i++;
      while (at(j) > pivot) j--;

      if (i <= j) {
        const t = order[i]!;
        order[i] = order[j]!;
        order[j] = t;
        i++;
        j--;
      }
    }

    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

let tests = 0;

/**
 * Whether the surfaces of `a` placed by `poseA` and `b` placed by `poseB` cross anywhere. b is set
 * `inset` (mm) inwards first, every corner along its averaged normal: parts resting flush stay apart, while
 * two plates of
 * the same thickness pushed into each other (whose faces would only meet along their edges) cross.
 */
export function meshesCollide(
  a: MeshCollider,
  b: MeshCollider,
  poseA: Mat4 = IDENTITY,
  poseB: Mat4 = IDENTITY,
  inset = 0.005,
): boolean {
  // Work in a's coordinates: b's points go through m = poseA⁻¹ · poseB.
  const m = multiply(invertRigid(poseA), poseB);
  const xf = (p: V3): V3 => [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];

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

  const overlap = (p: { min: V3; max: V3 }, q: { min: V3; max: V3 }) =>
    p.min[0] <= q.max[0] &&
    q.min[0] <= p.max[0] &&
    p.min[1] <= q.max[1] &&
    q.min[1] <= p.max[1] &&
    p.min[2] <= q.max[2] &&
    q.min[2] <= p.max[2];
  // b's triangles placed in a's coordinates and set inwards, each once per test.
  const test = ++tests;
  const B = b.placed;

  const place = (j: number) => {
    const o = j * 9;

    for (let k = 0; k < 9; k += 3) {
      const x = b.tri[o + k]!,
        y = b.tri[o + k + 1]!,
        z = b.tri[o + k + 2]!;
      B[o + k] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      B[o + k + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      B[o + k + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    }

    if (inset) {
      for (let k = 0; k < 9; k += 3) {
        // The inward direction turns with the part (rotation only).
        const ix = b.inward[o + k]!,
          iy = b.inward[o + k + 1]!,
          iz = b.inward[o + k + 2]!;
        B[o + k] = B[o + k]! + (m[0]! * ix + m[4]! * iy + m[8]! * iz) * inset;
        B[o + k + 1] = B[o + k + 1]! + (m[1]! * ix + m[5]! * iy + m[9]! * iz) * inset;
        B[o + k + 2] = B[o + k + 2]! + (m[2]! * ix + m[6]! * iy + m[10]! * iz) * inset;
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
        const x0 = Math.min(A[ao]!, A[ao + 3]!, A[ao + 6]!),
          x1 = Math.max(A[ao]!, A[ao + 3]!, A[ao + 6]!);
        const y0 = Math.min(A[ao + 1]!, A[ao + 4]!, A[ao + 7]!),
          y1 = Math.max(A[ao + 1]!, A[ao + 4]!, A[ao + 7]!);
        const z0 = Math.min(A[ao + 2]!, A[ao + 5]!, A[ao + 8]!),
          z1 = Math.max(A[ao + 2]!, A[ao + 5]!, A[ao + 8]!);

        for (let j = nb.start; j < nb.start + nb.count; j++) {
          const bo = j * 9;

          if (
            Math.max(B[bo]!, B[bo + 3]!, B[bo + 6]!) < x0 ||
            Math.min(B[bo]!, B[bo + 3]!, B[bo + 6]!) > x1
          ) {
            continue;
          }

          if (
            Math.max(B[bo + 1]!, B[bo + 4]!, B[bo + 7]!) < y0 ||
            Math.min(B[bo + 1]!, B[bo + 4]!, B[bo + 7]!) > y1
          ) {
            continue;
          }

          if (
            Math.max(B[bo + 2]!, B[bo + 5]!, B[bo + 8]!) < z0 ||
            Math.min(B[bo + 2]!, B[bo + 5]!, B[bo + 8]!) > z1
          ) {
            continue;
          }

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
  return [
    r[0]!,
    r[3]!,
    r[6]!,
    0,
    r[1]!,
    r[4]!,
    r[7]!,
    0,
    r[2]!,
    r[5]!,
    r[8]!,
    0,
    -(r[0]! * t[0]! + r[1]! * t[1]! + r[2]! * t[2]!),
    -(r[3]! * t[0]! + r[4]! * t[1]! + r[5]! * t[2]!),
    -(r[6]! * t[0]! + r[7]! * t[1]! + r[8]! * t[2]!),
    1,
  ];
}

/**
 * Whether two triangles cross (Möller's interval test). Touching does not count: flush faces, a
 * shared edge or a corner on the other triangle are surfaces resting on each other.
 */
export function trianglesCross(t1: readonly [V3, V3, V3], t2: readonly [V3, V3, V3]): boolean {
  return crossAt(Float64Array.from(t1.flat()), 0, Float64Array.from(t2.flat()), 0);
}

const EPS = 1e-9;

/**
 * Signed distances of triangle `T` (at `to`) from the plane through `P` (at `po`), into `out`; false if
 * degenerate.
 */
function distances(
  P: Float64Array,
  po: number,
  T: Float64Array,
  to: number,
  out: Float64Array,
  normal: Float64Array,
): boolean {
  const ux = P[po + 3]! - P[po]!,
    uy = P[po + 4]! - P[po + 1]!,
    uz = P[po + 5]! - P[po + 2]!;
  const vx = P[po + 6]! - P[po]!,
    vy = P[po + 7]! - P[po + 1]!,
    vz = P[po + 8]! - P[po + 2]!;
  let nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!l) return false;

  nx /= l;
  ny /= l;
  nz /= l;
  normal[0] = nx;
  normal[1] = ny;
  normal[2] = nz;

  for (let k = 0; k < 3; k++) {
    out[k] =
      nx * (T[to + k * 3]! - P[po]!) +
      ny * (T[to + k * 3 + 1]! - P[po + 1]!) +
      nz * (T[to + k * 3 + 2]! - P[po + 2]!);
  }

  return true;
}

const d1 = new Float64Array(3),
  d2 = new Float64Array(3),
  n1 = new Float64Array(3),
  n2 = new Float64Array(3),
  proj = new Float64Array(3),
  span = new Float64Array(2);
/** Corners on both sides of the other plane (a triangle that only touches it rests against it). */
const through = (d: Float64Array) =>
  (d[0]! > EPS || d[1]! > EPS || d[2]! > EPS) && (d[0]! < -EPS || d[1]! < -EPS || d[2]! < -EPS);

/**
 * Where triangle `T` (distances `d`) meets the planes' common line, as a stretch along `dir`, into `span`.
 */
function stretch(T: Float64Array, to: number, d: Float64Array, dx: number, dy: number, dz: number): boolean {
  for (let k = 0; k < 3; k++) {
    proj[k] = dx * T[to + k * 3]! + dy * T[to + k * 3 + 1]! + dz * T[to + k * 3 + 2]!;
  }

  let lo = Infinity,
    hi = -Infinity,
    hits = 0;

  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const di = d[i]!,
      dj = d[j]!;

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
  const dx = n1[1]! * n2[2]! - n1[2]! * n2[1]!,
    dy = n1[2]! * n2[0]! - n1[0]! * n2[2]!,
    dz = n1[0]! * n2[1]! - n1[1]! * n2[0]!;
  if (!stretch(A, ao, d1, dx, dy, dz)) return false;

  const a0 = span[0]!,
    a1 = span[1]!;
  if (!stretch(B, bo, d2, dx, dy, dz)) return false;

  const b0 = span[0]!,
    b1 = span[1]!;
  // Overlapping in a single point or along an edge only is not a crossing.
  const tol = 1e-9 * Math.max(1, Math.abs(a0), Math.abs(a1));

  return a0 < b1 - tol && b0 < a1 - tol;
}

/**
 * Distance from `p` to the nearest point of the mesh surface, signed by that triangle's side:
 * positive outside (in front of its face), negative inside, for outward-facing meshes.
 */
export function signedDistance(c: MeshCollider, p: V3): number {
  const px = p[0],
    py = p[1],
    pz = p[2];
  let best = Infinity;
  let sign = 1;
  const T = c.tri;

  const boxDist2 = (n: Node) => {
    const dx = px < n.min[0] ? n.min[0] - px : px > n.max[0] ? px - n.max[0] : 0;
    const dy = py < n.min[1] ? n.min[1] - py : py > n.max[1] ? py - n.max[1] : 0;
    const dz = pz < n.min[2] ? n.min[2] - pz : pz > n.max[2] ? pz - n.max[2] : 0;

    return dx * dx + dy * dy + dz * dz;
  };

  const stack: Node[] = [c.root];

  while (stack.length) {
    const n = stack.pop()!;
    if (boxDist2(n) >= best) continue;

    if (n.left) {
      // Nearer child last, so it is searched first.
      if (boxDist2(n.left) < boxDist2(n.right!)) stack.push(n.right!, n.left);
      else stack.push(n.left, n.right!);

      continue;
    }

    for (let i = n.start; i < n.start + n.count; i++) {
      closestOnTriangle(T, i * 9, px, py, pz);

      const dx = px - near[0]!,
        dy = py - near[1]!,
        dz = pz - near[2]!;
      const d2 = dx * dx + dy * dy + dz * dz;

      if (d2 < best) {
        best = d2;

        const o = i * 9;
        const ux = T[o + 3]! - T[o]!,
          uy = T[o + 4]! - T[o + 1]!,
          uz = T[o + 5]! - T[o + 2]!;
        const vx = T[o + 6]! - T[o]!,
          vy = T[o + 7]! - T[o + 1]!,
          vz = T[o + 8]! - T[o + 2]!;
        sign = (uy * vz - uz * vy) * dx + (uz * vx - ux * vz) * dy + (ux * vy - uy * vx) * dz < 0 ? -1 : 1;
      }
    }
  }

  return Math.sqrt(best) * sign;
}

/**
 * How far a ray from `o` along the unit direction `d` travels before it meets the mesh surface
 * (Infinity when it leaves without). Hits closer than `skip` are ignored, so a ray can start on
 * the surface it leaves.
 */
export function rayDistance(c: MeshCollider, o: V3, d: V3, skip = 1e-6): number {
  const T = c.tri;
  let best = Infinity;
  const inv = [1 / d[0], 1 / d[1], 1 / d[2]];

  const enter = (n: Node): number => {
    let lo = -Infinity;
    let hi = Infinity;

    for (let a = 0; a < 3; a++) {
      let t1 = (n.min[a]! - o[a]!) * inv[a]!;
      let t2 = (n.max[a]! - o[a]!) * inv[a]!;
      if (t1 > t2) [t1, t2] = [t2, t1];
      // A ray along a face of the box gives NaN: count it as inside on that axis.
      if (!Number.isNaN(t1)) lo = Math.max(lo, t1);
      if (!Number.isNaN(t2)) hi = Math.min(hi, t2);
    }

    return hi >= Math.max(lo, 0) ? Math.max(lo, 0) : Infinity;
  };

  const stack: Node[] = [c.root];

  while (stack.length) {
    const n = stack.pop()!;
    if (enter(n) >= best) continue;

    if (n.left) {
      // Nearer child last, so it is searched first and the farther one is often skipped.
      if (enter(n.left) < enter(n.right!)) stack.push(n.right!, n.left);
      else stack.push(n.left, n.right!);

      continue;
    }

    for (let i = n.start; i < n.start + n.count; i++) {
      // Möller–Trumbore.
      const q = i * 9;
      const e1x = T[q + 3]! - T[q]!,
        e1y = T[q + 4]! - T[q + 1]!,
        e1z = T[q + 5]! - T[q + 2]!;
      const e2x = T[q + 6]! - T[q]!,
        e2y = T[q + 7]! - T[q + 1]!,
        e2z = T[q + 8]! - T[q + 2]!;
      const px = d[1] * e2z - d[2] * e2y,
        py = d[2] * e2x - d[0] * e2z,
        pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;

      const tx = o[0] - T[q]!,
        ty = o[1] - T[q + 1]!,
        tz = o[2] - T[q + 2]!;
      const u = (tx * px + ty * py + tz * pz) / det;
      if (u < 0 || u > 1) continue;

      const qx = ty * e1z - tz * e1y,
        qy = tz * e1x - tx * e1z,
        qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
      if (v < 0 || u + v > 1) continue;

      const t = (e2x * qx + e2y * qy + e2z * qz) / det;
      if (t > skip && t < best) best = t;
    }
  }

  return best;
}

const near = new Float64Array(3);

const set = (x: number, y: number, z: number) => {
  near[0] = x;
  near[1] = y;
  near[2] = z;
};

/**
 * Closest point to p on the triangle at `o` in `T`, into `near` (Ericson, Real-Time Collision Detection
 * 5.1.5).
 */
function closestOnTriangle(T: Float64Array, o: number, px: number, py: number, pz: number): void {
  const ax = T[o]!,
    ay = T[o + 1]!,
    az = T[o + 2]!;
  const bx = T[o + 3]!,
    by = T[o + 4]!,
    bz = T[o + 5]!;
  const cx = T[o + 6]!,
    cy = T[o + 7]!,
    cz = T[o + 8]!;
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az;
  const acx = cx - ax,
    acy = cy - ay,
    acz = cz - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az);

  const bpx = px - bx,
    bpy = py - by,
    bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(bx, by, bz);

  const vc = d1 * d4 - d3 * d2;

  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);

    return set(ax + v * abx, ay + v * aby, az + v * abz);
  }

  const cpx = px - cx,
    cpy = py - cy,
    cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(cx, cy, cz);

  const vb = d5 * d2 - d1 * d6;

  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);

    return set(ax + w * acx, ay + w * acy, az + w * acz);
  }

  const va = d3 * d6 - d5 * d4;

  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));

    return set(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz));
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
