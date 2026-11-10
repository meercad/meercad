/**
 * Cables laid through 3D points: the centre line (a smooth curve through the points that leaves
 * the ends straight), plugs on the ends, the cable's mesh, and the checks while joints move
 * (stretched, bent too tight, running into a part).
 *
 * The same layout serves the kernel (which sweeps the cable's section along the sampled centre
 * line) and the app (which lays the cable again in every pose of the mechanism), so what is drawn
 * while parts move is the cable that was built.
 */
import type { CableConnectorKind, CableMaterialKind } from "@meercad/schema";
import { MeshCollider, meshesCollide } from "./collide.js";
import { IDENTITY, transformDir, transformPoint, type Mat4, type V3 } from "./motion.js";
import type { ResolvedCable, ResolvedCableConnector } from "./resolve.js";

// ---------------------------------------------------------------- specs

/** Insulation types: density of the whole cable (copper included, typical gauges) and the bend radius as a multiple of the diameter. */
export const CABLE_MATERIALS: Record<CableMaterialKind, { name: string; material: string; bend: number }> = {
  silicone: { name: "Silicone", material: "cablesilicone", bend: 3 },
  pvc: { name: "PVC", material: "cablepvc", bend: 6 },
  ptfe: { name: "PTFE", material: "cableptfe", bend: 8 },
};
/** Material id of ribbon cables (PVC flat cable, 28 AWG). */
export const RIBBON_MATERIAL = "cableribbon";
/** Wire pitch of ribbon cables, mm. */
export const RIBBON_PITCH = 1.27;
export const RIBBON_THICKNESS = 0.9;
export const RIBBON_BEND = 3;

export interface PlugSize {
  label: string;
  /** Across the contacts, mm. */
  width: number;
  height: number;
  /** From the mating face to the back, where the cable leaves, mm. */
  length: number;
  pins: number;
}

const PLUGS: Record<CableConnectorKind, { label: string; pitch?: number; pins: [number, number, number]; size: (n: number) => [number, number, number] }> = {
  // [min, max, default pins]; size: width, height, length (typical housings)
  jst_xh: { label: "JST XH", pitch: 2.5, pins: [1, 16, 2], size: (n) => [2.5 * n + 2.4, 5.75, 7] },
  jst_ph: { label: "JST PH", pitch: 2, pins: [1, 16, 2], size: (n) => [2 * n + 1.9, 4.5, 6] },
  jst_sh: { label: "JST SH", pitch: 1, pins: [1, 16, 2], size: (n) => [n + 3, 2.9, 4.25] },
  dupont: { label: "Dupont", pitch: 2.54, pins: [1, 16, 1], size: (n) => [2.54 * n, 2.54, 14] },
  xt30: { label: "XT30", pins: [2, 2, 2], size: () => [10.2, 5.2, 15.5] },
  xt60: { label: "XT60", pins: [2, 2, 2], size: () => [15.8, 8.2, 23.5] },
  idc: { label: "IDC", pitch: 2.54, pins: [2, 64, 10], size: (n) => [2.54 * Math.ceil(n / 2) + 7.6, 9, 6.5] },
};

export const CABLE_PLUG_KINDS = Object.keys(PLUGS) as CableConnectorKind[];
export const plugLabel = (k: CableConnectorKind) => PLUGS[k].label;

/** Size of a plug; IDC plugs default to the ribbon's conductors. */
export function plugSize(c: ResolvedCableConnector, conductors?: number): PlugSize {
  const p = PLUGS[c.kind];
  const [lo, hi, dflt] = p.pins;
  const n = c.pins ?? (c.kind === "idc" && conductors ? conductors : dflt);
  if (n < lo || n > hi) throw new CableError(`a ${p.label} plug has ${lo === hi ? lo : `${lo} to ${hi}`} contacts`);
  if (c.kind === "idc" && n % 2) throw new CableError("an IDC plug has an even number of contacts");
  const [width, height, length] = p.size(n);
  return { label: p.label, width, height, length, pins: n };
}

export class CableError extends Error {}

