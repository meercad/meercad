/**
 * A Gridfinity bin with a pocket for a part (often a 3D scan): the part sinks into the bin's solid
 * top up to a share of its height, with some play all round, so it lies in a form-fitting nest.
 *
 * The pocket is what a part can be lowered into from above: for every point of its footprint the
 * part's lowest surface there (a height field), widened by the play sideways and lowered by it.
 * Undercuts therefore never trap the part. The bin is turned on its plane so the part needs as few
 * grid cells as possible, its long side along x.
 *
 * Pure geometry, no OCCT: the kernel turns the pocket's triangles into a solid and cuts it out.
 */
import { GRIDFINITY as G } from "./gridfinity.js";

export class ScanBinError extends Error {}

/** How far the pocket stays inside the bin's outer edge (the stacking lip starts 2.6 mm in). */
export const POCKET_MARGIN = 4;
/** Material left under the deepest point of the pocket, above the feet. */
export const POCKET_FLOOR = 1.5;
/** The finger grip: a groove across the part, this radius, reaching this far past it on both sides. */
export const GRIP_RADIUS = 10;
export const GRIP_REACH = 12;
/** Grid nodes of the height field over the part's footprint (more → finer nest, slower bin). */
export const NODE_BUDGET = 6000;

export interface BinPlanInput {
  /** The part's triangle corners (9 numbers per triangle) in the plane's frame: x, y on it, z up. */
  corners: ArrayLike<number>;
  /** Share of the part's height that sinks into the bin, 0..1. */
  sink: number;
  /** Play between part and pocket, mm. */
  clearance: number;
  grip: boolean;
  /** Fixed sizes instead of the smallest that fit. */
  units?: [number, number];
  height?: number;
}

export interface BinPlan {
  units: [number, number];
  /** Height in 7 mm units. */
  height: number;
  /** Rotation of the bin about the plane's normal, radians (the bin's x along this direction). */
  angle: number;
  /** Centre of the bin in plane coordinates. */
  center: [number, number];
  /** Height (along the normal) of the bin's rim, where the part is cut: its bottom + sink × height. */
  rim: number;
  /** Depth of the pocket below the rim, mm (part's share plus play). */
  depth: number;
  /** The part's footprint in the bin's frame (x, y about its centre): min and max. */
  footprint: { min: [number, number]; max: [number, number] };
  /**
   * The pocket as a closed, outward-wound triangle solid in the bin's local frame (rim at z = height × 7).
   */
  tool: Float32Array;
  /** The grip groove, if any, in the bin's local frame: a cylinder along y. */
  grip?: { x: number; y0: number; y1: number; z: number; radius: number };
  /** Grid spacing of the height field, mm. */
  cell: number;
}

type P2 = [number, number];

function hull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;

  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [],
    hi: P2[] = [];

  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }

  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, q) <= 0) hi.pop();
    hi.push(q);
  }

  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/** Grid cells (along x, y) for a footprint `ex` × `ey` mm with the pocket's margin. */
export function unitsFor(ex: number, ey: number): [number, number] {
  const n = (e: number) => Math.max(1, Math.ceil((e + 2 * POCKET_MARGIN + G.gap) / G.pitch - 1e-9));

  return [n(ex), n(ey)];
}

/** Bin height (7 mm units) for a pocket this deep. */
export function heightFor(depth: number): number {
  return Math.max(1, Math.ceil((G.footHeight + POCKET_FLOOR + depth) / G.unit - 1e-9));
}

/**
 * The turn of the footprint (about the plane's normal) that needs the fewest grid cells, its long
 * side along x. Candidates are the directions of the footprint's hull edges and the plane's axes.
 */
