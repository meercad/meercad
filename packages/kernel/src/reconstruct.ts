/**
 * Rebuilds a mesh as a parametric model made of meerCAD's own features: the part is sliced along
 * its main direction into layers between its flat faces, each layer's cross-section becomes a
 * sketch of lines, arcs and circles (taken from the recognised planes and cylinders, so a hole is a
 * circle with a diameter parameter) that is extruded by the layer's height. Deterministic: the
 * same mesh always gives the same features, with parameters for the sizes worth measuring on the
 * real object. A part lying at an angle is turned upright first, rebuilt, and turned back by
 * transform steps.
 */
import type { Expr, Feature, PlaneRef, PlaneSpec, SketchConstraint, SketchEntity } from "@meercad/schema";
import { ORIGIN_FRAMES, toSketch, type PlaneFrame } from "@meercad/sketch";
import { fitMesh, type MeshFit, type Vec3 } from "./meshfit.js";

export interface Measurement {
  param: string;
  /** What to measure on the real object, e.g. "Overall width". */
  label: string;
  /** Value found in the mesh (mm). */
  value: number;
  kind: "size" | "height" | "diameter";
}

export interface Reconstruction {
  features: Feature[];
  params: Record<string, Expr>;
  measurements: Measurement[];
  warnings: string[];
  /** Sketch plane the layers are stacked on. */
  plane: PlaneRef;
  /** Id of the rebuilt part. */
  body: string;
}

export interface ReconstructOptions {
  /** Prefix for feature ids (default "rb"). */
  prefix?: string;
  /** How far (mm) a layer's walls may stray from the mesh before the layer is split; default from the part's size. */
  deviation?: number;
  /** Most layers (default 20: fusing more takes OCCT far longer for little gain). */
  maxLayers?: number;
}

type Vec2 = [number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: Vec3): Vec3 => scale(a, 1 / len(a));
const COS_2DEG = Math.cos((2 * Math.PI) / 180);

