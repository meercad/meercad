/**
 * Kinematics of jointed parts: where every part sits for given joint values. Joints form a tree
 * (each part moves in at most one joint, hanging on another part or the ground); couplings tie a
 * joint's value to another's. Poses are 4×4 matrices (column-major, as three.js stores them)
 * relative to the modelled position, which is the rest position.
 */

export type V3 = [number, number, number];
/** Column-major 4×4 matrix. */
export type Mat4 = number[];

export interface MotionJoint {
  id: string;
  type: "revolute" | "slider" | "fixed";
  a: string;
  b: string;
  /** Axis in rest coordinates (unit length). */
  origin: V3;
  axis: V3;
  limits?: [number, number];
}

/**
 * A cylindrical joint (turn and slide on one axis) as two plain joints through a part of its own:
 * `<id>.turn` turns `a` on that part, `<id>.slide` moves the part along the axis on `b`. The two
 * values are set apart, in the panel and by assistants.
 */
export function cylindricalJoints(
  j: Omit<MotionJoint, "type" | "limits"> & { limits?: [number, number]; travel?: [number, number] },
): [MotionJoint, MotionJoint] {
  const carrier = cylindricalCarrier(j.id);

  return [
    {
      id: `${j.id}${TURN}`,
      type: "revolute",
      a: j.a,
      b: carrier,
      origin: j.origin,
      axis: j.axis,
      ...(j.limits ? { limits: j.limits } : {}),
    },
    {
      id: `${j.id}${SLIDE}`,
      type: "slider",
      a: carrier,
      b: j.b,
      origin: j.origin,
      axis: j.axis,
      ...(j.travel ? { limits: j.travel } : {}),
    },
  ];
}

export const TURN = ".turn";
export const SLIDE = ".slide";
/** The part between a cylindrical joint's turn and slide (not a body of the model). */
export const cylindricalCarrier = (id: string) => `${id}~carrier`;

/**
 * Parts held together by fixed joints, as a group number per part (parts fixed to the ground share
 * one): parts of one group never move against each other, so gap checks can leave their pairs out.
 * Parts in no fixed joint are not listed.
 */
export function rigidGroups(
  joints: readonly { type: string; a: string; b: string; suppressed?: boolean }[],
): Record<string, number> {
  const up = new Map<string, string>();

  const root = (x: string): string => {
    let r = x;
    while (up.has(r) && up.get(r) !== r) r = up.get(r)!;
    up.set(x, r);

    return r;
  };

  for (const j of joints) {
    if (j.type !== "fixed" || j.suppressed) continue;

    for (const p of [j.a, j.b]) if (!up.has(p)) up.set(p, p);

    const [ra, rb] = [root(j.a), root(j.b)];
    if (ra !== rb) up.set(ra, rb);
  }

  const numbers = new Map<string, number>();
  const out: Record<string, number> = {};

  for (const p of up.keys()) {
    if (p === "ground") continue;

    const r = root(p);
    if (!numbers.has(r)) numbers.set(r, numbers.size);

    out[p] = numbers.get(r)!;
  }

  return out;
}

export interface MotionCoupling {
  driver: string;
  driven: string;
  ratio: number;
}

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);

  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }

  return out;
}

/** Rotation by `deg` about the line through `o` along unit `n` (right hand). */
export function rotationAbout(o: V3, n: V3, deg: number): Mat4 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  const [x, y, z] = n;
  const r = [
    c + x * x * C,
    x * y * C - z * s,
    x * z * C + y * s,
    y * x * C + z * s,
    c + y * y * C,
    y * z * C - x * s,
    z * x * C - y * s,
    z * y * C + x * s,
    c + z * z * C,
  ];
  // p' = R (p − o) + o
  const tx = o[0] - (r[0]! * o[0] + r[1]! * o[1] + r[2]! * o[2]);
  const ty = o[1] - (r[3]! * o[0] + r[4]! * o[1] + r[5]! * o[2]);
  const tz = o[2] - (r[6]! * o[0] + r[7]! * o[1] + r[8]! * o[2]);

  return [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, tx, ty, tz, 1];
}

export function translation(v: V3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
}

export function transformPoint(m: Mat4, p: V3): V3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

export function transformDir(m: Mat4, d: V3): V3 {
  return [
    m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2],
    m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2],
    m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2],
  ];
}

/** Whether a pose leaves the part where it was drawn. */
export const isMoved = (m: Mat4) => m.some((v, i) => Math.abs(v - IDENTITY[i]!) > 1e-9);

/** A triangle mesh moved by a pose (positions and normals; nothing else changes). */
export function placeMesh<T extends { positions: Float32Array; normals: Float32Array }>(mesh: T, m: Mat4): T {
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);

  for (let i = 0; i + 2 < positions.length; i += 3) {
    positions.set(transformPoint(m, [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]), i);
  }

  for (let i = 0; i + 2 < normals.length; i += 3) {
    normals.set(transformDir(m, [mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!]), i);
  }

  return { ...mesh, positions, normals };
}