/** A cable's numbers with its defaults filled in. */
export interface CableSpec {
  shape: "round" | "ribbon";
  /** Section across the cable: round both the diameter; ribbon its width and thickness. */
  width: number;
  thickness: number;
  conductors?: number;
  bendRadius: number;
  slack: number;
  /** Material id in the library (density, look). */
  material: string;
  start?: PlugSize;
  end?: PlugSize;
}

export function cableSpec(f: Pick<ResolvedCable, "shape" | "diameter" | "conductors" | "material" | "bendRadius" | "slack" | "start" | "end">): CableSpec {
  const ribbon = f.shape === "ribbon";
  const conductors = ribbon ? (f.conductors ?? 10) : undefined;
  if (conductors !== undefined && (conductors < 2 || conductors > 80)) throw new CableError("a ribbon cable has 2 to 80 conductors");
  const d = ribbon ? 0 : f.diameter ?? 0;
  if (!ribbon && !(d > 0)) throw new CableError("the diameter must be greater than zero");
  if (!ribbon && d > 50) throw new CableError("the diameter is at most 50 mm");
  const mat = CABLE_MATERIALS[f.material ?? "silicone"];
  const bendRadius = f.bendRadius ?? (ribbon ? RIBBON_BEND : mat.bend * d);
  if (!(bendRadius >= 0)) throw new CableError("the bend radius cannot be negative");
  const slack = f.slack ?? 0;
  if (!(slack >= 0)) throw new CableError("the slack cannot be negative");
  return {
    shape: ribbon ? "ribbon" : "round",
    width: ribbon ? conductors! * RIBBON_PITCH : d,
    thickness: ribbon ? RIBBON_THICKNESS : d,
    ...(conductors !== undefined ? { conductors } : {}),
    bendRadius,
    slack,
    material: ribbon ? RIBBON_MATERIAL : mat.material,
    ...(f.start ? { start: plugSize(f.start, conductors) } : {}),
    ...(f.end ? { end: plugSize(f.end, conductors) } : {}),
  };
}

// ---------------------------------------------------------------- vectors

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
/** A unit vector across `t`, as close to `hint` as possible. */
function across(t: V3, hint?: V3): V3 {
  for (const h of [hint, [0, 0, 1] as V3, [1, 0, 0] as V3]) {
    if (!h) continue;
    const w = sub(h, [t[0] * dot(h, t), t[1] * dot(h, t), t[2] * dot(h, t)]);
    if (len(w) > 1e-6) return unit(w);
  }
  return [0, 1, 0];
}

// ---------------------------------------------------------------- layout

/** How the cable's ends sit: directions and the section's turn, from the cable as drawn. */
export interface CableEnds {
  /** Direction the cable leaves the first point in (into the route). */
  startDir: V3;
  /** Direction the cable arrives at the last point in. */
  endDir: V3;
  /** Across the cable at the start: a ribbon's width, a plug's width. */
  startAcross: V3;
  endAcross: V3;
}

/** The ends of a cable as drawn: straight towards the next point. */
export function restEnds(points: readonly V3[]): CableEnds {
  if (points.length < 2) throw new CableError("a cable needs at least two points");
  const n = points.length;
  const startDir = unit(sub(points[1]!, points[0]!));
  const endDir = unit(sub(points[n - 1]!, points[n - 2]!));
  if (len(sub(points[1]!, points[0]!)) < 1e-6 || len(sub(points[n - 1]!, points[n - 2]!)) < 1e-6) throw new CableError("two points of the cable lie on top of each other");
  // Plugs and ribbons lie flat: their width level (across the cable and Z), unless the cable runs along Z.
  return { startDir, endDir, startAcross: across(startDir, cross([0, 0, 1], startDir)), endAcross: across(endDir, cross([0, 0, 1], endDir)) };
}

export interface PlacedPlug {
  size: PlugSize;
  /** Middle of the mating face (the end point). */
  at: V3;
  /** From the mating face towards the cable (the plug's length runs along it). */
  dir: V3;
  across: V3;
}