/** Rebuilds the fitted mesh; throws an Error with a readable message when the part has no flat faces to stack on. */
export function reconstruct(fit: MeshFit, opts: ReconstructOptions = {}, upright = false): Reconstruction {
  const prefix = opts.prefix ?? "rb";
  const warnings: string[] = [];
  const dir = mainDirection(fit);
  if (!dir) throw new Error("no flat face to build on: the part needs at least one plane");
  const axis = nearestAxis(dir);
  if (!axis) {
    if (upright) throw new Error("the part could not be stood upright along its main direction");
    return reconstructTilted(fit, dir, opts);
  }
  const { plane, frame } = axis;
  const n = frame.normal;
  const tol = fit.tolerance;
  const p = (i: number): Vec3 => [fit.positions[i * 3]!, fit.positions[i * 3 + 1]!, fit.positions[i * 3 + 2]!];

  // Levels: the flat faces square to the direction, plus the ends of the part.
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < fit.positions.length / 3; i++) {
    const z = dot(p(i), n);
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
  }
  const levels: number[] = [];
  const addLevel = (z: number) => {
    if (!levels.some((l) => Math.abs(l - z) <= tol * 2)) levels.push(z);
  };
  for (const r of fit.regions) if (r.primitive?.kind === "plane" && Math.abs(dot(r.primitive.normal, n)) > COS_2DEG) addLevel(dot(r.primitive.origin, n));
  if (!levels.some((l) => Math.abs(l - zMin) <= tol * 2)) {
    warnings.push("the bottom of the part is not flat; it is built as a straight layer");
    addLevel(zMin);
  }
  if (!levels.some((l) => Math.abs(l - zMax) <= tol * 2)) {
    warnings.push("the top of the part is not flat; it is built as a straight layer");
    addLevel(zMax);
  }
  levels.sort((a, b) => a - b);
  refineLevels(levels, fit, n, opts.deviation ?? Math.max(0.3, fit.diag / 250), opts.maxLayers ?? 20, tol);
  // Snap the lowest level to the origin plane when it is close enough.
  const z0 = Math.abs(levels[0]!) <= tol ? 0 : round3(levels[0]!);

  const features: Feature[] = [];
  const params: Record<string, Expr> = {};
  const measurements: Measurement[] = [];
  const holes = new HoleParams(params, measurements, tol);
  let heightExpr: string[] = [];
  let bodies = 0;
  const layerBodies: string[] = [];
  let sketches = 0;
  for (let i = 0; i + 1 < levels.length; i++) {
    const zA = levels[i]!;
    const zB = levels[i + 1]!;
    const h = round3(zB - zA);
    if (h <= tol) continue;
    const loops = slice(fit, n, (zA + zB) / 2);
    if (!loops.length) continue;
    const layer = i + 1;
    const hParam = `h${layer}`;
    params[hParam] = `${h} mm`;
    measurements.push({ param: hParam, label: levels.length === 2 ? "Height (thickness)" : `Height of layer ${layer} (${fmt(zA)} to ${fmt(zB)} mm)`, value: h, kind: "height" });
    const skId = `${prefix}_sk${++sketches}`;
    const offset = [z0 ? `${z0}` : "", ...heightExpr].filter(Boolean).join(" + ");
    let planeSpec: PlaneSpec = { ref: plane };
    if (offset) {
      const plId = `${prefix}_pl${layer}`;
      features.push({ id: plId, op: "plane", name: `Layer ${layer} level`, base: { ref: plane }, offset });
      planeSpec = { ref: plId };
    }
    const sk = sketchOf(loops, frame, fit, tol, layer, params, measurements, holes);
    if (typeof process !== "undefined" && process.env?.["MESH_DEBUG"]) process.stderr.write(`layer ${layer} z ${fmt(zA)}..${fmt(zB)} loops ${loops.length} runs ${loops.reduce((n, l) => n + l.length, 0)} entities ${sk.entities.length} constraints ${sk.constraints.length}\n`);
    features.push({ id: skId, op: "sketch", name: `Layer ${layer} outline`, plane: planeSpec, entities: sk.entities, constraints: sk.constraints });
    // Every layer is a body of its own, fused in one boolean at the end: joining layer after layer
    // gets slower with every layer, and a join would also fuse with the mesh part (kept in the
    // model as a reference, thousands of triangle faces).
    features.push({ id: `${prefix}_ex${layer}`, op: "extrude", name: levels.length === 2 ? "Body" : `Layer ${layer}`, profile: { sketch: skId }, extent: "blind", distance: hParam, mode: "new_body" });
    layerBodies.push(`${prefix}_ex${layer}`);
    bodies++;
    heightExpr = [...heightExpr, hParam];
  }
  if (!bodies) throw new Error("nothing to build: no layer has a cross-section");
  if (layerBodies.length > 1) features.push({ id: `${prefix}_union`, op: "boolean", name: "Join layers", operation: "union", target: layerBodies[0]!, tools: layerBodies.slice(1) });
  // Overall sizes first: they are what one measures with a ruler.
  measurements.sort((a, b) => rank(a) - rank(b));
  return { features, params, measurements, warnings, plane, body: layerBodies[0]! };
}

/**
 * A part whose main direction is not along X, Y or Z: turned about the origin so that it points
 * along Z and its largest side wall faces X (so outlines come out as widths and depths), rebuilt
 * there, and turned back by up to three rotations about X, Y and Z.
 */