export class Mechanism {
  private readonly byPart = new Map<string, MotionJoint>();
  private readonly byId = new Map<string, MotionJoint>();
  /** driven joint → its coupling */
  private readonly drivenBy = new Map<string, MotionCoupling>();
  readonly errors: string[] = [];

  constructor(
    readonly joints: readonly MotionJoint[],
    readonly couplings: readonly MotionCoupling[] = [],
  ) {
    for (const j of joints) {
      this.byId.set(j.id, j);
      if (this.byPart.has(j.a)) this.errors.push(`part "${j.a}" moves in two joints`);
      else this.byPart.set(j.a, j);
    }

    for (const c of couplings) {
      if (!this.byId.has(c.driver) || !this.byId.has(c.driven)) continue;
      if (this.drivenBy.has(c.driven)) this.errors.push(`joint "${c.driven}" is driven twice`);
      else this.drivenBy.set(c.driven, c);
    }

    for (const j of joints) {
      if (this.rootOf(j.id) === null) this.errors.push(`couplings of joint "${j.id}" go round in a circle`);
    }
  }

  jointOf(part: string): MotionJoint | undefined {
    return this.byPart.get(part);
  }

  joint(id: string): MotionJoint | undefined {
    return this.byId.get(id);
  }

  /** The joint whose value drives `id` (itself when nothing drives it), or null for a coupling loop. */
  rootOf(id: string): string | null {
    let cur = id;

    for (let i = 0; i <= this.joints.length; i++) {
      const c = this.drivenBy.get(cur);
      if (!c) return cur;

      cur = c.driver;
    }

    return null;
  }

  /** Factor from the root driver's value to this joint's value. */
  private gain(id: string): number {
    let g = 1;
    let cur = id;

    for (let i = 0; i <= this.joints.length; i++) {
      const c = this.drivenBy.get(cur);
      if (!c) return g;

      g *= c.ratio;
      cur = c.driver;
    }

    return g;
  }

  /** Range of a root driver's value that keeps it and every joint it drives within their limits. */
  range(root: string): [number, number] {
    let lo = -Infinity;
    let hi = Infinity;

    for (const j of this.joints) {
      if (!j.limits || this.rootOf(j.id) !== root) continue;

      const g = this.gain(j.id);
      if (Math.abs(g) < 1e-12) continue;

      const a = j.limits[0] / g;
      const b = j.limits[1] / g;
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    }

    return [lo, hi];
  }

  /**
   * All joint values from the values of free joints (driven joints follow their drivers), each
   * free value held within its range.
   */
  values(free: Readonly<Record<string, number>>): Record<string, number> {
    const out: Record<string, number> = {};
    const rootValue = new Map<string, number>();

    for (const j of this.joints) {
      const root = this.rootOf(j.id);
      if (root === null) continue;

      if (!rootValue.has(root)) {
        const [lo, hi] = this.range(root);
        rootValue.set(root, Math.min(hi, Math.max(lo, free[root] ?? 0)));
      }

      out[j.id] = j.type === "fixed" ? 0 : rootValue.get(root)! * this.gain(j.id);
    }

    return out;
  }

  /** The free (root) value that gives joint `id` the value `v`. */
  rootValueFor(id: string, v: number): { root: string; value: number } | null {
    const root = this.rootOf(id);
    if (root === null) return null;

    const g = this.gain(id);

    return Math.abs(g) < 1e-12 ? null : { root, value: v / g };
  }

  /** Pose of every moving part for the given joint values. Parts in no joint stay at rest. */
  poses(values: Readonly<Record<string, number>>): Map<string, Mat4> {
    const out = new Map<string, Mat4>();
    const visiting = new Set<string>();

    const pose = (part: string): Mat4 => {
      const done = out.get(part);
      if (done) return done;

      const j = this.byPart.get(part);
      if (!j || part === "ground") return IDENTITY;

      if (visiting.has(part)) {
        this.errors.push(`joints around part "${part}" form a loop`);

        return IDENTITY;
      }

      visiting.add(part);

      const v = values[j.id] ?? 0;
      const local =
        j.type === "revolute"
          ? rotationAbout(j.origin, j.axis, v)
          : j.type === "slider"
            ? translation([j.axis[0] * v, j.axis[1] * v, j.axis[2] * v])
            : IDENTITY;
      const m = multiply(pose(j.b), local);
      visiting.delete(part);
      out.set(part, m);

      return m;
    };

    for (const j of this.joints) pose(j.a);

    return out;
  }
}