export interface CableLayout {
  /** Centre line, from the start to the end of the cable itself (between the plugs). */
  line: V3[];
  /** Arc length at each sample of `line`. */
  arc: number[];
  /** Unit direction of the line at each sample. */
  tangent: V3[];
  /** Section frame along the line: across (width) at each sample. */
  across: V3[];
  /** Length of the cable between the plugs (inside them not counted), mm. */
  length: number;
  /** Tightest bend of the centre line, mm (Infinity when straight), and its arc position. */
  minRadius: number;
  minRadiusArc: number;
  /** Arc position of each point the cable runs through (ends: 0 and `length`). */
  pointArc: number[];
  plugs: PlacedPlug[];
  /**
   * The centre line exactly: cubic Hermite pieces between `nodes` (the points, the ends moved to the
   * plugs' backs) with unit `nodeTangents`, piece i parametrised over the chord to the next node.
   * The kernel sweeps along this curve; `line` samples it.
   */
  nodes: V3[];
  nodeTangents: V3[];
}

/** How far the cable runs inside a plug, so plug and cable join into one solid. */
const plugOverlap = (p: PlugSize) => Math.min(1, p.length / 4);

/**
 * The centre line through `points` (model coordinates) leaving the ends along `ends`: a smooth
 * curve through every point (Catmull–Rom by chord length), sampled about every `step` mm. With a
 * plug on an end, the cable leaves the plug's back.
 */
export function layCable(spec: CableSpec, points: readonly V3[], ends: CableEnds, step = Math.max(0.5, Math.min(2, spec.width / 2))): CableLayout {
  if (points.length < 2) throw new CableError("a cable needs at least two points");
  const n = points.length;
  const plugs: PlacedPlug[] = [];
  const q: V3[] = points.map((p) => [...p] as V3);
  let inside = 0;
  if (spec.start) {
    plugs.push({ size: spec.start, at: points[0]!, dir: ends.startDir, across: ends.startAcross });
    const back = spec.start.length - plugOverlap(spec.start);
    q[0] = add(points[0]!, ends.startDir, back);
    inside += plugOverlap(spec.start);
  }
  if (spec.end) {
    const dir: V3 = [-ends.endDir[0], -ends.endDir[1], -ends.endDir[2]];
    plugs.push({ size: spec.end, at: points[n - 1]!, dir, across: ends.endAcross });
    q[n - 1] = add(points[n - 1]!, dir, spec.end.length - plugOverlap(spec.end));
    inside += plugOverlap(spec.end);
  }
  // A plug must not reach past the next point.
  const h = q.slice(1).map((p, i) => len(sub(p, q[i]!)));
  if (h.some((x) => x < 1e-6)) throw new CableError("two points of the cable lie on top of each other");
  const past = "a plug reaches past the next point: move the point farther from the plug";
  if (spec.start && dot(sub(q[1]!, q[0]!), ends.startDir) <= 0) throw new CableError(past);
  if (spec.end && dot(sub(q[n - 1]!, q[n - 2]!), ends.endDir) <= 0) throw new CableError(past);
  // Tangents (per mm of chord): the ends along their directions, inside by central differences.
  const tan: V3[] = q.map((_, i) => {
    if (i === 0) return ends.startDir;
    if (i === q.length - 1) return ends.endDir;
    return unit(sub(q[i + 1]!, q[i - 1]!));
  });
  const line: V3[] = [q[0]!];
  const arc: number[] = [0];
  const pointArc: number[] = [0];
  let minRadius = Infinity;
  let minRadiusArc = 0;
  let s = 0;
  const curvature = (i: number, u: number) => {
    const hi = h[i]!;
    const [p0, p1, m0, m1] = [q[i]!, q[i + 1]!, tan[i]!, tan[i + 1]!];
    const d1 = (k: number) => (6 * u * u - 6 * u) * p0[k]! + (3 * u * u - 4 * u + 1) * hi * m0[k]! + (-6 * u * u + 6 * u) * p1[k]! + (3 * u * u - 2 * u) * hi * m1[k]!;
    const d2 = (k: number) => (12 * u - 6) * p0[k]! + (6 * u - 4) * hi * m0[k]! + (-12 * u + 6) * p1[k]! + (6 * u - 2) * hi * m1[k]!;
    const a: V3 = [d1(0), d1(1), d1(2)];
    const b: V3 = [d2(0), d2(1), d2(2)];
    const la = len(a);
    return la > 1e-12 ? len(cross(a, b)) / la ** 3 : 0;
  };
  for (let i = 0; i < h.length; i++) {
    const hi = h[i]!;
    const count = Math.max(4, Math.min(2000, Math.ceil(hi / step)));
    const [p0, p1, m0, m1] = [q[i]!, q[i + 1]!, tan[i]!, tan[i + 1]!];
    for (let k = 1; k <= count; k++) {
      const u = k / count;
      const u2 = u * u;
      const u3 = u2 * u;
      const a = 2 * u3 - 3 * u2 + 1;
      const b = (u3 - 2 * u2 + u) * hi;
      const c = -2 * u3 + 3 * u2;
      const d = (u3 - u2) * hi;
      const p: V3 = [0, 1, 2].map((j) => a * p0[j]! + b * m0[j]! + c * p1[j]! + d * m1[j]!) as V3;
      s += len(sub(p, line[line.length - 1]!));
      line.push(p);
      arc.push(s);
      const kappa = curvature(i, u - 0.5 / count);
      if (kappa > 1e-9 && 1 / kappa < minRadius) {
        minRadius = 1 / kappa;
        minRadiusArc = s;
      }
    }
    pointArc.push(s);
  }
  // Section frames that turn as little as possible along the line (double reflection, Wang et al.).
  const N = line.length;
  const T: V3[] = line.map((_, i) => (i === 0 ? ends.startDir : i === N - 1 ? ends.endDir : unit(sub(line[i + 1]!, line[i - 1]!))));
  const acr: V3[] = [across(T[0]!, ends.startAcross)];
  const reflect = (v: V3, n: V3, c: number): V3 => add(v, n, (-2 / c) * dot(n, v));
  for (let i = 1; i < N; i++) {
    const v1 = sub(line[i]!, line[i - 1]!);
    const c1 = dot(v1, v1) || 1;
    const rL = reflect(acr[i - 1]!, v1, c1);
    const tL = reflect(T[i - 1]!, v1, c1);
    const v2 = sub(T[i]!, tL);
    const c2 = dot(v2, v2);
    acr.push(across(T[i]!, c2 > 1e-18 ? reflect(rL, v2, c2) : rL));
  }
  return { line, arc, tangent: T, across: acr, length: s + inside, minRadius, minRadiusArc, pointArc, plugs, nodes: q, nodeTangents: tan };
}