function reconstructTilted(fit: MeshFit, dir: Vec3, opts: ReconstructOptions): Reconstruction {
  // Standing on its largest flat face, as on a print bed: that face looks down.
  let base: Vec3 = dir;
  let baseArea = 0;
  for (const r of fit.regions) {
    const s = r.primitive;
    if (s?.kind !== "plane" || Math.abs(dot(s.normal, dir)) < COS_2DEG || r.area <= baseArea) continue;
    base = s.normal;
    baseArea = r.area;
  }
  const e3 = norm(scale(base, -1));
  let side: Vec3 | null = null;
  let sideArea = 0;
  for (const r of fit.regions) {
    const s = r.primitive;
    if (s?.kind !== "plane" || Math.abs(dot(s.normal, e3)) > Math.sin((2 * Math.PI) / 180) || r.area <= sideArea) continue;
    side = s.normal;
    sideArea = r.area;
  }
  // Without a flat side wall (a round part), any direction square to the main one.
  const seed: Vec3 = side ?? (Math.abs(e3[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const e1 = norm(sub(seed, scale(e3, dot(seed, e3))));
  const e2 = cross(e3, e1);
  // Upright coordinates are (e1·p, e2·p, e3·p); back is p = e1·x + e2·y + e3·z.
  const corners: number[] = [];
  for (let t = 0; t < fit.triangles.length; t++) {
    const i = fit.triangles[t]!;
    const q: Vec3 = [fit.positions[i * 3]!, fit.positions[i * 3 + 1]!, fit.positions[i * 3 + 2]!];
    corners.push(dot(e1, q), dot(e2, q), dot(e3, q));
  }
  const rb = reconstruct(fitMesh(corners, { tolerance: fit.tolerance }), opts, true);
  const prefix = opts.prefix ?? "rb";
  // Columns e1, e2, e3 as Rz(γ)·Ry(β)·Rx(α): turned about X first, then Y, then Z.
  const m = [
    [e1[0], e2[0], e3[0]],
    [e1[1], e2[1], e3[1]],
    [e1[2], e2[2], e3[2]],
  ] as const;
  const deg = (r: number) => (r * 180) / Math.PI;
  const beta = Math.asin(Math.max(-1, Math.min(1, -m[2][0])));
  const locked = Math.abs(Math.cos(beta)) < 1e-9;
  const alpha = locked ? 0 : Math.atan2(m[2][1], m[2][2]);
  const gamma = locked ? Math.atan2(-m[0][1], m[1][1]) : Math.atan2(m[1][0], m[0][0]);
  for (const [axis, angle] of [["X", alpha], ["Y", beta], ["Z", gamma]] as const) {
    const a = Math.round(deg(angle) * 1e6) / 1e6;
    if (Math.abs(a) < 1e-6) continue;
    rb.features.push({ id: `${prefix}_rot${axis}`, op: "transform", name: `Turn back about ${axis}`, bodies: [rb.body], rotate: { axis: { ref: `origin.${axis}` }, angle: `${a} deg` } });
  }
  return rb;
}

/**
 * Splits layers whose outline changes along the way (a sloped or rounded wall): a layer is
 * extruded straight from its middle, so where the slices near its ends differ from the middle one
 * by more than `deviation` a level is added in between, until every layer is close or the budget
 * of layers is spent (largest deviation first).
 */
function refineLevels(levels: number[], fit: MeshFit, n: Vec3, deviation: number, maxLayers: number, tol: number): void {
  const minLayer = Math.max(tol * 4, 0.2);
  // Outlines as points spaced well below the deviation, projected along the direction: then the
  // distance between two outlines is a distance between point sets.
  const step = deviation / 4;
  const cache = new Map<number, Vec3[]>();
  const outline = (z: number) => {
    let o = cache.get(z);
    if (!o) {
      o = [];
      for (const loop of slice(fit, n, z))
        for (const run of loop)
          for (let k = 0; k + 1 < run.points.length; k++) {
            const a = flatten(run.points[k]!, n);
            const b = flatten(run.points[k + 1]!, n);
            const parts = Math.max(1, Math.ceil(len(sub(b, a)) / step));
            for (let t = 0; t < parts; t++) o.push([a[0] + ((b[0] - a[0]) * t) / parts, a[1] + ((b[1] - a[1]) * t) / parts, a[2] + ((b[2] - a[2]) * t) / parts]);
          }
      cache.set(z, o);
    }
    return o;
  };
  // How far a layer's straight walls (the middle slice) stray from the slices near its ends.
  const strays = (a: number, b: number) => {
    const mid = outline((a + b) / 2);
    let worst = 0;
    for (const z of [a + (b - a) * 0.1, b - (b - a) * 0.1]) {
      const end = outline(z);
      worst = Math.max(worst, farthest(end, mid, deviation), farthest(mid, end, deviation));
    }
    return worst;
  };
  const queue: { a: number; b: number; d: number }[] = [];
  for (let i = 0; i + 1 < levels.length; i++) if (levels[i + 1]! - levels[i]! > 2 * minLayer) queue.push({ a: levels[i]!, b: levels[i + 1]!, d: strays(levels[i]!, levels[i + 1]!) });
  while (levels.length - 1 < maxLayers) {
    queue.sort((x, y) => y.d - x.d);
    const worst = queue.shift();
    if (!worst || worst.d <= deviation) break;
    const mid = (worst.a + worst.b) / 2;
    levels.push(mid);
    for (const [a, b] of [[worst.a, mid], [mid, worst.b]] as [number, number][]) if (b - a > 2 * minLayer) queue.push({ a, b, d: strays(a, b) });
  }
  levels.sort((a, b) => a - b);
}

const flatten = (q: Vec3, n: Vec3): Vec3 => {
  const d = dot(q, n);
  return [q[0] - n[0] * d, q[1] - n[1] * d, q[2] - n[2] * d];
};

/**
 * Largest distance from a point of `a` to the nearest point of `b` (dense point sets in one plane
 * through the origin square to an axis), looked up on a 2D grid of `cap`-sized cells; anything
 * past `2 * cap` counts as `2 * cap` (enough to know the layer must split).
 */
function farthest(a: Vec3[], b: Vec3[], cap: number): number {
  if (!a.length) return 0;
  if (!b.length) return cap * 2;
  // The two coordinates that vary (the third is ~0 after flattening).
  const spread = [0, 1, 2].map((k) => Math.max(...b.slice(0, 50).map((q) => Math.abs(q[k]!))));
  const drop = spread.indexOf(Math.min(...spread));
  const [u, v] = [0, 1, 2].filter((k) => k !== drop) as [0 | 1 | 2, 0 | 1 | 2];
  const W = 1 << 20;
  const key = (x: number, y: number) => (x + W / 2) * W + (y + W / 2);
  const grid = new Map<number, Vec3[]>();
  for (const q of b) {
    const k = key(Math.floor(q[u] / cap), Math.floor(q[v] / cap));
    const list = grid.get(k);
    if (list) list.push(q);
    else grid.set(k, [q]);
  }
  let worst = 0;
  for (const q of a) {
    const cx = Math.floor(q[u] / cap);
    const cy = Math.floor(q[v] / cap);
    let best = cap * 2;
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++) {
        const list = grid.get(key(cx + dx, cy + dy));
        if (!list) continue;
        for (const p of list) {
          const d = Math.hypot(p[u] - q[u], p[v] - q[v]);
          if (d < best) best = d;
        }
      }
    if (best > worst) {
      worst = best;
      if (worst >= cap * 2) return worst;
    }
  }
  return worst;
}

const rank = (m: Measurement) => (m.kind === "size" ? 0 : m.kind === "height" ? 1 : 2);
const round = (v: number) => Math.round(v * 1e6) / 1e6;
/** Parameter values and labels: millimetres to the micron are noise there. */
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (v: number) => String(round3(v));

// ---------------------------------------------------------------- direction

/** The direction most of the part is built along: flat faces square to it, round faces around it. */
function mainDirection(fit: MeshFit): Vec3 | null {
  const candidates: { dir: Vec3; score: number }[] = [];
  const consider = (d: Vec3) => {
    for (const c of candidates) if (Math.abs(dot(c.dir, d)) > COS_2DEG) return;
    let score = 0;
    for (const r of fit.regions) {
      const s = r.primitive;
      if (!s) continue;
      if (s.kind === "plane") {
        const c = Math.abs(dot(s.normal, d));
        if (c > COS_2DEG) score += r.area;
        else if (c < Math.sin((2 * Math.PI) / 180)) score += r.area * 0.5;
      } else if ((s.kind === "cylinder" || s.kind === "cone") && Math.abs(dot(s.axis, d)) > COS_2DEG) score += r.area;
    }
    candidates.push({ dir: d, score });
  };
  for (const r of fit.regions) {
    const s = r.primitive;
    if (s?.kind === "plane") consider(s.normal);
    else if (s?.kind === "cylinder" || s?.kind === "cone") consider(s.axis);
  }
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  return fit.regions.some((r) => r.primitive?.kind === "plane" && Math.abs(dot(r.primitive.normal, best.dir)) > COS_2DEG) ? best.dir : null;
}

function nearestAxis(d: Vec3): { plane: PlaneRef; frame: PlaneFrame } | null {
  const options: [PlaneRef, PlaneFrame][] = [
    ["origin.XY", ORIGIN_FRAMES["origin.XY"]],
    ["origin.XZ", ORIGIN_FRAMES["origin.XZ"]],
    ["origin.YZ", ORIGIN_FRAMES["origin.YZ"]],
  ];
  for (const [plane, frame] of options) if (Math.abs(dot(frame.normal, d)) > COS_2DEG) return { plane, frame };
  return null;
}

// ---------------------------------------------------------------- slicing

interface Run {
  region: number;
  points: Vec3[];
}
/** A closed loop of the cross-section: runs of consecutive points on one region, counter-clockwise for the outside. */
type Loop = Run[];

function slice(fit: MeshFit, n: Vec3, z: number): Loop[] {
  const tri = fit.triangles;
  const q = Math.max(fit.diag * 1e-7, 1e-9);
  const key = (v: Vec3) => `${Math.round(v[0] / q)},${Math.round(v[1] / q)},${Math.round(v[2] / q)}`;
  const segs: { a: Vec3; b: Vec3; region: number; used: boolean }[] = [];
  const at = new Map<string, number[]>();
  for (let t = 0; t < tri.length / 3; t++) {
    const pts: Vec3[] = [];
    for (let e = 0; e < 3; e++) {
      const i = tri[t * 3 + e]!;
      const j = tri[t * 3 + ((e + 1) % 3)]!;
      const a: Vec3 = [fit.positions[i * 3]!, fit.positions[i * 3 + 1]!, fit.positions[i * 3 + 2]!];
      const b: Vec3 = [fit.positions[j * 3]!, fit.positions[j * 3 + 1]!, fit.positions[j * 3 + 2]!];
      const da = dot(a, n) - z;
      const db = dot(b, n) - z;
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        const s = da / (da - db);
        pts.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), a[2] + s * (b[2] - a[2])]);
      }
    }
    if (pts.length !== 2) continue;
    // Material to the left: the segment runs along n × (triangle normal).
    const [i0, i1, i2] = [tri[t * 3]!, tri[t * 3 + 1]!, tri[t * 3 + 2]!];
    const a: Vec3 = [fit.positions[i0 * 3]!, fit.positions[i0 * 3 + 1]!, fit.positions[i0 * 3 + 2]!];
    const b: Vec3 = [fit.positions[i1 * 3]!, fit.positions[i1 * 3 + 1]!, fit.positions[i1 * 3 + 2]!];
    const c: Vec3 = [fit.positions[i2 * 3]!, fit.positions[i2 * 3 + 1]!, fit.positions[i2 * 3 + 2]!];
    const along = cross(n, cross(sub(b, a), sub(c, a)));
    let [s0, s1] = pts as [Vec3, Vec3];
    if (dot(sub(s1, s0), along) < 0) [s0, s1] = [s1, s0];
    if (len(sub(s1, s0)) < q) continue;
    const id = segs.length;
    segs.push({ a: s0, b: s1, region: fit.triangleRegion[t]!, used: false });
    at.set(key(s0), [...(at.get(key(s0)) ?? []), id]);
  }
  const loops: Loop[] = [];
  for (let start = 0; start < segs.length; start++) {
    if (segs[start]!.used) continue;
    const chain: typeof segs = [];
    let cur = segs[start]!;
    for (let guard = 0; guard < segs.length + 1; guard++) {
      cur.used = true;
      chain.push(cur);
      const next = (at.get(key(cur.b)) ?? []).map((i) => segs[i]!).find((s) => !s.used);
      if (!next) break;
      cur = next;
    }
    // Closed when the chain returns to its start.
    if (chain.length < 3 || key(chain[chain.length - 1]!.b) !== key(chain[0]!.a)) continue;
    const runs: Run[] = [];
    for (const s of chain) {
      const last = runs[runs.length - 1];
      if (last && last.region === s.region) last.points.push(s.b);
      else runs.push({ region: s.region, points: [s.a, s.b] });
    }
    // The last run may continue into the first.
    if (runs.length > 1 && runs[0]!.region === runs[runs.length - 1]!.region) {
      const tail = runs.pop()!;
      runs[0]!.points = [...tail.points.slice(0, -1), ...runs[0]!.points];
    }
    loops.push(runs);
  }
  return loops;
}

