/**
 * How well a part prints in a given orientation on an FDM printer: which parts of its surface hang
 * over more steeply than a printer bridges without supports (45° from vertical is the usual
 * limit), how much support material that roughly takes, and which way up it prints best.
 *
 * Works on the display triangles of a part, in its own coordinates, with any "down" direction: the
 * build plate lies under the lowest point of the part along it.
 */

type V3 = [number, number, number];

/** What a triangle is in an orientation. */
export const SURFACE_OK = 0;
/** Hangs over more than the limit: needs support. */
export const SURFACE_OVERHANG = 1;
/** Lies on the build plate. */
export const SURFACE_PLATE = 2;

export interface PrintCheck {
  /** One of SURFACE_OK, SURFACE_OVERHANG, SURFACE_PLATE per triangle. */
  kind: Uint8Array;
  /** Surface area in mm². */
  area: number;
  /** Area hanging over more than the limit, in mm². */
  overhangArea: number;
  /** Area resting on the build plate, in mm². */
  plateArea: number;
  /**
   * Rough support volume in mm³: every overhanging triangle's footprint times its height above
   * the plate (supports that start on the part itself are counted down to the plate too).
   */
  supportVolume: number;
  /** Height of the print along "up", in mm. */
  height: number;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Outward normal (unit, scaled by `sign`), area and centroid of triangle `t`. */
function triangle(P: ArrayLike<number>, I: ArrayLike<number>, t: number, sign: number): { n: V3; a: number; c: V3 } {
  const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
  const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
  const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  return {
    n: l ? [(sign * nx) / l, (sign * ny) / l, (sign * nz) / l] : [0, 0, 0],
    a: l / 2,
    c: [(P[a]! + P[b]! + P[c]!) / 3, (P[a + 1]! + P[b + 1]! + P[c + 1]!) / 3, (P[a + 2]! + P[b + 2]! + P[c + 2]!) / 3],
  };
}

/** +1 for a mesh whose triangles turn outwards, -1 for one turned inside out (some STL files). */
export function outwardSign(P: ArrayLike<number>, I: ArrayLike<number>): number {
  let volume = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3;
    volume += P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) - P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) + P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!);
  }
  return volume < 0 ? -1 : 1;
}

/**
 * The print check of a mesh (`positions` x, y, z per vertex, `indices` three per triangle) printed
 * with `down` towards the build plate. `limit` is the steepest overhang printed without support,
 * in degrees from vertical.
 */
export function printCheck(positions: ArrayLike<number>, indices: ArrayLike<number>, down: V3 = [0, 0, -1], limit = 45): PrintCheck {
  const d = norm(down);
  const up: V3 = [-d[0], -d[1], -d[2]];
  const P = positions;
  const n = Math.floor(indices.length / 3);
  const sign = outwardSign(P, indices);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const h = P[i]! * up[0] + P[i + 1]! * up[1] + P[i + 2]! * up[2];
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const height = Number.isFinite(lo) ? hi - lo : 0;
  // Within this of the lowest point counts as on the plate: tessellation and float noise.
  const tol = Math.max(1e-3, height * 1e-5);
  const steep = Math.sin((limit * Math.PI) / 180);
  const kind = new Uint8Array(n);
  let area = 0, overhangArea = 0, plateArea = 0, supportVolume = 0;
  for (let t = 0; t < n; t++) {
    const { n: nn, a, c } = triangle(P, indices, t, sign);
    area += a;
    const facing = dot(nn, d);
    if (facing <= steep + 1e-9) continue;
    // Faces down: on the plate when all its corners are at the bottom.
    let low = true;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k]! * 3;
      if (P[v]! * up[0] + P[v + 1]! * up[1] + P[v + 2]! * up[2] - lo > tol) low = false;
    }
    if (low && facing > 0.999) {
      kind[t] = SURFACE_PLATE;
      plateArea += a;
      continue;
    }
    kind[t] = SURFACE_OVERHANG;
    overhangArea += a;
    supportVolume += a * facing * (dot(c, up) - lo);
  }
  return { kind, area, overhangArea, plateArea, supportVolume, height };
}

export interface PrintOrientation {
  /** Direction (in the part's coordinates) that goes onto the build plate. */
  down: V3;
  check: PrintCheck;
}

/**
 * Directions worth trying as "down": the six axis directions and the normals of the largest flat
 * areas of the part (a part usually prints best on one of its flat faces).
 */