// ---------------------------------------------------------------- mesh

export interface CableMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Triangles of the cable (closed at both ends) and its plugs. `keep(i)` leaves out the stretch
 * from sample i to i + 1 when false (the collision test skips the cable near its fixings).
 */
export function cableMesh(layout: CableLayout, spec: CableSpec, opts: { sides?: number; plugs?: boolean; keep?: (i: number) => boolean } = {}): CableMesh {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const { line, across: acr } = layout;
  const N = line.length;
  const tangent = (i: number) => layout.tangent[i]!;
  // Section outline at a sample: points and normals (in the frame across, up).
  const sides = opts.sides ?? 12;
  const ring: { x: number; y: number; nx: number; ny: number }[] = [];
  if (spec.shape === "round") {
    for (let k = 0; k < sides; k++) {
      const a = (2 * Math.PI * k) / sides;
      ring.push({ x: (Math.cos(a) * spec.width) / 2, y: (Math.sin(a) * spec.width) / 2, nx: Math.cos(a), ny: Math.sin(a) });
    }
  } else {
    // A flat rectangle, its corners doubled so each side keeps its own normal.
    const w = spec.width / 2;
    const t = spec.thickness / 2;
    const quad: [number, number][] = [[w, -t], [w, t], [-w, t], [-w, -t]];
    const norms: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let k = 0; k < 4; k++) {
      const [a, b] = [quad[k]!, quad[(k + 1) % 4]!];
      ring.push({ x: a[0], y: a[1], nx: norms[k]![0], ny: norms[k]![1] }, { x: b[0], y: b[1], nx: norms[k]![0], ny: norms[k]![1] });
    }
  }
  const R = ring.length;
  const flat = spec.shape === "ribbon";
  const ringAt = (i: number) => {
    const t = tangent(i);
    const a = acr[i]!;
    const up = cross(t, a);
    const base = pos.length / 3;
    for (const r of ring) {
      const p = add(add(line[i]!, a, r.x), up, r.y);
      const nn = add([a[0] * r.nx, a[1] * r.nx, a[2] * r.nx], up, r.ny);
      pos.push(...p);
      nor.push(...nn);
    }
    return base;
  };
  let prev: number | null = null;
  const caps: { base: number; i: number; out: V3 }[] = [];
  for (let i = 0; i < N; i++) {
    const keepIn = i > 0 && (opts.keep?.(i - 1) ?? true);
    const keepOut = i < N - 1 && (opts.keep?.(i) ?? true);
    if (!keepIn && !keepOut) {
      prev = null;
      continue;
    }
    const base = ringAt(i);
    if (keepIn && prev !== null) {
      if (flat) for (let k = 0; k < R; k += 2) quad(idx, prev + k, prev + k + 1, base + k + 1, base + k);
      else for (let k = 0; k < R; k++) quad(idx, prev + k, prev + ((k + 1) % R), base + ((k + 1) % R), base + k);
    }
    if (!keepIn) caps.push({ base, i, out: tangent(i).map((v) => -v) as V3 });
    if (!keepOut) caps.push({ base, i, out: tangent(i) });
    prev = base;
  }
  // Flat caps: a fan round the section's middle.
  for (const c of caps) {
    const mid = pos.length / 3;
    pos.push(...line[c.i]!);
    nor.push(...c.out);
    const start = pos.length / 3;
    for (let k = 0; k < R; k++) {
      pos.push(pos[(c.base + k) * 3]!, pos[(c.base + k) * 3 + 1]!, pos[(c.base + k) * 3 + 2]!);
      nor.push(...c.out);
    }
    const forward = dot(c.out, tangent(c.i)) > 0;
    for (let k = 0; k < R; k++) {
      const a = start + k;
      const b = start + ((k + 1) % R);
      if (forward) idx.push(mid, a, b);
      else idx.push(mid, b, a);
    }
  }
  if (opts.plugs !== false) for (const p of layout.plugs) plugBox(p, pos, nor, idx);
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx) };
}