// ---------------------------------------------------------------- sketch

/** Diameter parameters shared by holes of the same size. */
class HoleParams {
  private readonly radii: { r: number; param: string }[] = [];
  constructor(
    private readonly params: Record<string, Expr>,
    private readonly measurements: Measurement[],
    private readonly tol: number,
  ) {}
  diameterParam(r: number): string {
    const hit = this.radii.find((x) => Math.abs(x.r - r) <= this.tol * 2);
    if (hit) return hit.param;
    const param = `hole_d${this.radii.length + 1}`;
    this.radii.push({ r, param });
    this.params[param] = `${round3(2 * r)} mm`;
    this.measurements.push({ param, label: `Hole diameter (${fmt(2 * r)} mm)`, value: round3(2 * r), kind: "diameter" });
    return param;
  }
}

interface SketchOut {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

/** Most points a layer's sketch may have: the constraint solver slows down and runs out of memory beyond that. */
const MAX_SKETCH_POINTS = 300;

type Piece = { kind: "line"; a: Vec3; b: Vec3 } | { kind: "arc"; a: Vec3; b: Vec3; center: Vec3; radius: number; ccw: boolean };

function sketchOf(loops: Loop[], frame: PlaneFrame, fit: MeshFit, tol: number, layer: number, params: Record<string, Expr>, measurements: Measurement[], holes: HoleParams): SketchOut {
  const entities: SketchEntity[] = [];
  const constraints: SketchConstraint[] = [];
  let np = 0;
  let nl = 0;
  let na = 0;
  let nc = 0;
  let ncs = 0;
  const fixed = new Set<string>();
  const to2 = (v: Vec3): Vec2 => {
    const [x, y] = toSketch(frame, v);
    return [round(x), round(y)];
  };
  const point = (v: Vec3, construction = false): string => {
    const id = `p${++np}`;
    const [x, y] = to2(v);
    entities.push({ id, type: "point", x, y, ...(construction ? { construction: true } : {}) });
    return id;
  };
  const fix = (id: string) => {
    if (fixed.has(id)) return;
    fixed.add(id);
    constraints.push({ id: `k${++ncs}`, type: "fix", point: id });
  };
  const n = frame.normal;
  // Straight stretches are simplified as a whole (the strips of a tessellated curve give many tiny
  // runs); the tolerance grows until the sketch stays small enough for the solver.
  let simplifyTol = Math.max(tol * 2, fit.diag / 1500);
  let pieced: { loop: Loop; pieces: Piece[]; circle: { center: Vec3; radius: number } | null }[];
  for (;;) {
    pieced = loops.map((loop) => {
      const only = loop.length === 1 ? loop[0]! : null;
      const circle = only && roundRun(only, fit, n, tol);
      return { loop, pieces: circle ? [] : piecesOf(loop, fit, n, tol, simplifyTol), circle };
    });
    const points = pieced.reduce((s, l) => s + (l.circle ? 1 : l.pieces.length + l.pieces.filter((pc) => pc.kind === "arc").length), 0);
    if (points <= MAX_SKETCH_POINTS || simplifyTol > fit.diag / 20) break;
    /* v8 ignore next -- an outline of more points than the sketch solver takes: not among the test meshes */
    simplifyTol *= 1.6;
  }
  let rects = 0;
  for (const { pieces, circle } of pieced) {
    if (circle) {
      const c = point(circle.center);
      fix(c);
      const id = `ci${++nc}`;
      entities.push({ id, type: "circle", center: c, radius: round(circle.radius) });
      constraints.push({ id: `k${++ncs}`, type: "diameter", curve: id, value: holes.diameterParam(circle.radius) });
      continue;
    }
    if (pieces.length < 3 && !pieces.some((pc) => pc.kind === "arc")) continue;
    // A sliver with no area (a wall thinner than the simplification) cannot be extruded, nor can
    // a loop that crosses itself after simplification.
    if (Math.abs(loopArea(pieces, frame)) < tol * Math.max(1, fit.diag / 100) || selfIntersects(pieces, frame)) continue;
    // Shared point entities at the joints.
    const ids = pieces.map((pc) => point(pc.a));
    const endOf = (i: number) => ids[(i + 1) % ids.length]!;
    const lines: string[] = [];
    pieces.forEach((pc, i) => {
      if (pc.kind === "line") {
        const id = `l${++nl}`;
        entities.push({ id, type: "line", p1: ids[i]!, p2: endOf(i) });
        lines.push(id);
      } else {
        // Ends fixed (shared with the neighbours) and the radius given: the centre follows.
        const c = point(pc.center);
        const id = `a${++na}`;
        entities.push({ id, type: "arc", center: c, start: pc.ccw ? ids[i]! : endOf(i), end: pc.ccw ? endOf(i) : ids[i]! });
        // The ends are rounded to µm: the radius must still reach across them.
        const chord = len(sub(pc.b, pc.a));
        constraints.push({ id: `k${++ncs}`, type: "radius", curve: id, value: round(Math.max(pc.radius, chord / 2 + 0.002)) });
      }
    });
    const rect = pieces.length === 4 && pieces.every((pc) => pc.kind === "line") ? rectangle(pieces as { a: Vec3; b: Vec3 }[], frame, tol) : null;
    if (rect) {
      rects++;
      const suffix = rects > 1 ? `_${rects}` : "";
      const w = `width${layer}${suffix}`;
      const d = `depth${layer}${suffix}`;
      params[w] = `${rect.w} mm`;
      params[d] = `${rect.d} mm`;
      measurements.push({ param: w, label: layer === 1 && rects === 1 ? "Overall width (X)" : `Width of layer ${layer}${suffix ? ` shape ${rects}` : ""}`, value: rect.w, kind: "size" });
      measurements.push({ param: d, label: layer === 1 && rects === 1 ? "Overall depth (Y)" : `Depth of layer ${layer}${suffix ? ` shape ${rects}` : ""}`, value: rect.d, kind: "size" });
      lines.forEach((l, i) => constraints.push({ id: `k${++ncs}`, type: rect.horizontalFirst === (i % 2 === 0) ? "horizontal" : "vertical", line: l }));
      constraints.push({ id: `k${++ncs}`, type: "length", line: lines[rect.horizontalFirst ? 0 : 1]!, value: w });
      constraints.push({ id: `k${++ncs}`, type: "length", line: lines[rect.horizontalFirst ? 1 : 0]!, value: d });
      fix(ids[0]!);
    } else {
      for (const id of ids) fix(id);
    }
  }
  return { entities, constraints };
}

/** Signed area of a loop's pieces in the sketch plane (arcs counted by their chords). */
function loopArea(pieces: Piece[], frame: PlaneFrame): number {
  let area = 0;
  for (const pc of pieces) {
    const [ax, ay] = toSketch(frame, pc.a);
    const [bx, by] = toSketch(frame, pc.b);
    area += ax * by - bx * ay;
  }
  return area / 2;
}

/** Whether any two non-adjacent pieces of a loop cross (arcs taken as their chords). */
function selfIntersects(pieces: Piece[], frame: PlaneFrame): boolean {
  const segs = pieces.map((pc) => [toSketch(frame, pc.a), toSketch(frame, pc.b)] as [Vec2, Vec2]);
  const cross2 = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const n = segs.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b] = segs[i]!;
      const [c, d] = segs[j]!;
      const d1 = cross2(a, b, c), d2 = cross2(a, b, d), d3 = cross2(c, d, a), d4 = cross2(c, d, b);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  return false;
}

