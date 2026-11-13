/**
 * Shapes fitted on a scan where it is clicked: a plane, cylinder, cone or sphere grown over the
 * triangles around the click for as far as they stay within a tolerance of it, and the distances
 * and angles between two such shapes. Made for noisy meshes (3D scans), where recognising every
 * surface of the whole part (meshfit.ts) breaks up into small pieces. No OCCT; main thread.
 */
import {
  basis,
  eigen3,
  fitCircle,
  primitiveNormal,
  solveN,
  surfaceDistance,
  unit,
  weld,
  type Primitive,
  type Vec3,
} from "./meshfit.js";

export interface ScanMesh {
  positions: Float64Array;
  /** Vertex indices, three per triangle. */
  triangles: Uint32Array;
  /** Neighbouring triangle across each edge (t*3+e, edge e from corner e to e+1), -1 at a hole. */
  neighbours: Int32Array;
  normals: Float64Array;
  areas: Float64Array;
  centroids: Float64Array;
  diag: number;
}

export type ScanShape = Primitive & {
  triangles: number[];
  area: number;
  /** Largest distance of the shape's vertices from the fitted surface (mm). */
  deviation: number;
  /** Centre of the triangles' area. */
  centroid: Vec3;
  /** Extent along the axis (cylinders and cones). */
  length?: number;
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Welds the corners (9 numbers per triangle) and links every triangle to its neighbours. */
export function scanMesh(corners: ArrayLike<number>): ScanMesh {
  const { positions, triangles } = weld(corners);
  const n = triangles.length / 3;
  const edges = new Map<number, number>();
  const nv = positions.length / 3;
  const neighbours = new Int32Array(n * 3).fill(-1);

  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const [a, b] = [triangles[t * 3 + e]!, triangles[t * 3 + ((e + 1) % 3)]!];
      const key = Math.min(a, b) * nv + Math.max(a, b);
      const other = edges.get(key);

      if (other === undefined) {
        edges.set(key, t * 3 + e);
      } else {
        neighbours[t * 3 + e] = Math.floor(other / 3);
        neighbours[other] = t;
      }
    }
  }

  const normals = new Float64Array(n * 3);
  const areas = new Float64Array(n);
  const centroids = new Float64Array(n * 3);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3]!, positions[i]!);
    hi[i % 3] = Math.max(hi[i % 3]!, positions[i]!);
  }

  const p = (v: number): Vec3 => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];

  for (let t = 0; t < n; t++) {
    const [a, b, c] = [p(triangles[t * 3]!), p(triangles[t * 3 + 1]!), p(triangles[t * 3 + 2]!)];
    const nn = cross(sub(b, a), sub(c, a));
    const l = len(nn);
    areas[t] = l / 2;
    normals.set(l > 0 ? scale(nn, 1 / l) : [0, 0, 0], t * 3);
    centroids.set(scale(add(add(a, b), c), 1 / 3), t * 3);
  }

  return { positions, triangles, neighbours, normals, areas, centroids, diag: len(sub(hi, lo)) };
}

/** The triangle whose centre is nearest to `p`. */
export function nearestTriangle(mesh: ScanMesh, p: Vec3): number {
  let best = -1;
  let bd = Infinity;

  for (let t = 0; t < mesh.areas.length; t++) {
    const d =
      (mesh.centroids[t * 3]! - p[0]) ** 2 +
      (mesh.centroids[t * 3 + 1]! - p[1]) ** 2 +
      (mesh.centroids[t * 3 + 2]! - p[2]) ** 2;

    if (d < bd) {
      bd = d;
      best = t;
    }
  }

  return best;
}

type Kind = Primitive["kind"];

const KINDS: Kind[] = ["plane", "cylinder", "sphere", "cone"];

/**
 * The shape the surface around triangle `seed` follows within `tol`: each kind is grown from a
 * small patch round the seed and refitted until it stops growing; the simplest kind that covers
 * nearly as much as the best one wins (a plane over a huge flat cylinder, say).
 */