function quad(idx: number[], a: number, b: number, c: number, d: number) {
  idx.push(a, b, c, a, c, d);
}

/** Corners of a plug's housing (8, in the order x, y, z bits: along, across, up). */
export function plugCorners(p: PlacedPlug): V3[] {
  const up = cross(p.dir, p.across);
  const out: V3[] = [];
  for (let c = 0; c < 8; c++) {
    const a = c & 1 ? p.size.length : 0;
    const w = ((c & 2 ? 1 : -1) * p.size.width) / 2;
    const h = ((c & 4 ? 1 : -1) * p.size.height) / 2;
    out.push(add(add(add(p.at, p.dir, a), p.across, w), up, h));
  }
  return out;
}

function plugBox(p: PlacedPlug, pos: number[], nor: number[], idx: number[]) {
  const c = plugCorners(p);
  const up = cross(p.dir, p.across);
  const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
  // Each face: four corners (counter-clockwise seen from outside) and its normal.
  const faces: [number[], V3][] = [
    [[0, 4, 6, 2], neg(p.dir)],
    [[1, 3, 7, 5], p.dir],
    [[0, 1, 5, 4], neg(p.across)],
    [[2, 6, 7, 3], p.across],
    [[0, 2, 3, 1], neg(up)],
    [[4, 5, 7, 6], up],
  ];
  for (const [ks, n] of faces) {
    const base = pos.length / 3;
    for (const k of ks) {
      pos.push(...c[k]!);
      nor.push(...n);
    }
    // Wind so the triangle faces along n.
    const e1 = sub(c[ks[1]!]!, c[ks[0]!]!);
    const e2 = sub(c[ks[2]!]!, c[ks[0]!]!);
    if (dot(cross(e1, e2), n) >= 0) quad(idx, base, base + 1, base + 2, base + 3);
    else quad(idx, base, base + 3, base + 2, base + 1);
  }
}

