/**
 * Bending parts: round an axis (bend), onto a cylinder (wrap) or rolled up into a flat spiral.
 * The deformation maps every point of the part; straight edges along the part's length become
 * curves, so the triangles are cut across the length, finely enough that they follow the curved
 * shape within a tolerance. A cut point is shared by both triangles of an edge, so a closed
 * surface stays closed. No OCCT.
 *
 * Local coordinates of a part: x along its length (L), h across its thickness (O, pointing away
 * from the centre of the bend), y along the axis (A). The mapping keeps y and lays (x, h) onto
 * circles (bend, wrap) or an Archimedean spiral (spiral) in the L–O plane.
 */

export type V3 = [number, number, number];
export type BendMode = "bend" | "wrap" | "spiral";

export interface BendOptions {
  mode: BendMode;
  /** Axis direction (need not be unit length). */
  axis: V3;
  /** bend: total angle, degrees. */
  angle?: number;
  /** wrap: cylinder radius; spiral: inner radius; bend: radius of the middle (when no angle). */
  radius?: number;
  /** spiral: gap between turns, mm (default 1). */
  gap?: number;
  flip?: boolean;
  reverse?: boolean;
  /** Largest deviation of the triangles from the exact shape, mm (default from the size). */
  tolerance?: number;
}

/** What a bend comes to: the numbers shown to the user. */
export interface BendInfo {
  mode: BendMode;
  /** Length along the part (L) and thickness (O) and width (A), mm. */
  length: number;
  thickness: number;
  width: number;
  /** bend: radius of the middle; wrap: cylinder; spiral: inner radius. */
  radius: number;
  /** Angle swept, degrees (spiral: all turns together). */
  angle: number;
  /** spiral: number of turns, the gap and the outer radius. */
  turns: number;
  gap: number;
  outerRadius: number;
  /** Ends of a bend or wrap meet (a closed ring). */
  closed: boolean;
  /** Centre of the bend or coil (on the axis, in the middle of the part's width), world mm. */
  centre: V3;
  /** From the centre towards the middle of the part (the radius direction there). */
  outward: V3;
  axis: V3;
}

export class BendError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Gap between turns below which printed turns tend to fuse. */
export const MIN_PRINT_GAP = 0.3;
export const DEFAULT_GAP = 1;

/** A part's frame for bending: length, outward and axis directions and its extents along them. */
export interface BendFrame {
  L: V3;
  O: V3;
  A: V3;
  /** Lowest coordinates along L and O (points are measured from there). */
  x0: number;
  h0: number;
  y0: number;
  length: number;
  thickness: number;
  width: number;
}

/**
 * The frame of points (xyz triples): the length runs along the longest extent across the axis
 * (measured along the world axes laid across it); the centre is on the A × L side, or the other
 * with `flip`; `reverse` runs the length the other way (a spiral starts at the other end).
 */
export function bendFrame(points: ArrayLike<number>, axis: V3, flip = false, reverse = false): BendFrame {
  if (!(Math.hypot(...axis) > 0)) throw new BendError("the bend axis has no direction");
  const A = norm(axis);
  const extent = (d: V3) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      const v = points[i]! * d[0] + points[i + 1]! * d[1] + points[i + 2]! * d[2];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { lo, hi };
  };
  let L0: V3 | null = null;
  let best = -1;
  for (const w of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]) {
    const p: V3 = [w[0] - A[0] * dot(w, A), w[1] - A[1] * dot(w, A), w[2] - A[2] * dot(w, A)];
    if (Math.hypot(...p) < 0.3) continue;
    const d = norm(p);
    const e = extent(d);
    if (e.hi - e.lo > best + 1e-9) {
      best = e.hi - e.lo;
      L0 = d;
    }
  }
  const centreSide = cross(A, L0!);
  const O: V3 = flip ? centreSide : [-centreSide[0], -centreSide[1], -centreSide[2]];
  const L: V3 = reverse ? [-L0![0], -L0![1], -L0![2]] : L0!;
  const ex = extent(L), eh = extent(O), ey = extent(A);
  return { L, O, A, x0: ex.lo, h0: eh.lo, y0: ey.lo, length: ex.hi - ex.lo, thickness: eh.hi - eh.lo, width: ey.hi - ey.lo };
}

/** Length of an Archimedean spiral ρ = ρ0 + aφ from φ = 0 to `phi`. */
export function spiralLength(rho0: number, a: number, phi: number): number {
  const F = (r: number) => (r * Math.sqrt(r * r + a * a) + a * a * Math.asinh(r / a)) / (2 * a);
  return F(rho0 + a * phi) - F(rho0);
}