export function candidateDowns(positions: ArrayLike<number>, indices: ArrayLike<number>, flats = 16): V3[] {
  const sign = outwardSign(positions, indices);
  const bins = new Map<string, { n: V3; a: number }>();
  const n = Math.floor(indices.length / 3);
  for (let t = 0; t < n; t++) {
    const { n: nn, a } = triangle(positions, indices, t, sign);
    if (!a) continue;
    // Normals within about half a degree share a bin.
    const key = nn.map((v) => Math.round(v * 100)).join(",");
    const b = bins.get(key);
    if (b) {
      for (let k = 0; k < 3; k++) b.n[k] = b.n[k]! + nn[k]! * a;
      b.a += a;
    } else bins.set(key, { n: [nn[0] * a, nn[1] * a, nn[2] * a], a });
  }
  const out: V3[] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  for (const b of [...bins.values()].sort((x, y) => y.a - x.a).slice(0, flats)) {
    const v = norm(b.n);
    if (!out.some((o) => dot(o, v) > 0.9999)) out.push(v);
  }
  return out;
}

/**
 * The orientations of a part ranked best first: least support material, then most area on the
 * plate (it sticks better), then lowest. The current orientation (down = -Z) is among them.
 */
export function rankOrientations(positions: ArrayLike<number>, indices: ArrayLike<number>, limit = 45): PrintOrientation[] {
  const all = candidateDowns(positions, indices).map((down) => ({ down, check: printCheck(positions, indices, down, limit) }));
  // Support counts most; a few mm² more plate or a lower print only decide between near equals.
  const score = (o: PrintOrientation) => o.check.supportVolume - o.check.plateArea * 0.05 + o.check.height * 0.01;
  return all.sort((a, b) => score(a) - score(b));
}

/**
 * Two turns that bring `down` onto -Z: first `aboutZ` degrees about the Z axis, then `aboutX`
 * degrees about the X axis (both right-handed, through the origin).
 */
export function turnsToLay(down: V3): { aboutZ: number; aboutX: number } {
  const d = norm(down);
  const r = Math.hypot(d[0], d[1]);
  const deg = (v: number) => (v * 180) / Math.PI;
  // About Z: the horizontal part points along +Y.
  const aboutZ = r < 1e-9 ? 0 : 90 - deg(Math.atan2(d[1], d[0]));
  // About X: (y, z) = (r, dz) turns to (0, -1).
  const aboutX = -90 - deg(Math.atan2(d[2], r));
  const wrap = (a: number) => {
    const w = ((a % 360) + 540) % 360 - 180;
    return Math.abs(w) < 1e-9 ? 0 : Math.round(w * 1e6) / 1e6;
  };
  return { aboutZ: wrap(aboutZ), aboutX: wrap(aboutX) };
}

/** `p` turned by `turnsToLay`'s angles (Z first, then X). */
export function turnPoint(p: V3, aboutZ: number, aboutX: number): V3 {
  const z = (aboutZ * Math.PI) / 180, x = (aboutX * Math.PI) / 180;
  const x1 = p[0] * Math.cos(z) - p[1] * Math.sin(z);
  const y1 = p[0] * Math.sin(z) + p[1] * Math.cos(z);
  const z1 = p[2];
  return [x1, y1 * Math.cos(x) - z1 * Math.sin(x), y1 * Math.sin(x) + z1 * Math.cos(x)];
}

/** A connected piece of surface that needs support. */
export interface OverhangRegion {
  areaMm2: number;
  /** Its longest extent across the print direction (how far it bridges or hangs out), mm. */
  spanMm: number;
  /** A point of it (the centre of its largest triangle). */
  at: V3;
  /** Its flattest triangle's angle to the plate, degrees (0: a flat ceiling). */
  flattestDeg: number;
  /** Most of it is open to the outside (false: in a hole, a pocket or under other parts of the part). */
  outside: boolean;
}

export interface SupportDetails {
  /** Overhang area that is open to the outside: support scars show there. */
  outsideMm2: number;
  /** Overhang area inside holes, pockets and cavities. */
  insideMm2: number;
  /** Overhang area whose support stands on the part itself rather than the plate. */
  onPartMm2: number;
  /** The flattest overhang's angle to the plate, degrees (null without overhangs). */
  flattestDeg: number | null;
  /** The pieces of overhang, largest first. */
  regions: OverhangRegion[];
}

/** Directions spread evenly over a sphere (golden spiral). */
const SPHERE: V3[] = Array.from({ length: 48 }, (_, k) => {
  const z = 1 - (2 * (k + 0.5)) / 48;
  const r = Math.sqrt(1 - z * z);
  const a = k * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(a), r * Math.sin(a), z] as V3;
});