// ---------------------------------------------------------------- moving

/** A cable as built: what it needs to be laid again with its points moved. */
export interface CableRig {
  id: string;
  spec: CableSpec;
  points: { at: V3; on?: string }[];
  ends: CableEnds;
  rest: CableLayout;
}

export function cableRig(f: ResolvedCable): CableRig {
  const spec = cableSpec(f);
  const pts = f.points.map((p) => p.at as V3);
  const first = restEnds(pts);
  // The far end's section turned the way the cable arrives there as drawn (a ribbon's plug lines up with it).
  const ends = { ...first, endAcross: layCable(spec, pts, first).across.at(-1)! };
  return { id: f.id, spec, points: f.points.map((p) => ({ at: p.at as V3, ...(p.on ? { on: p.on } : {}) })), ends, rest: layCable(spec, pts, ends) };
}

/** The cable laid with each point moved along with its part (poses by body id; missing: at rest). */
export function layInPose(rig: CableRig, poses: ReadonlyMap<string, Mat4>): CableLayout {
  const pose = (on?: string) => (on && poses.get(on)) || IDENTITY;
  const pts = rig.points.map((p) => transformPoint(pose(p.on), p.at));
  const first = pose(rig.points[0]!.on);
  const last = pose(rig.points[rig.points.length - 1]!.on);
  const ends: CableEnds = {
    startDir: transformDir(first, rig.ends.startDir),
    endDir: transformDir(last, rig.ends.endDir),
    startAcross: transformDir(first, rig.ends.startAcross),
    endAcross: transformDir(last, rig.ends.endAcross),
  };
  return layCable(rig.spec, pts, ends);
}

export interface CableState {
  id: string;
  /** Length the route needs now, mm. */
  needed: number;
  /** Length of the cable (as drawn plus slack), mm. */
  available: number;
  /** How much longer the route is than the cable (> 0: stretched), mm. */
  stretch: number;
  minRadius: number;
  bendRadius: number;
  /** Parts it runs into (body ids). */
  hits: string[];
  /** Laying it failed (points on top of each other, a plug past the next point). */
  error?: string;
}

/** Stretch below this (mm, and per mille of the length) counts as just taut. */
const STRETCH_TOLERANCE = (available: number) => Math.max(0.05, available * 1e-3);
export const isStretched = (s: Pick<CableState, "stretch" | "available">) => s.stretch > STRETCH_TOLERANCE(s.available);
/** Bent tighter than allowed (a little below, by the sampling, still counts as fine). */
export const isTooTight = (s: Pick<CableState, "minRadius" | "bendRadius">) => s.minRadius < s.bendRadius * 0.98;
export const cableTrouble = (s: CableState) => !!s.error || isStretched(s) || isTooTight(s) || s.hits.length > 0;

export interface CollisionBody {
  id: string;
  /** The part's tree, or how to make it (only made when the boxes meet). */
  collider: MeshCollider | (() => MeshCollider);
  /** The part's box at rest, when known without the tree. */
  box?: Box;
  pose?: Mat4;
  /** The part stands still (at rest); the cable may lie on it near points fixed in place. */
  still: boolean;
  /** How far the part's display mesh may stray from its true surface, mm. */
  inset?: number;
}

/**
 * The cable in a pose: lengths, the tightest bend and the parts it runs into. Near each point the
 * cable may touch the part the point is fixed to (a clip, a socket), or any part standing still
 * when the point is fixed in place; plugs are not tested (they sit in their sockets).
 */
