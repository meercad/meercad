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
import { refine } from "./meshSamples";

export interface DeviationStats {
  /** Colour scale ends at ±range (mm). */
  range: number;
  min: number;
  max: number;
  /** Share of vertices within ±tolerance. */
  within: number;
  tolerance: number;
}

export const useDeviation = create<{
  body: string | null;
  mesh: string | null;
  maps: Map<string, { positions: Float32Array; colors: Float32Array }>;
  stats: DeviationStats | null;
  error?: string;
}>(() => ({
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

  const collider =
    colliders.get(ref) ?? colliders.set(ref, new MeshCollider(ref.positions, ref.indices)).get(ref)!;
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
      // About 25 ms at a time, then the page gets a turn (a message, not a timer: timers are slowed down in
      // the background).
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

      if (v === undefined) {
        seen.set(
          key,
          (v = signedDistance(collider, [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!])),
        );
      }

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
  const sorted = Array.from({ length: Math.min(n, 20_000) }, (_, k) =>
    Math.abs(d[Math.floor((k * n) / Math.min(n, 20_000))]!),
  ).sort((a, b) => a - b);
  const range = niceStep(Math.max(0.1, sorted[Math.floor(0.98 * (sorted.length - 1))] ?? 0));
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colorFor(d[i]! / range, colors, i * 3);
  useDeviation.setState({
    maps: new Map([[body, { positions, colors }]]),
    stats: { range, min, max, within: n ? within / n : 1, tolerance: TOLERANCE },
    error: undefined,
  });
}

/** Rounds up to 1, 2 or 5 times a power of ten. */
export function niceStep(v: number): number {
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