// ---------------------------------------------------------------- dragging

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Where a ray meets the plane through `p` with normal `n`, or null when it runs along the plane. */
export function rayPlane(origin: V3, dir: V3, p: V3, n: V3): V3 | null {
  const d = dot(dir, n);
  if (Math.abs(d) < 1e-9) return null;

  const t = dot(sub(p, origin), n) / d;

  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

/** Signed angle in degrees from `from` to `to` about the axis (o, n), both seen in the plane normal to it. */
export function angleAbout(o: V3, n: V3, from: V3, to: V3): number {
  const a = sub(from, o);
  const b = sub(to, o);
  const pa = sub(a, [n[0] * dot(a, n), n[1] * dot(a, n), n[2] * dot(a, n)]);
  const pb = sub(b, [n[0] * dot(b, n), n[1] * dot(b, n), n[2] * dot(b, n)]);

  return (Math.atan2(dot(cross(pa, pb), n), dot(pa, pb)) * 180) / Math.PI;
}

/** Parameter along the line (o, n) of the point closest to a ray. */
export function rayLineParam(origin: V3, dir: V3, o: V3, n: V3): number | null {
  const w = sub(origin, o);
  const a = dot(n, n);
  const b = dot(n, dir);
  const c = dot(dir, dir);
  const d = dot(n, w);
  const e = dot(dir, w);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-9) return null;

  return (c * d - b * e) / den;
}

// ---------------------------------------------------------------- motions (linked moves over time)

/** What `sampleMotion` needs of a motion (the document's `Motion`). */
export interface MotionTrack {
  duration: number;
  loop?: boolean;
  smooth?: boolean;
  keys: readonly { at: number; values: Readonly<Record<string, number>> }[];
}

/**
 * Joint values of a motion at `t` seconds. Each joint runs through the moments that name it: a
 * smooth curve (Catmull-Rom, so it passes through every moment without stopping there) or straight
 * lines. A loop is periodic: after its last moment it heads back to the first within `duration`.
 * Before a joint's first and after its last moment (no loop) it holds that value.
 */
export function sampleMotion(m: MotionTrack, t: number): Record<string, number> {
  const T = m.duration;
  const time = m.loop ? ((t % T) + T) % T : Math.min(Math.max(t, 0), T);
  const tracks = new Map<string, { at: number; v: number }[]>();

  for (const k of [...m.keys].sort((a, b) => a.at - b.at)) {
    for (const [j, v] of Object.entries(k.values)) {
      const list = tracks.get(j) ?? [];

      // Two moments at the same time: the later one wins.
      if (list.length && Math.abs(list[list.length - 1]!.at - k.at) < 1e-9) {
        list[list.length - 1] = { at: k.at, v };
      } else {
        list.push({ at: k.at, v });
      }

      tracks.set(j, list);
    }
  }

  const out: Record<string, number> = {};
  for (const [j, pts] of tracks) out[j] = sampleTrack(pts, time, T, !!m.loop, m.smooth !== false);

  return out;
}

function sampleTrack(
  pts: { at: number; v: number }[],
  t: number,
  T: number,
  loop: boolean,
  smooth: boolean,
): number {
  const n = pts.length;
  if (n === 1) return pts[0]!.v;

  // Point k of the (periodic) sequence, with its time shifted by whole cycles.
  const at = (k: number) => {
    if (!loop) return pts[Math.min(n - 1, Math.max(0, k))]!;

    const c = Math.floor(k / n);
    const p = pts[((k % n) + n) % n]!;

    return { at: p.at + c * T, v: p.v };
  };

  let i: number;

  if (loop) {
    // Segment from point i to i+1 holding t (t may lie before the first point: then it is the wrap-around
    // segment).
    i = pts.findIndex((p, k) => k === n - 1 || pts[k + 1]!.at > t);
    if (t < pts[0]!.at) i = -1;
  } else {
    if (t <= pts[0]!.at) return pts[0]!.v;
    if (t >= pts[n - 1]!.at) return pts[n - 1]!.v;

    i = pts.findIndex((_, k) => pts[k + 1]!.at > t);
  }

  const p0 = at(i - 1);
  const p1 = at(i);
  const p2 = at(i + 1);
  const p3 = at(i + 2);
  const span = p2.at - p1.at;
  if (span <= 1e-12) return p2.v;

  const u = (t - p1.at) / span;
  if (!smooth) return p1.v + (p2.v - p1.v) * u;

  // Catmull-Rom for uneven spacing: tangents from the neighbours, scaled to this segment; at the
  // open ends the curve starts flat.
  const m1 = loop || i > 0 ? ((p2.v - p0.v) / Math.max(1e-12, p2.at - p0.at)) * span : 0;
  const m2 = loop || i + 1 < n - 1 ? ((p3.v - p1.v) / Math.max(1e-12, p3.at - p1.at)) * span : 0;
  const u2 = u * u;
  const u3 = u2 * u;

  return (2 * u3 - 3 * u2 + 1) * p1.v + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2.v + (u3 - u2) * m2;
}

/** The moments to look at when checking or picturing a motion: `frames` evenly over one run. */
export function motionTimes(m: Pick<MotionTrack, "duration" | "loop">, frames: number): number[] {
  const n = Math.max(2, Math.round(frames));

  // A loop's end is its start again: leave it out.
  return Array.from({ length: n }, (_, k) => (m.loop ? (m.duration * k) / n : (m.duration * k) / (n - 1)));
}
