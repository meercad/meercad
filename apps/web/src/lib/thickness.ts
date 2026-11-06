/**
 * Wall thickness of a part as a colour map, with no reference needed: from every spot of the
 * surface a ray goes straight into the material, and how far it runs before it comes out again is
 * the wall there. Red where it is thinner than the wall a printer needs, through yellow to green
 * at three times that. Kept up to date while the part changes, until it is closed.
 */
import { MeshCollider, rayDistance } from "@meercad/model";
import type { BodyMesh } from "@meercad/kernel";
import { create } from "zustand";
import { startTask, useApp } from "../store";
import { refine } from "./deviation";
import { t } from "./i18n";

export interface ThicknessStats {
  /**
   * The thinnest wall, ignoring the thinnest half percent of the surface: rays from slivers at sharp
   * edges hit the neighbouring face at once and would report walls of nothing.
   */
  min: number;
  /** The smallest value measured at all. */
  absoluteMin?: number;
  /** Share of the surface thinner than `minWall`. */
  thin: number;
  minWall: number;
  /** Where the wall is thinnest (a point on the surface). */
  at?: [number, number, number];
}

export const useThickness = create<{ body: string | null; minWall: number; maps: Map<string, { positions: Float32Array; colors: Float32Array }>; stats: ThicknessStats | null; error?: string }>(() => ({
  body: null,
  minWall: 1,
  maps: new Map(),
  stats: null,
}));

export function showThickness(body: string): void {
  useThickness.setState({ body });
  void update();
}

export function hideThickness(): void {
  useThickness.setState({ body: null, maps: new Map(), stats: null, error: undefined });
}

export function setMinWall(minWall: number): void {
  useThickness.setState({ minWall });
  void update();
}

const colliders = new WeakMap<BodyMesh, MeshCollider>();
let run = 0;

async function update(): Promise<void> {
  const me = ++run;
  const { body, minWall } = useThickness.getState();
  if (!body) return;
  const part = useApp.getState().output?.meshes.find((m) => m.bodyId === body);
  if (!part) return useThickness.setState({ maps: new Map(), stats: null, error: "gone" });
  const collider = colliders.get(part) ?? colliders.set(part, new MeshCollider(part.positions, part.indices)).get(part)!;
  // A ray per triangle: fewer samples than the deviation map needs, walls change slowly.
  const positions = refine(part, 40_000);
  const n = positions.length / 9;
  // Inside-out meshes (some STL files) would shoot every ray out of the part.
  let volume = 0;
  for (let k = 0; k < n; k++) {
    const o = k * 9;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from(positions.subarray(o, o + 9));
    volume += ax! * (by! * cz! - bz! * cy!) - ay! * (bx! * cz! - bz! * cx!) + az! * (bx! * cy! - by! * cx!);
  }
  const into = volume < 0 ? 1 : -1;
  const wall = new Float64Array(n);
  let area = 0;
  let thinArea = 0;
  let min = Infinity;
  const samples: { d: number; a: number; c: [number, number, number] }[] = [];
  const task = startTask(t("Measuring the wall thickness"));
  try {
    let slice = performance.now();
    for (let k = 0; k < n; k++) {
      if ((k & 511) === 0 && performance.now() - slice > 25) {
        task.update(k / n);
        await new Promise<void>((r) => {
          const c = new MessageChannel();
          c.port1.onmessage = () => r();
          c.port2.postMessage(0);
        });
        if (me !== run) return;
        slice = performance.now();
      }
      const o = k * 9;
      const P = positions;
      const ux = P[o + 3]! - P[o]!, uy = P[o + 4]! - P[o + 1]!, uz = P[o + 5]! - P[o + 2]!;
      const vx = P[o + 6]! - P[o]!, vy = P[o + 7]! - P[o + 1]!, vz = P[o + 8]! - P[o + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (!l) {
        wall[k] = NaN;
        continue;
      }
      const c: [number, number, number] = [(P[o]! + P[o + 3]! + P[o + 6]!) / 3, (P[o + 1]! + P[o + 4]! + P[o + 7]!) / 3, (P[o + 2]! + P[o + 5]! + P[o + 8]!) / 3];
      const d = rayDistance(collider, c, [(into * nx) / l, (into * ny) / l, (into * nz) / l], 1e-4);
      // A ray that never comes out again started on an open edge of the mesh: no value.
      wall[k] = Number.isFinite(d) ? d : NaN;
      if (!Number.isFinite(d)) continue;
      area += l / 2;
      if (d < minWall) thinArea += l / 2;
      if (d < min) min = d;
      samples.push({ d, a: l / 2, c });
    }
  } finally {
    task.done();
  }
  // The thinnest wall that covers more than a speck of the surface.
  samples.sort((x, y) => x.d - y.d);
  let acc = 0;
  const robust = samples.find((x) => (acc += x.a) > area * 0.005) ?? samples[0];
  const colors = new Float32Array(n * 9);
  for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) colorFor(wall[k]!, minWall, colors, k * 9 + c * 3);
  useThickness.setState({ maps: new Map([[body, { positions, colors }]]), stats: { min: robust ? robust.d : min, absoluteMin: min, thin: area ? thinArea / area : 0, minWall, ...(robust ? { at: robust.c } : {}) }, error: undefined });
}

// Red below the minimum wall, then yellow, green from three times it; grey where nothing was measured.
const RED = [0.86, 0.22, 0.2];
const YELLOW = [0.95, 0.78, 0.25];
const GREEN = [0.3, 0.72, 0.45];
const GREY = [0.6, 0.6, 0.62];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function colorFor(d: number, minWall: number, out: Float32Array, o: number): void {
  let rgb = GREY;
  if (!Number.isNaN(d)) {
    const u = Math.max(0, Math.min(1, (d - minWall) / (2 * minWall)));
    const [from, to, k] = d < minWall ? [RED, RED, 0] : u < 0.5 ? [RED, YELLOW, u * 2] : [YELLOW, GREEN, (u - 0.5) * 2];
    rgb = [0, 1, 2].map((c) => from[c]! + (to[c]! - from[c]!) * k);
  }
  for (let c = 0; c < 3; c++) out[o + c] = linear(rgb[c]!);
}

/** CSS gradient of the scale, for the legend (minimum wall to three times it). */
export const THICKNESS_GRADIENT = `linear-gradient(90deg, rgb(${RED.map((c) => c * 255).join(",")}), rgb(${YELLOW.map((c) => c * 255).join(",")}), rgb(${GREEN.map((c) => c * 255).join(",")}))`;

useApp.subscribe((s, prev) => {
  if (!useThickness.getState().body) return;
  if (s.project?.id !== prev.project?.id || s.screen !== "editor") hideThickness();
  else if (s.output !== prev.output && !s.previewing) void update();
});