export function shapeAt(mesh: ScanMesh, seed: number, tol: number, kinds: Kind[] = KINDS): ScanShape | null {
  if (seed < 0) return null;

  // Curved kinds need a wider patch: on a few triangles their axis is barely defined.
  const [small, wide] = [seedPatch(mesh, seed, 40), seedPatch(mesh, seed, 160)];
  const found: ScanShape[] = [];

  for (const kind of kinds) {
    const s = grow(mesh, seed, kind === "plane" ? small : wide, kind, tol);
    if (s) found.push(s);
  }

  if (!found.length) return null;

  const most = Math.max(...found.map((s) => s.area));

  return found.find((s) => s.area >= most * 0.85)!;
}

/** About `size` triangles round the seed, not across sharp edges. */
function seedPatch(mesh: ScanMesh, seed: number, size: number): number[] {
  const out = [seed];
  const seen = new Set(out);

  for (let i = 0; i < out.length && out.length < size; i++) {
    const t = out[i]!;

    for (let e = 0; e < 3; e++) {
      const u = mesh.neighbours[t * 3 + e]!;
      if (u < 0 || seen.has(u)) continue;

      seen.add(u);
      if (dot(normal(mesh, t), normal(mesh, u)) > Math.cos((50 * Math.PI) / 180)) out.push(u);
    }
  }

  return out;
}