/** The angle at which the spiral ρ = ρ0 + aφ has length s (Newton from above; the length is convex in φ). */
export function spiralAngle(rho0: number, a: number, s: number): number {
  if (s <= 0) return 0;
  let phi = s / Math.sqrt(rho0 * rho0 + a * a);
  for (let i = 0; i < 60; i++) {
    const r = rho0 + a * phi;
    const step = (spiralLength(rho0, a, phi) - s) / Math.sqrt(r * r + a * a);
    phi -= step;
    if (Math.abs(step) < 1e-13 * (1 + phi)) break;
  }
  return phi;
}

/** A bend set up for a part: maps local (x, h) to the L–O plane and reports what it comes to. */
export interface Bender {
  frame: BendFrame;
  info: BendInfo;
  warnings: string[];
  /** Local coordinates (x along the length from the start, h from the inner face, y along the axis). */
  local(p: V3): V3;
  /** World position of local coordinates. */
  map(x: number, h: number, y: number): V3;
  /** Angle (radians) at which a point x along the length ends up. */
  angleAt(x: number): number;
  /** How far along the length, from x, a straight piece stays within `tol` of the bent shape. */
  step(x: number, tol: number): number;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function makeBender(points: ArrayLike<number>, o: BendOptions): Bender {
  const frame = bendFrame(points, o.axis, o.flip, o.reverse);
  const { L, O, A, x0, h0, y0, length: len, thickness: t, width } = frame;
  if (!(len > 1e-6)) throw new BendError("the part has no length across the bend axis", "pick an axis along the part's width, not its length");
  if (!(t > 1e-6)) throw new BendError("the part has no thickness");
  const warnings: string[] = [];
  const info: BendInfo = { mode: o.mode, length: len, thickness: t, width, radius: 0, angle: 0, turns: 0, gap: 0, outerRadius: 0, closed: false, centre: [0, 0, 0], outward: O, axis: A };
  const world = (u: number, v: number, y: number): V3 => {
    const pu = u + x0, pv = v + h0;
    return [pu * L[0] + pv * O[0] + y * A[0], pu * L[1] + pv * O[1] + y * A[1], pu * L[2] + pv * O[2] + y * A[2]];
  };
  // (x, h) → (u, v) in the L–O plane, measured from the part's lowest corner.
  let toPlane: (x: number, h: number) => [number, number];
  let angleAt: (x: number) => number;
  /** Rate of turning (radians per mm along the length) and the outermost radius at x. */
  let turning: (x: number) => { rate: number; outer: number };
  const full = 2 * Math.PI;
  if (o.mode === "bend" || o.mode === "wrap") {
    let R: number;
    let href: number;
    if (o.mode === "bend") {
      href = t / 2;
      if (o.angle !== undefined) {
        const phi = (o.angle * Math.PI) / 180;
        if (!(phi > 0)) throw new BendError("the bend angle must be greater than zero", "use Flip to bend the other way");
        if (phi > full * (1 + 1e-9)) throw new BendError("a bend goes at most once round (360°)", "roll the part into a spiral instead");
        R = len / phi;
      } else R = o.radius ?? NaN;
      if (!(R > t / 2)) throw new BendError(`the bend radius (${fmt(R)} mm) must be larger than half the thickness (${fmt(t / 2)} mm)`, "bend by a smaller angle or use a larger radius");
    } else {
      href = 0;
      R = o.radius ?? NaN;
      if (!(R > 0)) throw new BendError("the cylinder's radius must be greater than zero");
    }
    let sweep = len / R;
    if (sweep > full * (1 + 1e-6))
      throw new BendError(
        `the part (${fmt(len)} mm long) is longer than the ${o.mode === "wrap" ? "cylinder's circumference" : "circle"} (${fmt(full * R)} mm) and would overlap itself`,
        `use a radius of at least ${fmt(len / full)} mm, or roll it into a spiral`,
      );
    // Ends that (nearly) meet are made to meet exactly and are joined: a closed ring.
    if (sweep > full * (1 - 1e-3)) {
      R = len / full;
      sweep = full;
      info.closed = true;
    }
    info.radius = R;
    info.angle = (sweep * 180) / Math.PI;
    info.outerRadius = R + (t - href);
    const cu = len / 2, cv = href - R;
    info.centre = world(cu, cv, y0 + width / 2);
    angleAt = (x) => (x - len / 2) / R;
    turning = () => ({ rate: 1 / R, outer: R + t - href });
    toPlane = (x, h) => {
      const th = (x - len / 2) / R;
      const rho = R + (h - href);
      return [cu + rho * Math.sin(th), cv + rho * Math.cos(th)];
    };
  } else {
    const r0 = o.radius ?? NaN;
    const gap = o.gap ?? DEFAULT_GAP;
    if (!(r0 > 0)) throw new BendError("the spiral's inner radius must be greater than zero");
    if (!(gap > 0))
      throw new BendError(
        `the turns would ${gap < 0 ? "overlap" : "touch"}: the gap between them must be more than 0 mm (it is ${fmt(gap)} mm)`,
        `pitch = thickness ${fmt(t)} mm + gap; try a gap of ${DEFAULT_GAP} mm`,
      );
    if (gap < MIN_PRINT_GAP) warnings.push(`the turns are only ${fmt(gap)} mm apart and may fuse when printed; ${MIN_PRINT_GAP} mm or more keeps them apart`);
    const a = (t + gap) / full;
    // The middle of the strip starts so that its inner face starts exactly at the inner radius
    // (the spiral's slope tilts the inner face's start a little off the radial line).
    let rho0 = r0 + t / 2;
    for (let i = 0; i < 30; i++) {
      const q = Math.hypot(rho0, a);
      rho0 += r0 - Math.hypot((a * t) / (2 * q), rho0 - (rho0 * t) / (2 * q));
    }
    const phiEnd = spiralAngle(rho0, a, len);
    info.radius = r0;
    info.gap = gap;
    info.angle = (phiEnd * 180) / Math.PI;
    info.turns = phiEnd / full;
    info.outerRadius = rho0 + a * phiEnd + t / 2;
    // The coil's centre sits where the middle of the strip was.
    const cu = len / 2, cv = t / 2;
    info.centre = world(cu, cv, y0 + width / 2);
    angleAt = (x) => spiralAngle(rho0, a, x);
    turning = (x) => {
      const rho = rho0 + a * spiralAngle(rho0, a, x);
      return { rate: 1 / Math.hypot(rho, a), outer: rho + t / 2 };
    };
    toPlane = (x, h) => {
      const phi = spiralAngle(rho0, a, x);
      const rho = rho0 + a * phi;
      const s = Math.sin(phi), c = Math.cos(phi);
      // Tangent (a sinφ + ρ cosφ, a cosφ − ρ sinφ); the outward normal is it turned by +90°.
      const tu = a * s + rho * c, tv = a * c - rho * s;
      const k = (h - t / 2) / Math.hypot(tu, tv);
      return [cu + rho * s - tv * k, cv + rho * c + tu * k];
    };
  }
  return {
    frame,
    info,
    warnings,
    local: (p) => [dot(p, L) - x0, dot(p, O) - h0, dot(p, A)],
    map: (x, h, y) => {
      const [u, v] = toPlane(x, h);
      return world(u, v, y);
    },
    angleAt,
    step: (x, tol) => {
      const { rate, outer } = turning(x);
      // A chord over an angle Δθ on radius ρ strays ρΔθ²/8 from the arc.
      return Math.min(Math.PI / 16, Math.sqrt((8 * tol) / outer)) / rate;
    },
  };
}

/** Default tolerance from the size of a part: 0.01–0.1 mm, finer on small parts. */
export function defaultBendTolerance(diag: number): number {
  return Math.min(0.1, Math.max(0.01, diag * 5e-5));
}

/** Most triangles a bend may make before asking for a coarser tolerance. */
export const MAX_BEND_TRIANGLES = 1_500_000;

export interface BentMesh {
  /** Triangle corners (9 numbers per triangle), wound outwards. */
  corners: Float32Array;
  info: BendInfo;
  warnings: string[];
  triangles: { before: number; after: number };
}

/**
 * Bends closed triangle meshes (corners, 9 numbers per triangle; one per part, bent together as
 * one piece). Each result is closed and wound outwards if its input was closed.
 */
export function bendMeshes(meshes: ArrayLike<number>[], o: BendOptions): BentMesh[] {
  const all: number[] = [];
  for (const m of meshes) for (let i = 0; i < m.length; i++) all.push(m[i]!);
  const bender = makeBender(all, o);
  let lo = Infinity, hi = -Infinity;
  for (const v of all) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const diag = Math.hypot(bender.frame.length, bender.frame.thickness, bender.frame.width);
  const tol = o.tolerance ?? defaultBendTolerance(diag);
  if (!(tol > 0)) throw new BendError("the tolerance must be greater than zero");
  let budget = MAX_BEND_TRIANGLES;
  return meshes.map((corners) => {
    const q = Math.max(1e-9, (hi - lo) * 1e-7);
    const welded = weldClosed(corners, q);
    const out = refineAndMap(welded.positions, welded.triangles, bender, tol, budget);
    // Welded again and checked: closed, every edge shared by two triangles, wound outwards. A
    // ring's two ends now lie on each other and are welded together (their faces were dropped).
    let checked;
    try {
      checked = weldClosed(out.corners, q);
    } catch {
      throw out.ring
        ? new BendError("the ends meet but their shapes differ, so they cannot be joined into a ring", "make the radius a little larger so the ends stay apart")
        : new BendError("bending left the surface open", "try a smaller tolerance");
    }
    const c = new Float32Array(checked.triangles.length * 3);
    checked.triangles.forEach((v, i) => c.set(checked.positions.slice(v * 3, v * 3 + 3), i * 3));
    out.corners = c;
    budget -= out.corners.length / 9;
    return { corners: out.corners, info: bender.info, warnings: bender.warnings, triangles: { before: corners.length / 9, after: out.corners.length / 9 } };
  });
}

/** Indexed, consistently wound (outwards) closed mesh from corners; throws when it is not closed. */
export function weldClosed(corners: ArrayLike<number>, q: number): { positions: number[]; triangles: number[] } {
  const index = new Map<string, number>();
  const positions: number[] = [];
  const triangles: number[] = [];
  for (let c = 0; c < corners.length; c += 9) {
    const ids: number[] = [];
    for (let k = 0; k < 9; k += 3) {
      const x = corners[c + k]!, y = corners[c + k + 1]!, z = corners[c + k + 2]!;
      const key = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
      let v = index.get(key);
      if (v === undefined) {
        v = positions.length / 3;
        index.set(key, v);
        positions.push(x, y, z);
      }
      ids.push(v);
    }
    if (ids[0] !== ids[1] && ids[1] !== ids[2] && ids[0] !== ids[2]) triangles.push(ids[0]!, ids[1]!, ids[2]!);
  }
  const n = triangles.length / 3;
  if (!n) throw new BendError("the part has no surface to bend");
  // Each edge must be shared by exactly two triangles.
  const K = 2 ** 26;
  const key = (a: number, b: number) => (a < b ? a * K + b : b * K + a);
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 3; k++) {
      const e = key(triangles[t * 3 + k]!, triangles[t * 3 + ((k + 1) % 3)]!);
      const l = edgeTris.get(e);
      if (l) l.push(t);
      else edgeTris.set(e, [t]);
    }
  for (const l of edgeTris.values())
    if (l.length !== 2) throw new BendError("the part's surface is not closed, so it cannot be bent as a solid", "repair the mesh first (close its holes)");
  // Wind every triangle like its neighbours (flood fill), then outwards (positive volume per piece).
  const seen = new Uint8Array(n);
  const has = (t: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (triangles[t * 3 + k] === a && triangles[t * 3 + ((k + 1) % 3)] === b) return true;
    return false;
  };
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    seen[start] = 1;
    const piece = [start];
    for (let i = 0; i < piece.length; i++) {
      const t = piece[i]!;
      for (let k = 0; k < 3; k++) {
        const a = triangles[t * 3 + k]!, b = triangles[t * 3 + ((k + 1) % 3)]!;
        for (const u of edgeTris.get(key(a, b))!) {
          if (u === t || seen[u]) continue;
          seen[u] = 1;
          // A neighbour wound the same way runs the shared edge the other way round.
          if (has(u, a, b)) {
            const tmp = triangles[u * 3 + 1]!;
            triangles[u * 3 + 1] = triangles[u * 3 + 2]!;
            triangles[u * 3 + 2] = tmp;
          }
          piece.push(u);
        }
      }
    }
    let vol = 0;
    for (const t of piece) {
      const [a, b, c] = [triangles[t * 3]! * 3, triangles[t * 3 + 1]! * 3, triangles[t * 3 + 2]! * 3];
      vol +=
        positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!) -
        positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!) +
        positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
    }
    if (vol < 0)
      for (const t of piece) {
        const tmp = triangles[t * 3 + 1]!;
        triangles[t * 3 + 1] = triangles[t * 3 + 2]!;
        triangles[t * 3 + 2] = tmp;
      }
  }
  return { positions, triangles };
}