/** A loop as arcs (runs on round surfaces square to the plane) and simplified straight chains. */
function piecesOf(loop: Loop, fit: MeshFit, n: Vec3, tol: number, simplifyTol: number): Piece[] {
  // Arcs stay; everything between two arcs is one chain of points.
  const parts: ({ arc: Piece & { kind: "arc" } } | { chain: Vec3[] })[] = [];
  for (const run of loop) {
    const arc = run.points.length >= 3 ? roundRun(run, fit, n, tol) : null;
    const first = run.points[0]!;
    const last = run.points[run.points.length - 1]!;
    // Arcs shorter than a few tolerances or flatter than 5° are as good as straight, and the
    // solver copes better with lines there.
    if (arc && len(sub(last, first)) > tol * 4 && Math.asin(Math.min(1, len(sub(last, first)) / 2 / arc.radius)) * 2 > (5 * Math.PI) / 180) {
      const mid = run.points[Math.floor(run.points.length / 2)]!;
      const ccw = dot(cross(sub(first, arc.center), sub(mid, arc.center)), n) > 0;
      parts.push({ arc: { kind: "arc", a: first, b: last, center: arc.center, radius: arc.radius, ccw } });
      continue;
    }
    const prev = parts[parts.length - 1];
    if (prev && "chain" in prev) for (const q of run.points.slice(1)) prev.chain.push(q);
    else parts.push({ chain: [...run.points] });
  }
  // A chain at the end continues into one at the start.
  /* v8 ignore start -- a loop whose seam falls inside a straight stretch: not among the test meshes */
  if (parts.length > 1 && "chain" in parts[0]! && "chain" in parts[parts.length - 1]!) {
    const tail = parts.pop() as { chain: Vec3[] };
    (parts[0] as { chain: Vec3[] }).chain = [...tail.chain.slice(0, -1), ...(parts[0] as { chain: Vec3[] }).chain];
  }
  /* v8 ignore stop */
  const pieces: Piece[] = [];
  const q = 0.0005;
  const same = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) < q && Math.abs(a[1] - b[1]) < q && Math.abs(a[2] - b[2]) < q;
  for (const part of parts) {
    if ("arc" in part) {
      pieces.push(part.arc);
      continue;
    }
    let simplified: Vec3[];
    if (parts.length === 1) {
      // A closed ring: split at the point farthest from the start so both halves are open polylines.
      const pts = part.chain;
      let far = 1;
      for (let i = 2; i < pts.length - 1; i++) if (len(sub(pts[i]!, pts[0]!)) > len(sub(pts[far]!, pts[0]!))) far = i;
      simplified = [...simplify(pts.slice(0, far + 1), simplifyTol).slice(0, -1), ...simplify(pts.slice(far), simplifyTol)];
    } else simplified = simplify(part.chain, simplifyTol);
    for (let i = 0; i + 1 < simplified.length; i++) if (!same(simplified[i]!, simplified[i + 1]!)) pieces.push({ kind: "line", a: simplified[i]!, b: simplified[i + 1]! });
  }
  return pieces;
}