function grow(mesh: ScanMesh, seed: number, patch: number[], kind: Kind, tol: number): ScanShape | null {
  let region = patch;
  let surface = fit(mesh, region, kind);

  for (let iter = 0; iter < 8 && surface; iter++) {
    const next = flood(mesh, seed, surface, tol);
    if (next.length < 3) return null;

    const same = next.length === region.length;
    region = next;
    surface = fit(mesh, region, kind) ?? surface;
    if (same) break;
  }

  if (!surface || !valid(surface, mesh.diag)) return null;

  // The last fit must still hold the region it was fitted on.
  let deviation = 0;

  for (const t of region) {
    for (let k = 0; k < 3; k++) {
      deviation = Math.max(
        deviation,
        Math.abs(surfaceDistance(vertex(mesh, mesh.triangles[t * 3 + k]!), surface)),
      );
    }
  }

  if (deviation > tol * 1.5) return null;

  let area = 0;
  let c: Vec3 = [0, 0, 0];

  for (const t of region) {
    area += mesh.areas[t]!;
    c = add(c, scale(centroid(mesh, t), mesh.areas[t]!));
  }

  const shape: ScanShape = {
    ...surface,
    triangles: region,
    area,
    deviation,
    centroid: scale(c, 1 / (area || 1)),
  };

  if (surface.kind === "cylinder" || surface.kind === "cone") {
    const base = surface.kind === "cylinder" ? surface.origin : surface.apex;
    let [lo, hi] = [Infinity, -Infinity];

    for (const t of region) {
      for (let k = 0; k < 3; k++) {
        const h = dot(sub(vertex(mesh, mesh.triangles[t * 3 + k]!), base), surface.axis);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }

    shape.length = hi - lo;
  }

  return shape;
}

/** Triangles connected to the seed whose corners lie within tol of the surface and that face like it. */
function flood(mesh: ScanMesh, seed: number, primitive: Primitive, tol: number): number[] {
  const fits = (t: number) => {
    for (let k = 0; k < 3; k++) {
      if (Math.abs(surfaceDistance(vertex(mesh, mesh.triangles[t * 3 + k]!), primitive)) > tol) return false;
    }

    return (
      Math.abs(dot(normal(mesh, t), primitiveNormal(centroid(mesh, t), primitive))) >
      Math.cos((30 * Math.PI) / 180)
    );
  };

  if (!fits(seed)) return [];

  const out = [seed];
  const seen = new Uint8Array(mesh.areas.length);
  seen[seed] = 1;

  for (let i = 0; i < out.length; i++) {
    const t = out[i]!;

    for (let e = 0; e < 3; e++) {
      const u = mesh.neighbours[t * 3 + e]!;
      if (u < 0 || seen[u]) continue;

      seen[u] = 1;
      if (fits(u)) out.push(u);
    }
  }

  return out;
}

function valid(primitive: Primitive, diag: number): boolean {
  if (primitive.kind === "cylinder" || primitive.kind === "sphere") {
    return primitive.radius > 0 && primitive.radius < diag * 2;
  }

  if (primitive.kind === "cone") {
    return primitive.halfAngle > (3 * Math.PI) / 180 && primitive.halfAngle < (87 * Math.PI) / 180;
  }

  return true;
}

/** Least squares fit of one kind to the triangles' corners (and, for the axis, their normals). */
function fit(mesh: ScanMesh, tris: number[], kind: Kind): Primitive | null {
  const vs = [
    ...new Set(
      tris.flatMap((t) => [mesh.triangles[t * 3]!, mesh.triangles[t * 3 + 1]!, mesh.triangles[t * 3 + 2]!]),
    ),
  ].map((v) => vertex(mesh, v));
  if (vs.length < 4) return null;

  const mean = scale(vs.reduce(add, [0, 0, 0] as Vec3), 1 / vs.length);

  if (kind === "plane") {
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];

    for (const p of vs) {
      const d = sub(p, mean);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j]! += d[i]! * d[j]!;
    }

    let up = smallest(eigen3(cov));
    // Keep it facing the way the triangles do.
    const avg = tris.reduce((s, t) => add(s, scale(normal(mesh, t), mesh.areas[t]!)), [0, 0, 0] as Vec3);
    if (dot(avg, up) < 0) up = scale(up, -1);

    return { kind: "plane", origin: mean, normal: up };
  }

  if (kind === "sphere") {
    // x² + y² + z² + Dx + Ey + Fz + G = 0, centred on the mean for conditioning.
    const a = new Array<number>(16).fill(0);
    const b = [0, 0, 0, 0];

    for (const p of vs) {
      const d = sub(p, mean);
      const row = [d[0], d[1], d[2], 1];
      const rhs = -(d[0] ** 2 + d[1] ** 2 + d[2] ** 2);

      for (let i = 0; i < 4; i++) {
        b[i]! += row[i]! * rhs;
        for (let j = 0; j < 4; j++) a[i * 4 + j]! += row[i]! * row[j]!;
      }
    }

    const x = solveN(a, b, 4);
    if (!x) return null;

    const c: Vec3 = [-x[0]! / 2, -x[1]! / 2, -x[2]! / 2];
    const r2 = dot(c, c) - x[3]!;
    if (!(r2 > 0)) return null;

    return { kind: "sphere", center: add(mean, c), radius: Math.sqrt(r2) };
  }

  // Cylinders and cones: the axis is the direction the normals vary least along.
  const ns = tris.map((t) => normal(mesh, t));
  const w = tris.map((t) => mesh.areas[t]!);
  const nMean = scale(
    ns.reduce((s, n, i) => add(s, scale(n, w[i]!)), [0, 0, 0] as Vec3),
    1 / (w.reduce((s, v) => s + v, 0) || 1),
  );
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  ns.forEach((n, i) => {
    const d = kind === "cylinder" ? n : sub(n, nMean);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r * 3 + c]! += w[i]! * d[r]! * d[c]!;
  });

  const axis = smallest(eigen3(cov));

  if (kind === "cylinder") {
    const [e1, e2] = basis(axis);
    const circle = fitCircle(vs.map((p) => [dot(sub(p, mean), e1), dot(sub(p, mean), e2)]));
    if (!circle) return null;

    return {
      kind: "cylinder",
      origin: add(mean, add(scale(e1, circle.cx), scale(e2, circle.cy))),
      axis,
      radius: circle.r,
    };
  }

  // Apex: the point nearest to every triangle's tangent plane.
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const B = [0, 0, 0];
  tris.forEach((t, i) => {
    const n = ns[i]!;
    const c = centroid(mesh, t);
    const nc = dot(n, c);

    for (let r = 0; r < 3; r++) {
      B[r]! += w[i]! * n[r]! * nc;
      for (let k = 0; k < 3; k++) A[r * 3 + k]! += w[i]! * n[r]! * n[k]!;
    }
  });

  const x = solveN(A, B, 3);
  if (!x) return null;

  const apex: Vec3 = [x[0]!, x[1]!, x[2]!];
  // The axis points from the apex into the cone.
  const into = dot(sub(mean, apex), axis) < 0 ? scale(axis, -1) : axis;
  let angle = 0;

  for (const p of vs) {
    const d = sub(p, apex);
    angle += Math.acos(Math.min(1, Math.max(-1, dot(d, into) / (len(d) || 1))));
  }

  return refineCone({ kind: "cone", apex, axis: into, halfAngle: angle / vs.length }, vs);
}

