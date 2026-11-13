/**
 * Closed-loop linkages (four-bars, slider-cranks, scissors): when parts hang in more than one joint,
 * every moving part gets a pose and a damped least-squares solver (Levenberg-Marquardt) keeps all
 * joints together. Joint values the user sets are hard targets, a dragged point pulls weakly, and a
 * weaker pull keeps everything else where it was. Big steps are split, and a step that cannot close
 * the loops (a dead point) is refused instead of flipping the linkage over.
 */

import { IDENTITY, multiply, transformDir, transformPoint, type Mat4, type MotionCoupling, type MotionJoint, type V3 } from "./motion.js";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Two unit vectors perpendicular to n and to each other. */
function perp(n: V3): [V3, V3] {
  const u = norm(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  return [u, cross(n, u)];
}

/** Rotation matrix (column-major 4×4, no translation) for rotation vector r (axis × angle, radians). */
function rotvec(r: V3): Mat4 {
  const t = Math.hypot(...r);
  if (t < 1e-12) return IDENTITY;
  const [x, y, z] = [r[0] / t, r[1] / t, r[2] / t];
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  return [c + x * x * C, y * x * C + z * s, z * x * C - y * s, 0, x * y * C - z * s, c + y * y * C, z * y * C + x * s, 0, x * z * C + y * s, y * z * C - x * s, c + z * z * C, 0, 0, 0, 0, 1];
}

/** Rigid inverse of a pose. */
export function inverse(m: Mat4): Mat4 {
  const r = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!];
  const t: V3 = [m[12]!, m[13]!, m[14]!];
  // Rᵀ in column-major: columns become rows.
  const out: Mat4 = [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, 0, 0, 0, 1];
  const ti = transformDir(out, t);
  out[12] = -ti[0];
  out[13] = -ti[1];
  out[14] = -ti[2];
  return out;
}

export interface Drag {
  part: string;
  /** Grabbed point in the part's rest coordinates. */
  local: V3;
  ray: { origin: V3; dir: V3 };
}

export interface LinkageResult {
  ok: boolean;
  poses: Map<string, Mat4>;
  values: Record<string, number>;
  /** Largest joint gap left, mm (or radians for axes). */
  residual: number;
}

export class Linkage {
  /** Parts that move (appear as `a` in some joint). */
  readonly parts: string[];
  private readonly index = new Map<string, number>();
  private readonly frames: { j: MotionJoint; u: V3; v: V3 }[];

  constructor(
    readonly joints: readonly MotionJoint[],
    readonly couplings: readonly MotionCoupling[] = [],
  ) {
    this.parts = [...new Set(joints.map((j) => j.a))];
    this.parts.forEach((p, i) => this.index.set(p, i));
    this.frames = joints.map((j) => {
      const [u, v] = perp(j.axis);
      return { j, u, v };
    });
  }

  /** A joint's value in a pose: degrees about its axis or mm along it, unwrapped near `near`. */
  value(poses: ReadonlyMap<string, Mat4>, id: string, near = 0): number {
    const f = this.frames.find((x) => x.j.id === id);
    if (!f) return 0;
    const A = poses.get(f.j.a) ?? IDENTITY;
    const B = poses.get(f.j.b) ?? IDENTITY;
    if (f.j.type === "slider") {
      const d = sub(transformPoint(A, f.j.origin), transformPoint(B, f.j.origin));
      return dot(d, transformDir(B, f.j.axis));
    }
    if (f.j.type === "fixed") return 0;
    const w = transformDir(inverse(B), transformDir(A, f.u));
    let deg = (Math.atan2(dot(cross(f.u, w), f.j.axis), dot(f.u, w)) * 180) / Math.PI;
    deg += 360 * Math.round((near - deg) / 360);
    return deg;
  }

  values(poses: ReadonlyMap<string, Mat4>, near: Readonly<Record<string, number>> = {}): Record<string, number> {
    return Object.fromEntries(this.joints.map((j) => [j.id, this.value(poses, j.id, near[j.id] ?? 0)]));
  }

  /** Gaps of every joint in a pose (the equations the solver drives to zero). */
  private gaps(poses: ReadonlyMap<string, Mat4>, out: number[]): void {
    for (const { j, u, v } of this.frames) {
      const A = poses.get(j.a) ?? IDENTITY;
      const B = poses.get(j.b) ?? IDENTITY;
      const pa = transformPoint(A, j.origin);
      const pb = transformPoint(B, j.origin);
      const na = transformDir(A, j.axis);
      const ub = transformDir(B, u);
      const vb = transformDir(B, v);
      const d = sub(pa, pb);
      if (j.type === "revolute") {
        out.push(d[0], d[1], d[2], dot(na, ub), dot(na, vb));
      } else if (j.type === "slider") {
        out.push(dot(d, ub), dot(d, vb), dot(na, ub), dot(na, vb), dot(transformDir(A, u), vb));
      } else {
        out.push(d[0], d[1], d[2], dot(na, ub), dot(na, vb), dot(transformDir(A, u), vb));
      }
    }
  }