/**
 * Where the support of a print check goes (see printCheck, same mesh, `down` and limit): which
 * overhangs are open to the outside and which lie inside holes and pockets (rays from the face
 * over its half of the sky: most leaving the part means outside), which have the part itself
 * under them, and the connected pieces with their area, span and flattest angle.
 * `ray(origin, direction)` says how far a ray runs before it meets the part (Infinity: never).
 */
export function supportDetails(positions: ArrayLike<number>, indices: ArrayLike<number>, check: PrintCheck, down: V3, ray: (o: V3, d: V3) => number): SupportDetails {
  const d = norm(down);
  const P = positions;
  const sign = outwardSign(P, indices);
  const n = check.kind.length;
  const out: SupportDetails = { outsideMm2: 0, insideMm2: 0, onPartMm2: 0, flattestDeg: null, regions: [] };
  // Overhang triangles grouped by shared corners (corners matched by position: meshes may repeat them per face).
  const key = (v: number) => `${Math.round(P[v * 3]! * 1e3)},${Math.round(P[v * 3 + 1]! * 1e3)},${Math.round(P[v * 3 + 2]! * 1e3)}`;
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      const p = parent.get(parent.get(x)!)!;
      parent.set(x, p);
      x = p;
    }
    return x;
  };
  const byCorner = new Map<string, number>();
  const info = new Map<number, { a: number; c: V3; deg: number; outside: boolean }>();
  for (let t = 0; t < n; t++) {
    if (check.kind[t] !== SURFACE_OVERHANG) continue;
    const { n: nn, a, c } = triangle(P, indices, t, sign);
    const deg = (Math.acos(Math.min(1, Math.max(-1, dot(nn, d)))) * 180) / Math.PI;
    const from: V3 = [c[0] + nn[0] * 1e-3, c[1] + nn[1] * 1e-3, c[2] + nn[2] * 1e-3];
    let open = 0;
    let tried = 0;
    for (const s of SPHERE) {
      if (dot(s, nn) < 0.05) continue;
      tried++;
      if (!Number.isFinite(ray(from, s))) open++;
    }
    const outside = tried === 0 || open / tried >= 0.5;
    if (outside) out.outsideMm2 += a;
    else out.insideMm2 += a;
    if (Number.isFinite(ray(from, d))) out.onPartMm2 += a;
    out.flattestDeg = out.flattestDeg === null ? deg : Math.min(out.flattestDeg, deg);
    info.set(t, { a, c, deg, outside });
    parent.set(t, t);
    for (let k = 0; k < 3; k++) {
      const ck = key(indices[t * 3 + k]!);
      const other = byCorner.get(ck);
      if (other === undefined) byCorner.set(ck, t);
      else parent.set(find(t), find(other));
    }
  }
  // Each piece: its area, extent across the print direction, a point and how it lies.
  const u = norm(Math.abs(d[0]) < 0.9 ? [0, -d[2], d[1]] : [-d[2], 0, d[0]]);
  const w: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const groups = new Map<number, { a: number; outA: number; lo: [number, number]; hi: [number, number]; big: number; at: V3; deg: number }>();
  for (const [t, x] of info) {
    const r = find(t);
    const g = groups.get(r) ?? { a: 0, outA: 0, lo: [Infinity, Infinity], hi: [-Infinity, -Infinity], big: -1, at: x.c, deg: 180 };
    g.a += x.a;
    if (x.outside) g.outA += x.a;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k]! * 3;
      const p: V3 = [P[v]!, P[v + 1]!, P[v + 2]!];
      const pu = dot(p, u), pw = dot(p, w);
      g.lo = [Math.min(g.lo[0], pu), Math.min(g.lo[1], pw)];
      g.hi = [Math.max(g.hi[0], pu), Math.max(g.hi[1], pw)];
    }
    if (x.a > g.big) {
      g.big = x.a;
      g.at = x.c;
    }
    g.deg = Math.min(g.deg, x.deg);
    groups.set(r, g);
  }
  out.regions = [...groups.values()]
    .map((g) => ({ areaMm2: g.a, spanMm: Math.hypot(g.hi[0] - g.lo[0], g.hi[1] - g.lo[1]), at: g.at, flattestDeg: g.deg, outside: g.outA >= g.a / 2 }))
    .sort((x, y) => y.areaMm2 - x.areaMm2);
  return out;
}