/**
 * Cuts the triangles across the length at planes close enough together that, bent, each piece
 * stays within `tol` of the exact shape (and turns by at most 1/32 of a circle), then maps every
 * vertex. A cut point on an edge is made once and shared by both triangles of the edge, so the
 * surface stays closed.
 */
function refineAndMap(world: number[], tris: number[], bender: Bender, tol: number, budget: number): { corners: Float32Array; ring: boolean } {
  const pos: number[] = [];
  for (let i = 0; i < world.length; i += 3) pos.push(...bender.local([world[i]!, world[i + 1]!, world[i + 2]!]));
  const len = bender.frame.length;
  // A closed ring drops the faces at both ends (they end up on each other) when this part has both.
  const capEps = 1e-6 * Math.max(1, len);
  const capOf = (t: number) => {
    const xs = [pos[tris[t]! * 3]!, pos[tris[t + 1]! * 3]!, pos[tris[t + 2]! * 3]!];
    return xs.every((x) => x < capEps) ? -1 : xs.every((x) => x > len - capEps) ? 1 : 0;
  };
  let ring = false;
  if (bender.info.closed) {
    let start = false, end = false;
    for (let t = 0; t < tris.length; t += 3) {
      const c = capOf(t);
      if (c < 0) start = true;
      if (c > 0) end = true;
    }
    ring = start && end;
  }
  const cuts: number[] = [];
  for (let x = bender.step(0, tol); x < len - 1e-6 * len; x += bender.step(x, tol)) {
    cuts.push(x);
    if (cuts.length > budget / 4) throw new BendError("bending this finely needs too many triangles", "raise the tolerance");
  }
  const eps = 1e-7 * Math.max(1, len);
  const cache = new Map<string, number>();
  /** The point where edge a–b crosses cut k (made once per edge and cut). */
  const cross = (a: number, b: number, k: number): number => {
    const key = a < b ? `${a},${b},${k}` : `${b},${a},${k}`;
    let v = cache.get(key);
    if (v === undefined) {
      const xa = pos[a * 3]!, xb = pos[b * 3]!;
      const s = (cuts[k]! - xa) / (xb - xa);
      v = pos.length / 3;
      pos.push(cuts[k]!, pos[a * 3 + 1]! + s * (pos[b * 3 + 1]! - pos[a * 3 + 1]!), pos[a * 3 + 2]! + s * (pos[b * 3 + 2]! - pos[a * 3 + 2]!));
      cache.set(key, v);
    }
    return v;
  };
  const out: number[] = [];
  const fan = (poly: number[]) => {
    for (let i = 1; i + 1 < poly.length; i++) out.push(poly[0]!, poly[i]!, poly[i + 1]!);
  };
  /** First cut index above x (binary search). */
  const firstAbove = (x: number) => {
    let lo = 0, hi = cuts.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cuts[m]! <= x) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  for (let t = 0; t < tris.length; t += 3) {
    if (ring && capOf(t)) continue;
    let poly = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const xs = poly.map((v) => pos[v * 3]!);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    for (let k = firstAbove(lo + eps); k < cuts.length && cuts[k]! < hi - eps; k++) {
      const c = cuts[k]!;
      // Split the (convex) polygon at x = c: the part below is done, the part above goes on.
      const below: number[] = [];
      const above: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
        const xa = pos[a * 3]! - c, xb = pos[b * 3]! - c;
        const sa = xa < -eps ? -1 : xa > eps ? 1 : 0;
        const sb = xb < -eps ? -1 : xb > eps ? 1 : 0;
        if (sa <= 0) below.push(a);
        if (sa >= 0) above.push(a);
        if (sa * sb < 0) {
          const m = cross(a, b, k);
          below.push(m);
          above.push(m);
        }
      }
      if (below.length >= 3) fan(below);
      poly = above;
      if (poly.length < 3) break;
    }
    if (poly.length >= 3) fan(poly);
    if (out.length / 3 > budget) throw new BendError("bending this finely needs too many triangles", "raise the tolerance");
  }
  const mapped: V3[] = [];
  for (let v = 0; v < pos.length / 3; v++) mapped.push(bender.map(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!));
  const res = new Float32Array(out.length * 3);
  for (let i = 0; i < out.length; i++) res.set(mapped[out[i]!]!, i * 3);
  return { corners: res, ring };
}

/** A bend's numbers as a flat record (for the rebuild report). */
export function bendInfoRecord(i: BendInfo): Record<string, number> {
  const [cx, cy, cz] = i.centre, [ox, oy, oz] = i.outward, [ax, ay, az] = i.axis;
  return { length: i.length, thickness: i.thickness, width: i.width, radius: i.radius, angle: i.angle, turns: i.turns, gap: i.gap, outerRadius: i.outerRadius, closed: i.closed ? 1 : 0, cx, cy, cz, ox, oy, oz, ax, ay, az };
}
