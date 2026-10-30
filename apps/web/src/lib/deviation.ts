/**
 * Deviation of a part from a mesh (a scan, or the mesh a part was rebuilt from): points all over
 * the part get their signed distance to the mesh surface, shown as a colour map on the part. Blue
 * is inside the mesh (the part is too small there), green on it, red outside (too big). Kept up to
 * date while the part changes, until it is closed.
 */
import { MeshCollider, signedDistance } from "@meercad/model";
import type { BodyMesh } from "@meercad/kernel";
import { create } from "zustand";
import { startTask, useApp } from "../store";
import { t } from "./i18n";

export interface DeviationStats {
  /** Colour scale ends at ±range (mm). */
  range: number;
  min: number;
  max: number;
  /** Share of vertices within ±tolerance. */
  within: number;
  tolerance: number;
}

export const useDeviation = create<{ body: string | null; mesh: string | null; maps: Map<string, { positions: Float32Array; colors: Float32Array }>; stats: DeviationStats | null; error?: string }>(() => ({
  body: null,
  mesh: null,
  maps: new Map(),
  stats: null,
}));

/** Within this the part counts as matching the mesh (mm): about what a scan holds. */
export const TOLERANCE = 0.2;

export function showDeviation(body: string, mesh: string): void {
  useDeviation.setState({ body, mesh });
  void update();
}

export function hideDeviation(): void {
  useDeviation.setState({ body: null, mesh: null, maps: new Map(), stats: null, error: undefined });
}

const colliders = new WeakMap<BodyMesh, MeshCollider>();

let run = 0;

/** Measures in slices, with a task showing how far it got; a newer run makes an older one stop. */
async function update(): Promise<void> {
  const me = ++run;
  const { body, mesh } = useDeviation.getState();
  if (!body || !mesh) return;
  const meshes = useApp.getState().output?.meshes ?? [];
  const part = meshes.find((m) => m.bodyId === body);
  const ref = meshes.find((m) => m.bodyId === mesh);
  if (!part || !ref) return useDeviation.setState({ maps: new Map(), stats: null, error: "gone" });
  const collider = colliders.get(ref) ?? colliders.set(ref, new MeshCollider(ref.positions, ref.indices)).get(ref)!;
  const positions = refine(part);
  const n = positions.length / 3;
  const d = new Float64Array(n);
  let min = Infinity;
  let max = -Infinity;
  let within = 0;
  // Corners repeat (about six triangles share each): measure each place once.
  const seen = new Map<string, number>();
  const task = startTask(t("Measuring the deviation"));
  try {
    let slice = performance.now();
    for (let i = 0; i < n; i++) {
      // About 25 ms at a time, then the page gets a turn (a message, not a timer: timers are slowed down in the background).
      if ((i & 1023) === 0 && performance.now() - slice > 25) {
        task.update(i / n);
        await new Promise<void>((r) => {
          const c = new MessageChannel();
          c.port1.onmessage = () => r();
          c.port2.postMessage(0);
        });
        if (me !== run) return;
        slice = performance.now();
      }
      const key = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
      let v = seen.get(key);
      if (v === undefined) seen.set(key, (v = signedDistance(collider, [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!])));
      d[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
      if (Math.abs(v) <= TOLERANCE) within++;
    }
  } finally {
    task.done();
  }
  // The scale covers nearly all points (a few far ones would wash out the rest), at least ±0.1 mm;
  // a sample of them is enough to find where 98 % end.
  const sorted = Array.from({ length: Math.min(n, 20_000) }, (_, k) => Math.abs(d[Math.floor((k * n) / Math.min(n, 20_000))]!)).sort((a, b) => a - b);
  const range = niceStep(Math.max(0.1, sorted[Math.floor(0.98 * (sorted.length - 1))] ?? 0));
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colorFor(d[i]! / range, colors, i * 3);
  useDeviation.setState({ maps: new Map([[body, { positions, colors }]]), stats: { range, min, max, within: n ? within / n : 1, tolerance: TOLERANCE }, error: undefined });
}

/**
 * The part's triangles as a list of corners (no index), long ones split until every edge is
 * shorter than a step that suits the part's size, so values are sampled across large flat faces
 * too (the part's own mesh has corners only at their outlines). At most 200 000 triangles.
 */
function refine(m: BodyMesh): Float32Array {
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
  for (let step = Math.max(diag / 150, Math.sqrt(area / (0.43 * 150_000)), 1e-3); ; step *= 1.5) {
    const out = split(P, I, step);
    if (out.length <= 9 * 200_000 || step > diag) return Float32Array.from(out);
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

/** Rounds up to 1, 2 or 5 times a power of ten. */
function niceStep(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= v - 1e-12)!;
}

// Diverging scale in sRGB, written as linear values (what the renderer's vertex colours expect).
const BLUE = [0.22, 0.42, 0.88];
const GREEN = [0.3, 0.72, 0.45];
const RED = [0.86, 0.25, 0.25];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function colorFor(value: number, out: Float32Array, o: number): void {
  const u = Math.max(-1, Math.min(1, value));
  const [from, to, k] = u < 0 ? [GREEN, BLUE, -u] : [GREEN, RED, u];
  for (let c = 0; c < 3; c++) out[o + c] = linear(from[c]! + (to[c]! - from[c]!) * k);
}

/** CSS gradient of the scale, for the legend. */
export const DEVIATION_GRADIENT = `linear-gradient(90deg, rgb(${BLUE.map((c) => c * 255).join(",")}), rgb(${GREEN.map((c) => c * 255).join(",")}), rgb(${RED.map((c) => c * 255).join(",")}))`;

// A new result (the part was edited) is measured again; another project closes it.
useApp.subscribe((s, prev) => {
  if (!useDeviation.getState().body) return;
  if (s.project?.id !== prev.project?.id || s.screen !== "editor") hideDeviation();
  else if (s.output !== prev.output && !s.previewing) void update();
});
