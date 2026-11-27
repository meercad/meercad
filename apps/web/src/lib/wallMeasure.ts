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

/**
 * A wall this much under the minimum still counts as the minimum (one drawn at exactly 2.4 mm measures
 * 2.399).
 */
export const WALL_TOLERANCE = 0.01;

/**
 * A ray that leaves through a face standing at more than 60° to the one it started on measured a
 * corner, not a wall: right beside a sharp edge of less than a right angle the material is as thin
 * as one likes (0.005 mm from the facets next to the edge), and such a speck then gave a whole thin
 * place its thickness (a servo carrier, 2026-11-11: "0.005 mm, 104 mm²"). A blade (faces at up to
 * 60°) still counts as a wall.
 */
export const CORNER_FACING = 0.5;

/** Rays per part: "fine" for the colour map, "fast" a fifth of them for a quick answer. */
export const WALL_SAMPLES = { fine: 40_000, fast: 8_000 } as const;

/**
 * Measures a part's walls: a ray into the material from each piece of the surface (inside `box`
 * if given; the whole part still counts as material). `aborted` stops it (returns null).
 */
export async function measureWalls(
  part: BodyMesh,
  minWall: number,
  o: {
    samples?: number;
    box?: { min: readonly number[]; max: readonly number[] };
    aborted?: () => boolean;
    progress?: (f: number) => void;
  } = {},
): Promise<WallMeasure | null> {
  const collider =
    colliders.get(part) ?? colliders.set(part, new MeshCollider(part.positions, part.indices)).get(part)!;
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
  const samples: { d: number; a: number; c: [number, number, number]; measured: number }[] = [];
  const hit = { facing: 1 };
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
    const c: [number, number, number] = [
      (P[q]! + P[q + 3]! + P[q + 6]!) / 3,
      (P[q + 1]! + P[q + 4]! + P[q + 7]!) / 3,
      (P[q + 2]! + P[q + 5]! + P[q + 8]!) / 3,
    ];
    if (box && !c.every((v, i) => v >= box.min[i]! && v <= box.max[i]!)) continue;

    const ux = P[q + 3]! - P[q]!,
      uy = P[q + 4]! - P[q + 1]!,
      uz = P[q + 5]! - P[q + 2]!;
    const vx = P[q + 6]! - P[q]!,
      vy = P[q + 7]! - P[q + 1]!,
      vz = P[q + 8]! - P[q + 2]!;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!l) continue;

    // Only the face it leaves through ends the wall (a grazing neighbour at a seam would give 0.005 mm).
    const d = rayDistance(
      collider,
      c,
      [(into * nx) / l, (into * ny) / l, (into * nz) / l],
      1e-4,
      into === -1 ? 1 : -1,
      hit,
    );
    // A ray that never comes out again started on an open edge of the mesh: no value. Nor has one
    // that leaves round a corner.
    if (!Number.isFinite(d) || hit.facing < CORNER_FACING) continue;

    wall[k] = d;
    area += (l / 2) * stride;
    if (d < minWall - WALL_TOLERANCE) thinArea += (l / 2) * stride;
    if (d < min) min = d;

    samples.push({ d, a: (l / 2) * stride, c, measured: l / 2 });
  }

  // The thinnest wall that covers more than a speck of the surface.
  samples.sort((x, y) => x.d - y.d);

  let acc = 0;
  const robust = samples.find((x) => (acc += x.a) > area * 0.005) ?? samples[0];

  return {
    positions,
    wall,
    stats: {
      min: robust ? robust.d : min,
      absoluteMin: min,
      thin: area ? thinArea / area : 0,
      minWall,
      ...(robust ? { at: robust.c } : {}),
    },
    spots: thinSpots(samples, minWall),
  };
}

/**
 * The thin places among samples sorted thinnest first: each sample within a few walls (at least
 * 3 mm) of a place found already counts to it, else it starts one. A place's wall is the thinnest
 * that covers more than a speck of it (`speckArea`): a feather edge where a hole or a countersink
 * runs out measures a few thousandths of a millimetre on a strip too narrow to see, and such a strip
 * must not name the place (the walls of 1 to 2 mm around it do). Places smaller than a speck
 * altogether are left out. `measured`: the area the sample itself covers, where `a` also stands for
 * triangles skipped beside it.
 */
export function thinSpots(
  sorted: readonly { d: number; a: number; c: readonly number[]; measured?: number }[],
  minWall: number,
  most = 12,
): ThinSpot[] {
  const reach = Math.max(3, 3 * minWall);
  const speck = speckArea(minWall);
  const spots: (ThinSpot & { seed: readonly number[]; measured: number; count: number; named: boolean })[] =
    [];

  for (const x of sorted) {
    if (x.d >= minWall - WALL_TOLERANCE) break;

    let spot = spots.find(
      (other) =>
        Math.hypot(other.seed[0]! - x.c[0]!, other.seed[1]! - x.c[1]!, other.seed[2]! - x.c[2]!) <= reach,
    );

    if (spot) {
      spot.areaMm2 += x.a;
    } else if (spots.length < 200) {
      spots.push(
        (spot = { seed: x.c, at: [0, 0, 0], mm: x.d, areaMm2: x.a, measured: 0, count: 0, named: false }),
      );
    } else {
      continue;
    }

    // Samples come thinnest first: the one that takes the place past a speck names it. On a quick
    // check a sample stands for the triangles skipped beside it: one such sample alone names nothing.
    if (!spot.named) {
      spot.at = [x.c[0]!, x.c[1]!, x.c[2]!];
      spot.mm = x.d;
      spot.measured += x.measured ?? x.a;
      spot.count++;
      spot.named = spot.measured >= speck || (spot.count > 1 && spot.areaMm2 >= speck);
    }
  }

  return spots
    .filter((spot) => spot.areaMm2 >= speck)
    .sort((a, b) => a.mm - b.mm)
    .slice(0, most)
    .map(({ at, mm, areaMm2 }) => ({ at, mm, areaMm2 }));
}

/**
 * The smallest area (mm²) that counts as a place of thin wall: a patch a quarter of the asked wall
 * squared, at least half a square millimetre (about one line of a 0.4 mm nozzle, a millimetre long).
 */
export const speckArea = (minWall: number) => Math.max(0.5, 0.25 * minWall * minWall);