/**
 * The tangent planes of a small noisy patch place the apex only roughly: damped Gauss-Newton on
 * the points' distances from the cone (apex, axis and angle; the axis is normalised every step).
 */
function refineCone(
  c: Extract<Primitive, { kind: "cone" }>,
  vs: Vec3[],
): Extract<Primitive, { kind: "cone" }> {
  const pts = vs.length > 150 ? vs.filter((_, i) => i % Math.ceil(vs.length / 150) === 0) : vs;
  const toCone = (x: number[]): Extract<Primitive, { kind: "cone" }> => ({
    kind: "cone",
    apex: [x[0]!, x[1]!, x[2]!],
    axis: unit([x[3]!, x[4]!, x[5]!]),
    halfAngle: x[6]!,
  });
  const cost = (x: number[]) => pts.reduce((sum, p) => sum + surfaceDistance(p, toCone(x)) ** 2, 0);
  let x = [...c.apex, ...c.axis, c.halfAngle];
  let current = cost(x);
  let lambda = 1e-3;

  for (let iter = 0; iter < 30; iter++) {
    const r = pts.map((p) => surfaceDistance(p, toCone(x)));
    const J = pts.map(() => new Array<number>(7).fill(0));

    for (let k = 0; k < 7; k++) {
      const h = k === 6 ? 1e-6 : 1e-6 * Math.max(1, Math.abs(x[k]!));
      const xk = [...x];
      xk[k]! += h;
      pts.forEach((p, i) => (J[i]![k] = (surfaceDistance(p, toCone(xk)) - r[i]!) / h));
    }

    const A = new Array<number>(49).fill(0);
    const b = new Array<number>(7).fill(0);
    pts.forEach((_, i) => {
      for (let a = 0; a < 7; a++) {
        b[a]! -= J[i]![a]! * r[i]!;
        for (let c2 = 0; c2 < 7; c2++) A[a * 7 + c2]! += J[i]![a]! * J[i]![c2]!;
      }
    });
    for (let a = 0; a < 7; a++) A[a * 7 + a]! += lambda * (A[a * 7 + a]! || 1);

    const step = solveN(A, b, 7);
    if (!step) break;

    const next = x.map((v, k) => v + step[k]!);
    const axis = unit([next[3]!, next[4]!, next[5]!]);
    next.splice(3, 3, ...axis);

    const nextCost = cost(next);

    if (nextCost < current) {
      const done = current - nextCost < current * 1e-9;
      x = next;
      current = nextCost;
      lambda = Math.max(1e-9, lambda / 3);
      if (done) break;
    } else {
      lambda *= 4;
    }
  }

  return toCone(x);
}

function smallest(e: { values: number[]; vectors: Vec3[] }): Vec3 {
  let k = 0;
  for (let i = 1; i < 3; i++) if (e.values[i]! < e.values[k]!) k = i;

  return unit(e.vectors[k]!);
}

const vertex = (mesh: ScanMesh, v: number): Vec3 => [
  mesh.positions[v * 3]!,
  mesh.positions[v * 3 + 1]!,
  mesh.positions[v * 3 + 2]!,
];
const centroid = (mesh: ScanMesh, t: number): Vec3 => [
  mesh.centroids[t * 3]!,
  mesh.centroids[t * 3 + 1]!,
  mesh.centroids[t * 3 + 2]!,
];
const normal = (mesh: ScanMesh, t: number): Vec3 => [
  mesh.normals[t * 3]!,
  mesh.normals[t * 3 + 1]!,
  mesh.normals[t * 3 + 2]!,
];

// ---------------------------------------------------------------- measuring

export type ShapeValue = { label: string; value: number; unit: "mm" | "mm²" | "°" };