function bestAngle(points: P2[], pad: [number, number]): { angle: number; units: [number, number] } {
  const h = hull(points);
  const cands = new Set<number>([0]);

  for (let i = 0; i < h.length; i++) {
    const a = h[i]!,
      b = h[(i + 1) % h.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;

    let t = Math.atan2(b[1] - a[1], b[0] - a[0]) % (Math.PI / 2);
    if (t < 0) t += Math.PI / 2;

    cands.add(Math.round(t * 1e6) / 1e6);
  }

  type Fit = { angle: number; units: [number, number]; score: number; area: number };

  let best: Fit | null = null;
  let straight: Fit | null = null;

  for (const t0 of cands) {
    for (const t of [t0, t0 + Math.PI / 2]) {
      const c = Math.cos(t),
        s = Math.sin(t);
      let x0 = Infinity,
        x1 = -Infinity,
        y0 = Infinity,
        y1 = -Infinity;

      for (const [x, y] of h) {
        // Coordinates along the bin's x (direction t) and y.
        const u = x * c + y * s,
          v = -x * s + y * c;
        x0 = Math.min(x0, u);
        x1 = Math.max(x1, u);
        y0 = Math.min(y0, v);
        y1 = Math.max(y1, v);
      }

      const ex = x1 - x0 + pad[0],
        ey = y1 - y0 + pad[1];
      if (ey > ex + 1e-9) continue; // long side along x

      const units = unitsFor(ex, ey);
      const score = units[0] * units[1],
        area = ex * ey;

      // Fewest cells, then the tightest box (the bin along the part).
      if (!best || score < best.score || (score === best.score && area < best.area - 1e-6)) {
        best = { angle: t, units, score, area };
      }

      if (t === 0 || Math.abs(t - Math.PI / 2) < 1e-9) {
        straight = !straight || score < straight.score ? { angle: t, units, score, area } : straight;
      }
    }
  }

  // A straight bin when turning saves no cell.
  if (best && straight && straight.score === best.score) best = straight;
  if (!best) return { angle: 0, units: unitsFor(0, 0) };

  // A bin looks the same turned by 180°: report the smaller turn.
  return { angle: best.angle > Math.PI / 2 + 1e-9 ? best.angle - Math.PI : best.angle, units: best.units };
}

/**
 * Plans the bin round a part: its turn, size, height and centre, and the pocket's triangles.
 */
export function planScanBin(input: BinPlanInput): BinPlan {
  const { corners, clearance, grip } = input;
  const nt = Math.floor(corners.length / 9);
  if (!nt) throw new ScanBinError("the part has no triangles");

  if (!(input.sink > 0 && input.sink <= 1)) {
    throw new ScanBinError("the part must sink in by more than 0 and at most 100 %");
  }

  if (!(clearance >= 0 && clearance <= 5)) throw new ScanBinError("the play must be between 0 and 5 mm");

  let zmin = Infinity,
    zmax = -Infinity;
  const pts: P2[] = [];

  for (let i = 0; i < nt * 3; i++) {
    const z = corners[i * 3 + 2]!;
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
    pts.push([corners[i * 3]!, corners[i * 3 + 1]!]);
  }

  const tall = zmax - zmin;
  if (!(tall > 0.1)) throw new ScanBinError("the part is flat: it needs some height to sink into the bin");

  const rimZ = zmin + input.sink * tall;
  const depth = rimZ - zmin + clearance;

  // Only what lies below the rim counts for the footprint (a mushroom's cap stays above the bin).
  const below: P2[] = [];

  for (let t = 0; t < nt; t++) {
    let low = false;
    for (let k = 0; k < 3; k++) if (corners[t * 9 + k * 3 + 2]! <= rimZ + 1e-9) low = true;
    if (low) for (let k = 0; k < 3; k++) below.push(pts[t * 3 + k]!);
  }

  const side = 2 * clearance;
  const pad: [number, number] = [side, side + (grip ? 2 * GRIP_REACH : 0)];
  const chosen = input.units ? { angle: 0, units: input.units } : bestAngle(below, pad);
  const angle = chosen.angle;
  const c = Math.cos(angle),
    s = Math.sin(angle);

  // The part in the bin's turned frame; the footprint's middle becomes the bin's centre.
  const local = new Float64Array(nt * 9);
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;

  for (let i = 0; i < nt * 3; i++) {
    const x = corners[i * 3]!,
      y = corners[i * 3 + 1]!;
    local[i * 3] = x * c + y * s;
    local[i * 3 + 1] = -x * s + y * c;
    local[i * 3 + 2] = corners[i * 3 + 2]!;
  }

  for (const [x, y] of below) {
    const u = x * c + y * s,
      v = -x * s + y * c;
    x0 = Math.min(x0, u);
    x1 = Math.max(x1, u);
    y0 = Math.min(y0, v);
    y1 = Math.max(y1, v);
  }

  const cu = (x0 + x1) / 2,
    cv = (y0 + y1) / 2;
  const units = chosen.units;
  const fits = unitsFor(x1 - x0 + pad[0], y1 - y0 + pad[1]);

  if (input.units && (units[0] < fits[0] || units[1] < fits[1])) {
    throw new ScanBinError(`the part needs a bin of at least ${fits[0]} × ${fits[1]} cells`);
  }

  const height = input.height ?? heightFor(depth);

  if (height < heightFor(depth)) {
    throw new ScanBinError(
      `the pocket is ${depth.toFixed(1)} mm deep: the bin must be at least ${heightFor(depth)} units high`,
    );
  }

  const H = height * G.unit;
  const W = units[0] * G.pitch - G.gap,
    D = units[1] * G.pitch - G.gap;

  for (let i = 0; i < nt * 3; i++) {
    local[i * 3] = local[i * 3]! - cu;
    local[i * 3 + 1] = local[i * 3 + 1]! - cv;
    local[i * 3 + 2] = local[i * 3 + 2]! - rimZ + H;
  }

  // Height field of the part's underside on a grid over its footprint plus the play.
  const ext = clearance;
  const fx0 = x0 - cu - ext,
    fx1 = x1 - cu + ext,
    fy0 = y0 - cv - ext,
    fy1 = y1 - cv + ext;
  const area = (fx1 - fx0) * (fy1 - fy0);
  // Fine enough for the part, coarse enough for OCCT: every triangle becomes a face of the bin.
  const cell = Math.max(0.4, Math.sqrt(area / NODE_BUDGET));
  // One cell more on each side, so the pocket's walls stand clear of the play.
  const gx0 = fx0 - 2 * cell,
    gy0 = fy0 - 2 * cell;
  const nx = Math.ceil((fx1 + 2 * cell - gx0) / cell) + 1,
    ny = Math.ceil((fy1 + 2 * cell - gy0) / cell) + 1;

  if (
    gx0 < -W / 2 + POCKET_MARGIN - 2 * cell - 1e-6 ||
    gx0 + (nx - 1) * cell > W / 2 - POCKET_MARGIN + 2 * cell + 1 ||
    gy0 < -D / 2 + POCKET_MARGIN - 2 * cell - 1e-6 ||
    gy0 + (ny - 1) * cell > D / 2 - POCKET_MARGIN + 2 * cell + 1
  ) {
    throw new ScanBinError("the part does not fit the bin");
  }

  const field = new Float64Array(nx * ny).fill(Infinity);

  const put = (x: number, y: number, z: number) => {
    const i = Math.round((x - gx0) / cell),
      j = Math.round((y - gy0) / cell);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return;
    if (z < field[j * nx + i]!) field[j * nx + i] = z;
  };

  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const ax = local[o]!,
      ay = local[o + 1]!,
      az = local[o + 2]!;
    const bx = local[o + 3]!,
      by = local[o + 4]!,
      bz = local[o + 5]!;
    const qx = local[o + 6]!,
      qy = local[o + 7]!,
      qz = local[o + 8]!;
    if (Math.min(az, bz, qz) > H + 1e-9) continue;

    // Edges, sampled finer than the grid: catches steep and vertical triangles.
    for (const [px, py, pz, rx, ry, rz] of [
      [ax, ay, az, bx, by, bz],
      [bx, by, bz, qx, qy, qz],
      [qx, qy, qz, ax, ay, az],
    ] as const) {
      const steps = Math.max(1, Math.ceil(Math.hypot(rx - px, ry - py) / (cell / 2)));

      for (let k = 0; k <= steps; k++) {
        put(px + ((rx - px) * k) / steps, py + ((ry - py) * k) / steps, pz + ((rz - pz) * k) / steps);
      }
    }

    // Inside: every grid point under the triangle.
    const det = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy);
    if (Math.abs(det) < 1e-12) continue;

    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, qx) - gx0) / cell)),
      i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, qx) - gx0) / cell));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, qy) - gy0) / cell)),
      j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, qy) - gy0) / cell));

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = gx0 + i * cell,
          y = gy0 + j * cell;
        const l1 = ((by - qy) * (x - qx) + (qx - bx) * (y - qy)) / det;
        const l2 = ((qy - ay) * (x - qx) + (ax - qx) * (y - qy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;

        const z = l1 * az + l2 * bz + l3 * qz;
        if (z < field[j * nx + i]!) field[j * nx + i] = z;
      }
    }
  }

  // The play: a ball rolled under the part (sideways one cell more, for the grid's slopes).
  const reach = clearance + cell;
  const rc = Math.ceil(reach / cell - 1e-9);
  const offs: [number, number, number][] = [];

  for (let dj = -rc; dj <= rc; dj++) {
    for (let di = -rc; di <= rc; di++) {
      const d = Math.hypot(di, dj) * cell;
      if (d > reach + 1e-9) continue;

      // Down by the play under the part, still the play within one cell beside it.
      offs.push([di, dj, d <= clearance ? Math.sqrt(clearance * clearance - d * d) : 0]);
    }
  }

  const cap = H + 1;
  const bottom = new Float64Array(nx * ny);

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let z = Infinity;

      for (const [di, dj, dz] of offs) {
        const ii = i + di,
          jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;

        const v = field[jj * nx + ii]! - dz;
        if (v < z) z = v;
      }

      bottom[j * nx + i] = Math.min(z, cap);
    }
  }

  // The outermost ring stays at the cap: the tool is closed by vertical walls there.
  for (let i = 0; i < nx; i++) bottom[i] = bottom[(ny - 1) * nx + i] = cap;
  for (let j = 0; j < ny; j++) bottom[j * nx] = bottom[j * nx + nx - 1] = cap;

  let lowest = Infinity;
  for (const z of bottom) lowest = Math.min(lowest, z);

  if (lowest < G.footHeight + POCKET_FLOOR - 1e-6) {
    throw new ScanBinError(
      `the pocket is ${(H - lowest).toFixed(1)} mm deep: the bin must be at least ${heightFor(H - lowest)} units high`,
    );
  }

  const tool = heightFieldSolid(bottom, nx, ny, gx0, gy0, cell, cap + 1);
  const plan: BinPlan = {
    units,
    height,
    angle,
    center: [cu * c - cv * s, cu * s + cv * c],
    rim: rimZ,
    depth,
    footprint: { min: [x0 - cu, y0 - cv], max: [x1 - cu, y1 - cv] },
    tool,
    cell,
  };

  if (grip) {
    // A groove across the part's middle, its bottom at the pocket's mid depth (at most the radius).
    const gd = Math.min(GRIP_RADIUS, Math.max(2, (depth * 2) / 3));
    const fy = D / 2 - POCKET_MARGIN;
    plan.grip = {
      x: 0,
      y0: Math.max(-fy, y0 - cv - GRIP_REACH),
      y1: Math.min(fy, y1 - cv + GRIP_REACH),
      z: H - gd + GRIP_RADIUS,
      radius: GRIP_RADIUS,
    };
  }

  return plan;
}