/** Centre and radius of a run that lies on a cylinder or cone square to the plane, in the plane. */
function roundRun(run: Run, fit: MeshFit, n: Vec3, tol: number): { center: Vec3; radius: number } | null {
  const s = fit.regions[run.region]?.primitive;
  if (!s || (s.kind !== "cylinder" && s.kind !== "cone") || Math.abs(dot(s.axis, n)) < COS_2DEG) return null;
  const base = s.kind === "cylinder" ? s.origin : s.apex;
  const z = dot(run.points[0]!, n);
  const center: Vec3 = [0, 1, 2].map((k) => base[k]! + s.axis[k]! * ((z - dot(base, n)) / dot(s.axis, n))) as Vec3;
  // The recognised cylinder's radius is exact; the slice points of a tessellated wall lie on it.
  let radius = 0;
  if (s.kind === "cylinder") radius = s.radius;
  /* v8 ignore start -- a section across a cone: the layers are cut through flat faces and cylinders in the test meshes */
  else {
    for (const q of run.points) radius += len(sub(q, center));
    radius /= run.points.length;
  }
  /* v8 ignore stop */
  if (run.points.some((q) => Math.abs(len(sub(q, center)) - radius) > tol * 4)) return null;
  return { center, radius };
}

/** Douglas-Peucker. */
function simplify(points: Vec3[], tol: number): Vec3[] {
  if (points.length <= 2) return points;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const d = sub(b, a);
  const l = len(d) || 1;
  let worst = 0;
  let at = -1;
  for (let i = 1; i + 1 < points.length; i++) {
    const dist = len(cross(sub(points[i]!, a), d)) / l;
    if (dist > worst) {
      worst = dist;
      at = i;
    }
  }
  if (worst <= tol || at < 0) return [a, b];
  return [...simplify(points.slice(0, at + 1), tol).slice(0, -1), ...simplify(points.slice(at), tol)];
}