  /** Poses with the solver's unknowns applied on top of `base` (rotation vector + shift per part). */
  private apply(base: ReadonlyMap<string, Mat4>, x: Float64Array): Map<string, Mat4> {
    const out = new Map(base);
    this.parts.forEach((p, i) => {
      const r: V3 = [x[i * 6]!, x[i * 6 + 1]!, x[i * 6 + 2]!];
      const m = base.get(p) ?? IDENTITY;
      // Turn about the part's own origin point (its first joint), then shift.
      const c = transformPoint(m, this.joints.find((j) => j.a === p)!.origin);
      const R = rotvec(r);
      const about = multiply(multiply([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, c[0], c[1], c[2], 1], R), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -c[0], -c[1], -c[2], 1]);
      const moved = multiply(about, m);
      moved[12] = moved[12]! + x[i * 6 + 3]!;
      moved[13] = moved[13]! + x[i * 6 + 4]!;
      moved[14] = moved[14]! + x[i * 6 + 5]!;
      out.set(p, moved);
    });
    return out;
  }

  /**
   * One solve from `start`: joint targets (degrees / mm) are hard, a drag pulls weakly, and every
   * part is held lightly where it was. Returns the new poses and whether all joints closed.
   */
  private solveOnce(start: ReadonlyMap<string, Mat4>, targets: Readonly<Record<string, number>>, drag: Drag | undefined, near: Readonly<Record<string, number>>): LinkageResult {
    const n = this.parts.length * 6;
    const hard = (poses: ReadonlyMap<string, Mat4>): number[] => {
      const r: number[] = [];
      this.gaps(poses, r);
      for (const [id, t] of Object.entries(targets)) {
        const j = this.joints.find((x) => x.id === id);
        if (!j || j.type === "fixed") continue;
        // Degrees scaled to about a millimetre at 50 mm radius.
        const k = j.type === "revolute" ? 0.9 : 1;
        r.push(k * (this.value(poses, id, near[id] ?? t) - t));
      }
      for (const c of this.couplings) {
        const jd = this.joints.find((x) => x.id === c.driven);
        const k = jd?.type === "revolute" ? 0.9 : 1;
        r.push(k * (this.value(poses, c.driven, near[c.driven] ?? 0) - c.ratio * this.value(poses, c.driver, near[c.driver] ?? 0)));
      }
      return r;
    };
    const residual = (x: Float64Array): number[] => {
      const poses = this.apply(start, x);
      const r = hard(poses).map((v) => v * 100);
      if (drag) {
        const p = transformPoint(poses.get(drag.part) ?? IDENTITY, drag.local);
        const off = cross(sub(p, drag.ray.origin), norm(drag.ray.dir));
        r.push(off[0], off[1], off[2]);
      }
      // Hold everything lightly where it was, so free parts do not wander.
      for (let i = 0; i < n; i++) r.push(x[i]! * (i % 6 < 3 ? 0.05 : 0.005));
      return r;
    };
    let x = new Float64Array(n);
    let f = residual(x);
    let cost = f.reduce((s, v) => s + v * v, 0);
    let lambda = 1e-3;
    for (let iter = 0; iter < 60; iter++) {
      const m = f.length;
      const J = new Float64Array(m * n);
      const h = 1e-7;
      for (let k = 0; k < n; k++) {
        const xk = Float64Array.from(x);
        xk[k] = xk[k]! + h;
        const fk = residual(xk);
        for (let i = 0; i < m; i++) J[i * n + k] = (fk[i]! - f[i]!) / h;
      }
      // Normal equations (JᵀJ + λ·diag) δ = −Jᵀf
      const A = new Float64Array(n * n);
      const g = new Float64Array(n);
      for (let i = 0; i < m; i++)
        for (let a = 0; a < n; a++) {
          const ja = J[i * n + a]!;
          if (ja === 0) continue;
          g[a] = g[a]! - ja * f[i]!;
          for (let b = 0; b < n; b++) A[a * n + b] = A[a * n + b]! + ja * J[i * n + b]!;
        }
      let improved = false;
      const before = cost;
      for (let tries = 0; tries < 10 && !improved; tries++) {
        const M = Float64Array.from(A);
        for (let a = 0; a < n; a++) M[a * n + a] = M[a * n + a]! * (1 + lambda) + 1e-12;
        const delta = solveLinear(M, Float64Array.from(g), n);
        // The damping (and 1e-12) on the diagonal keeps M regular: a guard only.
        /* v8 ignore next 4 */
        if (!delta) {
          lambda *= 10;
          continue;
        }
        const xn = x.map((v, i) => v + delta[i]!);
        const fn = residual(xn);
        const cn = fn.reduce((s, v) => s + v * v, 0);
        if (cn < cost) {
          x = xn;
          f = fn;
          cost = cn;
          lambda = Math.max(lambda / 3, 1e-9);
          improved = true;
        } else lambda *= 10;
      }
      // The light hold keeps the cost above zero, so also stop once a step barely helps.
      if (!improved || cost < 1e-18 || before - cost < before * 1e-12) break;
    }
    const poses = this.apply(start, x);
    const left = hard(poses).reduce((mx, v) => Math.max(mx, Math.abs(v)), 0);
    // Joint values: targets and drag pulls fight the light hold only, so the joints themselves must close.
    const gaps: number[] = [];
    this.gaps(poses, gaps);
    const gap = gaps.reduce((mx, v) => Math.max(mx, Math.abs(v)), 0);
    return { ok: gap < 1e-4 && left < 1e-3, poses, values: this.values(poses, near), residual: Math.max(gap, left) };
  }

  /**
   * Moves the linkage from `start` towards the targets (or the drag), in steps of a few degrees or
   * millimetres; stops at the last pose that closes when it reaches a dead point or a limit.
   */
  solve(start: ReadonlyMap<string, Mat4>, targets: Readonly<Record<string, number>> = {}, drag?: Drag, prev: Readonly<Record<string, number>> = {}): LinkageResult {
    // Angles read on the turn nearest the last values (`prev`, from the result before), so 181° after
    // 180° is one degree on, not most of a turn back.
    const near = this.values(start, prev);
    let goal = { ...targets };
    // Limits: targets are held within them.
    for (const j of this.joints) if (j.limits && goal[j.id] !== undefined) goal[j.id] = Math.min(j.limits[1], Math.max(j.limits[0], goal[j.id]!));
    const span = Math.max(0, ...Object.entries(goal).map(([id, t]) => Math.abs(t - (near[id] ?? 0)) / (this.joints.find((j) => j.id === id)?.type === "revolute" ? 3 : 2)));
    const steps = Math.min(400, Math.max(1, Math.ceil(span)));
    let cur: LinkageResult = { ok: true, poses: new Map(start), values: near, residual: 0 };
    /** One solve from `from` to `step`, or null when it does not close or jumps. */
    const attempt = (from: LinkageResult, step: Record<string, number>): LinkageResult | null => {
      let next = this.solveOnce(from.poses, step, drag, from.values);
      // The drag pulls against the joints; a second pass without it closes them exactly.
      if (drag) next = this.solveOnce(next.poses, step, undefined, next.values);
      // A dragged joint past its limit: hold it at the limit and solve again.
      const over = this.joints.filter((j) => j.limits && (next.values[j.id]! < j.limits[0] - 1e-6 || next.values[j.id]! > j.limits[1] + 1e-6));
      if (over.length) {
        goal = { ...goal, ...Object.fromEntries(over.map((j) => [j.id, Math.min(j.limits![1], Math.max(j.limits![0], next.values[j.id]!))])) };
        const held = { ...step, ...Object.fromEntries(over.map((j) => [j.id, goal[j.id]!])) };
        next = this.solveOnce(from.poses, held, drag, from.values);
        // As above: without the drag's pull the joints close exactly, the held one at its limit.
        if (drag) next = this.solveOnce(next.poses, held, undefined, next.values);
      }
      // Refuse a step that does not close, or that jumps (the linkage flipping over a dead point).
      const jump = this.joints.some((j) => Math.abs((next.values[j.id] ?? 0) - (from.values[j.id] ?? 0)) > (j.type === "revolute" ? 25 : 15));
      return next.ok && !jump ? next : null;
    };
    for (let s = 1; s <= steps; s++) {
      const step = Object.fromEntries(Object.entries(goal).map(([id, t]) => [id, (near[id] ?? 0) + ((t - (near[id] ?? 0)) * s) / steps]));
      const next = attempt(cur, step);
      if (next) {
        cur = next;
        continue;
      }
      // Near an end position (a crank-rocker's rocker at the end of its swing) the other links turn
      // fast for a small step: creep up to where it really stops in ever smaller steps.
      const from = Object.fromEntries(Object.keys(step).map((id) => [id, cur.values[id] ?? 0]));
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        const r = attempt(cur, Object.fromEntries(Object.entries(step).map(([id, t]) => [id, from[id]! + (t - from[id]!) * mid])));
        if (r) {
          cur = r;
          // Measured from the new pose on: what is left of the way to `step`.
          for (const id of Object.keys(from)) from[id] = cur.values[id] ?? 0;
          hi = (hi - mid) / (1 - mid);
          lo = 0;
        } else hi = mid;
      }
      return { ...cur, ok: false };
    }
    return cur;
  }
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]!) > Math.abs(A[p * n + c]!)) p = r;
    if (Math.abs(A[p * n + c]!) < 1e-14) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [A[c * n + k], A[p * n + k]] = [A[p * n + k]!, A[c * n + k]!];
      [b[c], b[p]] = [b[p]!, b[c]!];
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c]! / A[c * n + c]!;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] = A[r * n + k]! - f * A[c * n + k]!;
      b[r] = b[r]! - f * b[c]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let k = r + 1; k < n; k++) s -= A[r * n + k]! * x[k]!;
    x[r] = s / A[r * n + r]!;
  }
  return x;
}

/** Whether joints need the loop solver: some part hangs in more than one joint. */
export function hasLoops(joints: readonly MotionJoint[]): boolean {
  const seen = new Set<string>();
  for (const j of joints) {
    if (seen.has(j.a)) return true;
    seen.add(j.a);
  }
  return false;
}
