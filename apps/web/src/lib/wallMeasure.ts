/** Measuring a part's walls (no app state: usable in tests and from the assistant without the colour map). */
import { MeshCollider, rayDistance } from "@meercad/model";
import type { BodyMesh } from "@meercad/kernel";
import { refine } from "./meshSamples";

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

const colliders = new WeakMap<BodyMesh, MeshCollider>();

/** A place where the wall is thinner than asked: its thinnest point, that wall and the area around it. */
export interface ThinSpot {
  at: [number, number, number];
  mm: number;
  areaMm2: number;
}

export interface WallMeasure {
  positions: Float32Array;
  /** Wall per triangle of `positions` (NaN: not measured). */
  wall: Float64Array;
  stats: ThicknessStats;
  /** The thin places, thinnest first. */
  spots: ThinSpot[];
}

/** A wall this much under the minimum still counts as the minimum (one drawn at exactly 2.4 mm measures 2.399). */
export const WALL_TOLERANCE = 0.01;

/** Rays per part: "fine" for the colour map, "fast" a fifth of them for a quick answer. */
export const WALL_SAMPLES = { fine: 40_000, fast: 8_000 } as const;

/**
 * Measures a part's walls: a ray into the material from each piece of the surface (inside `box`
 * if given; the whole part still counts as material). `aborted` stops it (returns null).
 */
export async function measureWalls(
  part: BodyMesh,
  minWall: number,
  o: { samples?: number; box?: { min: readonly number[]; max: readonly number[] }; aborted?: () => boolean; progress?: (f: number) => void } = {},
): Promise<WallMeasure | null> {
  const collider = colliders.get(part) ?? colliders.set(part, new MeshCollider(part.positions, part.indices)).get(part)!;
  // A ray per triangle: fewer samples than the deviation map needs, walls change slowly.
  const positions = refine(part, o.samples ?? WALL_SAMPLES.fine);
  const n = positions.length / 9;
  // Inside-out meshes (some STL files) would shoot every ray out of the part.
  let volume = 0;
  for (let k = 0; k < n; k++) {
    const q = k * 9;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from(positions.subarray(q, q + 9));
    volume += ax! * (by! * cz! - bz! * cy!) - ay! * (bx! * cz! - bz! * cx!) + az! * (bx! * cy! - by! * cx!);
  }
  const into = volume < 0 ? 1 : -1;
  const box = o.box;
  const wall = new Float64Array(n).fill(NaN);
  let area = 0;
  let thinArea = 0;
  let min = Infinity;
  const samples: { d: number; a: number; c: [number, number, number] }[] = [];
  let slice = performance.now();
  // A mesh finer than the samples asked for (a detailed part): every stride-th triangle, its area
  // standing for the ones skipped, so a quick check stays quick on any part.
  const stride = Math.max(1, Math.floor(n / (o.samples ?? WALL_SAMPLES.fine)));
  for (let k = 0, i = 0; k < n; k += stride, i++) {
    // Hand the app back its time now and then; a message (not a timer) so a window in the background goes on.
    if ((i & 511) === 0 && performance.now() - slice > 25) {
      o.progress?.(k / n);
      await new Promise<void>((r) => {
        const c = new MessageChannel();
        c.port1.onmessage = () => r();
        c.port2.postMessage(0);
      });
      if (o.aborted?.()) return null;
      slice = performance.now();
    }
    const q = k * 9;
    const P = positions;
    const c: [number, number, number] = [(P[q]! + P[q + 3]! + P[q + 6]!) / 3, (P[q + 1]! + P[q + 4]! + P[q + 7]!) / 3, (P[q + 2]! + P[q + 5]! + P[q + 8]!) / 3];
    if (box && !c.every((v, i) => v >= box.min[i]! && v <= box.max[i]!)) continue;
    const ux = P[q + 3]! - P[q]!, uy = P[q + 4]! - P[q + 1]!, uz = P[q + 5]! - P[q + 2]!;
    const vx = P[q + 6]! - P[q]!, vy = P[q + 7]! - P[q + 1]!, vz = P[q + 8]! - P[q + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!l) continue;
    // Only the face it leaves through ends the wall (a grazing neighbour at a seam would give 0.005 mm).
    const d = rayDistance(collider, c, [(into * nx) / l, (into * ny) / l, (into * nz) / l], 1e-4, into === -1 ? 1 : -1);
    // A ray that never comes out again started on an open edge of the mesh: no value.
    if (!Number.isFinite(d)) continue;
    wall[k] = d;
    area += (l / 2) * stride;
    if (d < minWall - WALL_TOLERANCE) thinArea += (l / 2) * stride;
    if (d < min) min = d;
    samples.push({ d, a: (l / 2) * stride, c });
  }
  // The thinnest wall that covers more than a speck of the surface.
  samples.sort((x, y) => x.d - y.d);
  let acc = 0;
  const robust = samples.find((x) => (acc += x.a) > area * 0.005) ?? samples[0];
  return {
    positions,
    wall,
    stats: { min: robust ? robust.d : min, absoluteMin: min, thin: area ? thinArea / area : 0, minWall, ...(robust ? { at: robust.c } : {}) },
    spots: thinSpots(samples, minWall),
  };
}

/**
 * The thin places among samples sorted thinnest first: each sample within a few walls (at least
 * 3 mm) of a place found already counts to it, else it starts one. Specks (under a hundredth of a
 * square millimetre, slivers at sharp edges) are no place.
 */
export function thinSpots(sorted: readonly { d: number; a: number; c: readonly number[] }[], minWall: number, most = 12): ThinSpot[] {
  const reach = Math.max(3, 3 * minWall);
  const spots: ThinSpot[] = [];
  for (const x of sorted) {
    if (x.d >= minWall - WALL_TOLERANCE) break;
    const near = spots.find((p) => Math.hypot(p.at[0] - x.c[0]!, p.at[1] - x.c[1]!, p.at[2] - x.c[2]!) <= reach);
    if (near) near.areaMm2 += x.a;
    else if (spots.length < 200) spots.push({ at: [x.c[0]!, x.c[1]!, x.c[2]!], mm: x.d, areaMm2: x.a });
  }
  return spots.filter((p) => p.areaMm2 >= 0.01).slice(0, most);
}