/**
 * A closed solid between a height field (its underside, `bottom` per grid node) and a flat top at
 * `top`: triangles wound outwards, 9 numbers each. Neighbouring cells whose corners all lie at one
 * height (the flat surroundings, a flat bottom) are merged into rectangles, each a fan from its
 * middle over every grid node on its edge, so the merged areas cost few triangles and leave no gaps.
 */
export function heightFieldSolid(
  bottom: Float64Array,
  nx: number,
  ny: number,
  x0: number,
  y0: number,
  cell: number,
  top: number,
): Float32Array {
  const out: number[] = [];
  const X = (i: number) => x0 + i * cell,
    Y = (j: number) => y0 + j * cell;
  const z = (i: number, j: number) => bottom[j * nx + i]!;
  const P = (i: number, j: number) => [X(i), Y(j), z(i, j)];
  const tri = (a: number[], b: number[], c: number[]) =>
    out.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!);
  const cx = nx - 1,
    cy = ny - 1;

  const flat = (i: number, j: number) => {
    const v = z(i, j);

    return z(i + 1, j) === v && z(i + 1, j + 1) === v && z(i, j + 1) === v;
  };

  const done = new Uint8Array(cx * cy);

  // Underside, facing down (clockwise seen from above).
  for (let j = 0; j < cy; j++) {
    for (let i = 0; i < cx; i++) {
      if (done[j * cx + i]) continue;

      if (flat(i, j)) {
        // Grow a rectangle of flat cells at this height: along x, then row by row.
        const v = z(i, j);
        let i1 = i;
        while (i1 + 1 < cx && !done[j * cx + i1 + 1] && flat(i1 + 1, j) && z(i1 + 1, j) === v) i1++;

        let j1 = j;

        grow: while (j1 + 1 < cy) {
          for (let k = i; k <= i1; k++) {
            if (done[(j1 + 1) * cx + k] || !flat(k, j1 + 1) || z(k, j1 + 1) !== v) break grow;
          }

          j1++;
        }

        for (let jj = j; jj <= j1; jj++) for (let k = i; k <= i1; k++) done[jj * cx + k] = 1;

        if (i1 === i && j1 === j) {
          tri(P(i, j), P(i + 1, j + 1), P(i + 1, j));
          tri(P(i, j), P(i, j + 1), P(i + 1, j + 1));
          continue;
        }

        // Edge nodes counter-clockwise; fan wound clockwise (facing down).
        const ring: number[][] = [];
        for (let k = i; k < i1 + 1; k++) ring.push(P(k, j));
        for (let k = j; k < j1 + 1; k++) ring.push(P(i1 + 1, k));
        for (let k = i1 + 1; k > i; k--) ring.push(P(k, j1 + 1));
        for (let k = j1 + 1; k > j; k--) ring.push(P(i, k));

        const m = [(X(i) + X(i1 + 1)) / 2, (Y(j) + Y(j1 + 1)) / 2, v];
        for (let k = 0; k < ring.length; k++) tri(m, ring[(k + 1) % ring.length]!, ring[k]!);
        continue;
      }

      done[j * cx + i] = 1;

      const a = P(i, j),
        b = P(i + 1, j),
        c = P(i + 1, j + 1),
        d = P(i, j + 1);

      // Split along the diagonal whose ends are closer in height, for a smoother surface.
      if (Math.abs(a[2]! - c[2]!) <= Math.abs(b[2]! - d[2]!)) {
        tri(a, c, b);
        tri(a, d, c);
      } else {
        tri(a, d, b);
        tri(b, d, c);
      }
    }
  }

  // Walls round the edge, from the field up to the top.
  const ring: [number, number][] = [];
  for (let i = 0; i < cx; i++) ring.push([i, 0]);
  for (let j = 0; j < cy; j++) ring.push([cx, j]);
  for (let i = cx; i > 0; i--) ring.push([i, cy]);
  for (let j = cy; j > 0; j--) ring.push([0, j]);

  for (let k = 0; k < ring.length; k++) {
    const [i, j] = ring[k]!,
      [i2, j2] = ring[(k + 1) % ring.length]!;
    const a = P(i, j),
      b = P(i2, j2);
    const at = [a[0]!, a[1]!, top],
      bt = [b[0]!, b[1]!, top];
    // The ring runs counter-clockwise seen from above: outward walls are a, b, bt.
    tri(a, b, bt);
    tri(a, bt, at);
  }

  // Top: a fan from its middle over the ring's points (no thin slivers, no T-junctions).
  const m = [X(cx / 2), Y(cy / 2), top];

  for (let k = 0; k < ring.length; k++) {
    const [i, j] = ring[k]!,
      [i2, j2] = ring[(k + 1) % ring.length]!;
    tri(m, [X(i), Y(j), top], [X(i2), Y(j2), top]);
  }

  return Float32Array.from(out);
}