/** What one fitted shape measures. */
export function shapeValues(s: ScanShape): ShapeValue[] {
  const out: ShapeValue[] = [];

  if (s.kind === "cylinder" || s.kind === "sphere") {
    out.push({ label: "Diameter", value: s.radius * 2, unit: "mm" });
  }

  if (s.kind === "cone") out.push({ label: "Cone angle", value: (s.halfAngle * 360) / Math.PI, unit: "°" });
  if (s.length !== undefined) out.push({ label: "Length", value: s.length, unit: "mm" });
  if (s.kind === "plane") out.push({ label: "Area", value: s.area, unit: "mm²" });

  out.push({ label: s.kind === "plane" ? "Flatness" : "Form deviation", value: s.deviation * 2, unit: "mm" });

  return out;
}

/** Distances and angles between two fitted shapes. */
export function compareShapes(a: ScanShape, b: ScanShape): ShapeValue[] {
  // Planes first, then axes, then spheres: fewer cases to handle.
  const rank = (s: ScanShape) => (s.kind === "plane" ? 0 : s.kind === "sphere" ? 2 : 1);
  if (rank(b) < rank(a)) [a, b] = [b, a];

  const out: ShapeValue[] = [];
  const deg = (r: number) => (r * 180) / Math.PI;
  const angle = (u: Vec3, v: Vec3) => Math.acos(Math.min(1, Math.abs(dot(u, v))));
  const parallel = (rad: number) => rad < (1 * Math.PI) / 180;
  const axisOf = (s: ScanShape): { p: Vec3; d: Vec3 } | null =>
    s.kind === "cylinder" ? { p: s.origin, d: s.axis } : s.kind === "cone" ? { p: s.apex, d: s.axis } : null;
  const point = (s: ScanShape): Vec3 => (s.kind === "sphere" ? s.center : s.centroid);
  const toPlane = (q: Vec3, pl: Extract<ScanShape, { kind: "plane" }>) =>
    Math.abs(dot(sub(q, pl.origin), pl.normal));
  const toLine = (q: Vec3, l: { p: Vec3; d: Vec3 }) => len(cross(sub(q, l.p), l.d));

  if (a.kind === "plane" && b.kind === "plane") {
    const t = angle(a.normal, b.normal);
    out.push({ label: "Angle", value: deg(t), unit: "°" });

    if (parallel(t)) {
      out.push({
        label: "Distance",
        value: (toPlane(b.centroid, a) + toPlane(a.centroid, b)) / 2,
        unit: "mm",
      });
    }
  } else if (a.kind === "plane") {
    const l = axisOf(b);

    if (l) {
      const t = Math.PI / 2 - angle(a.normal, l.d);
      out.push({ label: "Angle to axis", value: deg(t), unit: "°" });

      // An axis along the plane: how far it runs from it (a hole's centre above a face).
      if (parallel(t)) {
        out.push({ label: "Distance to axis", value: toPlane(onAxis(l, b.centroid), a), unit: "mm" });
      }
    } else {
      out.push({ label: "Distance to centre", value: toPlane(point(b), a), unit: "mm" });
    }
  } else if (axisOf(a) && axisOf(b)) {
    const [la, lb] = [axisOf(a)!, axisOf(b)!];
    const t = angle(la.d, lb.d);
    out.push({ label: "Angle between axes", value: deg(t), unit: "°" });

    if (parallel(t)) {
      out.push({ label: "Distance between axes", value: toLine(lb.p, la), unit: "mm" });
    } else {
      const n = unit(cross(la.d, lb.d));
      out.push({
        label: "Closest distance between axes",
        value: Math.abs(dot(sub(lb.p, la.p), n)),
        unit: "mm",
      });
    }
  } else if (axisOf(a)) {
    out.push({ label: "Distance centre to axis", value: toLine(point(b), axisOf(a)!), unit: "mm" });
  } else {
    out.push({ label: "Distance between centres", value: len(sub(point(a), point(b))), unit: "mm" });
  }

  return out;
}

/** The point on the axis level with q. */
function onAxis(l: { p: Vec3; d: Vec3 }, q: Vec3): Vec3 {
  return add(l.p, scale(l.d, dot(sub(q, l.p), l.d)));
}
