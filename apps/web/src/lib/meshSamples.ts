/** Sample points across a part's surface (no app state: usable in tests). */
import type { BodyMesh } from "@meercad/kernel";

/**
 * The part's triangles as a list of corners (no index), long ones split until every edge is
 * shorter than a step that suits the part's size, so values are sampled across large flat faces
 * too (the part's own mesh has corners only at their outlines). At most `budget` triangles, unless
 * the mesh itself has more.
 */
export function refine(m: BodyMesh, budget = 200_000): Float32Array {
  const P = m.positions;
  const I = m.indices;
  let area = 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, P[i + k]!);
      hi[k] = Math.max(hi[k]!, P[i + k]!);
    }
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i]! * 3, b = I[i + 1]! * 3, c = I[i + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  const diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  // Equilateral triangles of side L cover about 0.43·L² each.
  // Long thin triangles split into many pieces whatever their area: coarser until within budget.
  for (let step = Math.max(diag / 150, Math.sqrt(area / (0.43 * budget * 0.75)), 1e-3); ; step *= 1.5) {
    const out = split(P, I, step);
    if (out.length <= 9 * budget || step > diag) return Float32Array.from(out);
  }
}

/** Triangles of the mesh with every edge halved until no longer than `step`. */
function split(P: Float32Array, I: Uint32Array, step: number): number[] {
  const out: number[] = [];
  const split = (a: number[], b: number[], c: number[], depth: number) => {
    const ab = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    const bc = Math.hypot(b[0]! - c[0]!, b[1]! - c[1]!, b[2]! - c[2]!);
    const ca = Math.hypot(c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!);
    if (Math.max(ab, bc, ca) <= step || depth > 8) return void out.push(...a, ...b, ...c);
    // Halve the longest edge.
    const mid = (p: number[], q: number[]) => [(p[0]! + q[0]!) / 2, (p[1]! + q[1]!) / 2, (p[2]! + q[2]!) / 2];
    if (ab >= bc && ab >= ca) {
      const m1 = mid(a, b);
      split(a, m1, c, depth + 1);
      split(m1, b, c, depth + 1);
    } else if (bc >= ca) {
      const m1 = mid(b, c);
      split(a, b, m1, depth + 1);
      split(a, m1, c, depth + 1);
    } else {
      const m1 = mid(c, a);
      split(a, b, m1, depth + 1);
      split(m1, b, c, depth + 1);
    }
  };
  const at = (v: number) => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  for (let i = 0; i < I.length; i += 3) split(at(I[i]!), at(I[i + 1]!), at(I[i + 2]!), 0);
  return out;
}