export function checkCable(rig: CableRig, poses: ReadonlyMap<string, Mat4>, bodies: readonly CollisionBody[] = []): { state: CableState; layout: CableLayout | null } {
  const available = rig.rest.length + rig.spec.slack;
  let layout: CableLayout;
  try {
    layout = layInPose(rig, poses);
  } catch (e) {
    return { state: { id: rig.id, needed: NaN, available, stretch: 0, minRadius: Infinity, bendRadius: rig.spec.bendRadius, hits: [], error: (e as Error).message }, layout: null };
  }
  const hits: string[] = [];
  if (bodies.length) {
    const margin = Math.max(3, 2 * Math.max(rig.spec.width, rig.spec.thickness));
    const box = boundsOf(layout.line, Math.max(rig.spec.width, rig.spec.thickness) / 2);
    let whole: MeshCollider | null = null;
    // Half the section plus the longest step between samples: no stretch of the cable reaches farther from its samples.
    let step = 0;
    for (let i = 1; i < layout.line.length; i++) step = Math.max(step, Math.hypot(layout.line[i]![0] - layout.line[i - 1]![0], layout.line[i]![1] - layout.line[i - 1]![1], layout.line[i]![2] - layout.line[i - 1]![2]));
    const reach = Math.max(rig.spec.width, rig.spec.thickness) / 2 + step;
    for (const b of bodies) {
      if (b.id === rig.id) continue;
      const bb = placedBounds(b.box ?? treeOf(b).root, b.pose);
      if (!boxesMeet(box, bb)) continue;
      // The cable's own samples near the part's box at all? A long cable's box takes in half the
      // assembly, and the part's tree (slow to build) is only needed where the cable comes close.
      if (!layout.line.some((p) => p[0] >= bb.min[0] - reach && p[0] <= bb.max[0] + reach && p[1] >= bb.min[1] - reach && p[1] <= bb.max[1] + reach && p[2] >= bb.min[2] - reach && p[2] <= bb.max[2] + reach)) continue;
      // Stretches near points this part may touch.
      const near = rig.points.flatMap((p, k) => (p.on === b.id || (!p.on && b.still) ? [layout.pointArc[k]!] : []));
      let c: MeshCollider;
      if (!near.length) c = whole ??= colliderOf(cableMesh(layout, rig.spec, { sides: 8, plugs: false }));
      else {
        const keep = (i: number) => near.every((a) => Math.abs((layout.arc[i]! + layout.arc[i + 1]!) / 2 - a) > margin);
        const m = cableMesh(layout, rig.spec, { sides: 8, plugs: false, keep });
        if (!m.indices.length) continue;
        c = colliderOf(m);
      }
      if (meshesCollide(c, treeOf(b), IDENTITY, b.pose ?? IDENTITY, b.inset ?? 0.01)) hits.push(b.id);
    }
  }
  return {
    state: { id: rig.id, needed: layout.length, available, stretch: layout.length - available, minRadius: layout.minRadius, bendRadius: rig.spec.bendRadius, hits },
    layout,
  };
}

const colliderOf = (m: CableMesh) => new MeshCollider(m.positions, m.indices);
const treeOf = (b: CollisionBody) => (typeof b.collider === "function" ? b.collider() : b.collider);

type Box = { min: V3; max: V3 };
function boundsOf(pts: readonly V3[], pad: number): Box {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]! - pad);
      max[k] = Math.max(max[k]!, p[k]! + pad);
    }
  return { min, max };
}
function placedBounds(r: Box, pose: Mat4 | undefined): Box {
  const corners: V3[] = [];
  for (let k = 0; k < 8; k++) corners.push(transformPoint(pose ?? IDENTITY, [k & 1 ? r.max[0] : r.min[0], k & 2 ? r.max[1] : r.min[1], k & 4 ? r.max[2] : r.min[2]]));
  return boundsOf(corners, 0);
}
const boxesMeet = (a: Box, b: Box) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! && b.min[k]! <= a.max[k]!);

/** One line on a cable's state, for messages. */
export function describeCable(s: CableState): string {
  if (s.error) return s.error;
  const out: string[] = [];
  if (isStretched(s)) out.push(`stretched by ${s.stretch.toFixed(1)} mm (needs ${s.needed.toFixed(1)} mm, is ${s.available.toFixed(1)} mm)`);
  if (isTooTight(s)) out.push(`bent to a ${s.minRadius.toFixed(1)} mm radius (at least ${s.bendRadius.toFixed(1)} mm)`);
  if (s.hits.length) out.push(`runs into ${s.hits.join(", ")}`);
  return out.length ? out.join("; ") : `fine (${(s.available - s.needed).toFixed(1)} mm to spare)`;
}