function rectangle(pieces: { a: Vec3; b: Vec3 }[], frame: PlaneFrame, tol: number): { w: number; d: number; horizontalFirst: boolean } | null {
  const dirs = pieces.map((pc) => {
    const [ax, ay] = toSketch(frame, pc.a);
    const [bx, by] = toSketch(frame, pc.b);
    return { dx: bx - ax, dy: by - ay };
  });
  // Only when the lines are truly axis-aligned: a slightly skewed quad with horizontal/vertical
  // constraints and fixed corners would conflict.
  const horizontal = dirs.map((d) => Math.abs(d.dy) <= tol * 0.05 && Math.abs(d.dx) > tol);
  const vertical = dirs.map((d) => Math.abs(d.dx) <= tol * 0.05 && Math.abs(d.dy) > tol);
  const ok = dirs.every((_, i) => (i % 2 === 0 ? horizontal[i] && vertical[(i + 1) % 4] : vertical[i] && horizontal[(i + 1) % 4])) || dirs.every((_, i) => (i % 2 === 0 ? vertical[i] && horizontal[(i + 1) % 4] : horizontal[i] && vertical[(i + 1) % 4]));
  if (!ok) return null;
  const horizontalFirst = !!horizontal[0];
  const w = round3(Math.abs(horizontalFirst ? dirs[0]!.dx : dirs[1]!.dx));
  const d = round3(Math.abs(horizontalFirst ? dirs[1]!.dy : dirs[0]!.dy));
  return { w, d, horizontalFirst };
}
