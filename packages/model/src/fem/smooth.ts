/**
 * The smooth skin of an optimised part. The densities of the cubes are blurred a little and read
 * on a finer raster, where the skin runs along one density level: struts come out round and flow
 * into each other instead of showing the cubes. Where the skin would leave the part it is cut off
 * by the part's own surface, so the part's outer faces stay exactly what they were.
 */
import { MeshCollider, signedDistance } from "../collide.js";
import { cellCount, type Vec3, type VoxelGrid } from "./grid.js";

export interface SmoothJob {
  /** The part as cubes, and the density of each cube (the kept cubes are taken as full). */
  grid: VoxelGrid;
  density: ArrayLike<number>;
  keep: ArrayLike<number>;
  /** The part's own triangles: the skin never leaves them. */
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** The share of the part's volume the result should have. */
  share: number;
  /** Raster points per cube edge. */
  fine?: number;
  /** Over how far (in cubes) corners and edges of the skin are rounded off; 0: not at all. */
  rounding?: number;
}

/** Cubes added around the grid, so blurring and reading between cubes never run out of data. */
const PAD = 2;

/** A box of numbers, x fastest. */
interface Field {
  nx: number;
  ny: number;
  nz: number;
  values: Float32Array;
}

const field = (nx: number, ny: number, nz: number): Field => ({
  nx,
  ny,
  nz,
  values: new Float32Array(nx * ny * nz),
});

const STEPS: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Calls `visit` with every neighbour of a place that lies in the box, face to face. */
function around(box: Field, index: number, visit: (other: number) => void): void {
  const at: Vec3 = [
    index % box.nx,
    Math.floor(index / box.nx) % box.ny,
    Math.floor(index / (box.nx * box.ny)),
  ];
  const size = [box.nx, box.ny, box.nz];

  for (const step of STEPS) {
    const to = at.map((value, axis) => value + step[axis]!);

    if (to.every((value, axis) => value >= 0 && value < size[axis]!)) {
      visit(to[0]! + box.nx * (to[1]! + box.ny * to[2]!));
    }
  }
}

/**
 * The densities with a margin of cubes around, the kept cubes full. Cubes outside the part take the
 * mean of the part's cubes next to them, layer by layer: the density runs on past the part's
 * surface, so only that surface (not a fading density) ends the material there.
 */
function padded(job: SmoothJob): Field {
  const { grid } = job;
  const out = field(grid.nx + 2 * PAD, grid.ny + 2 * PAD, grid.nz + 2 * PAD);
  const known = new Uint8Array(out.values.length);
  const place = (cell: number) =>
    (cell % grid.nx) +
    PAD +
    out.nx *
      ((Math.floor(cell / grid.nx) % grid.ny) +
        PAD +
        out.ny * (Math.floor(cell / (grid.nx * grid.ny)) + PAD));

  for (let cell = 0; cell < cellCount(grid); cell++) {
    if (!grid.solid[cell]) continue;

    out.values[place(cell)] = job.density[cell]!;
    known[place(cell)] = 1;
  }

  for (let i = 0; i < job.keep.length; i++) out.values[place(job.keep[i]!)] = 1;

  for (let layer = 0; layer < PAD + 1; layer++) {
    const found: [number, number][] = [];

    for (let index = 0; index < known.length; index++) {
      if (known[index]) continue;

      let sum = 0;
      let count = 0;

      around(out, index, (other) => {
        sum += known[other]! * out.values[other]!;
        count += known[other]!;
      });

      if (count) found.push([index, sum / count]);
    }

    for (const [index, value] of found) {
      out.values[index] = value;
      known[index] = 1;
    }
  }

  return out;
}

/** The value between the middles of the cubes of a box, at a place given in cubes. */
function between(box: Field, at: Vec3): number {
  const low = at.map((value, axis) =>
    Math.max(0, Math.min([box.nx, box.ny, box.nz][axis]! - 2, Math.floor(value - 0.5))),
  );
  const part = at.map((value, axis) => Math.max(0, Math.min(1, value - 0.5 - low[axis]!)));
  let sum = 0;

  for (let c = 0; c < 8; c++) {
    const weight = [0, 1, 2].reduce((w, axis) => w * ((c >> axis) & 1 ? part[axis]! : 1 - part[axis]!), 1);

    sum +=
      weight *
      box.values[low[0]! + (c & 1) + box.nx * (low[1]! + ((c >> 1) & 1) + box.ny * (low[2]! + (c >> 2)))]!;
  }

  return sum;
}

/**
 * The density level above which the wanted share of the part's volume lies (the densities in the
 * middles of the small cubes between the raster points, sorted), so the skin leaves that much.
 */
function levelFor(data: Field, grid: VoxelGrid, fine: number, share: number): number {
  const values: number[] = [];

  for (let cell = 0; cell < cellCount(grid); cell++) {
    if (!grid.solid[cell]) continue;

    const at = [cell % grid.nx, Math.floor(cell / grid.nx) % grid.ny, Math.floor(cell / (grid.nx * grid.ny))];

    for (let small = 0; small < fine ** 3; small++) {
      const offset = [small % fine, Math.floor(small / fine) % fine, Math.floor(small / fine ** 2)];

      values.push(between(data, at.map((value, axis) => value + PAD + (offset[axis]! + 0.5) / fine) as Vec3));
    }
  }

  values.sort((low, high) => high - low);

  // Never above half: where the densities are all-or-nothing the skin runs midway, not at the full ones.
  return Math.min(0.5, values[Math.min(values.length - 1, Math.round(share * values.length))]!);
}

export function smoothSurface(job: SmoothJob): { positions: Float32Array; indices: Uint32Array } {
  const { grid } = job;
  const fine = job.fine ?? 2;
  const data = padded(job);
  // Raster points from one cube before the grid to one cube after it, `fine` to a cube.
  const raster = field(
    grid.nx * fine + 2 * fine + 1,
    grid.ny * fine + 2 * fine + 1,
    grid.nz * fine + 2 * fine + 1,
  );
  const inCubes = (index: number): Vec3 => [
    (index % raster.nx) / fine - 1,
    (Math.floor(index / raster.nx) % raster.ny) / fine - 1,
    Math.floor(index / (raster.nx * raster.ny)) / fine - 1,
  ];

  const cellAt = (at: Vec3): number => {
    const [x, y, z] = at.map((value, axis) =>
      Math.min([grid.nx, grid.ny, grid.nz][axis]! - 1, Math.floor(value)),
    );

    return x! < 0 || y! < 0 || z! < 0 ? -1 : x! + grid.nx * (y! + grid.ny * z!);
  };

  const inside = new Uint8Array(raster.values.length);

  for (let index = 0; index < raster.values.length; index++) {
    const at = inCubes(index);
    const cell = at.every((value, axis) => value <= [grid.nx, grid.ny, grid.nz][axis]!) ? cellAt(at) : -1;

    raster.values[index] = between(data, at.map((value) => value + PAD) as Vec3);
    inside[index] = cell >= 0 ? grid.solid[cell]! : 0;
  }

  const level = levelFor(data, grid, fine, job.share);
  const collider = new MeshCollider(job.positions, job.indices);
  const deep = deepCells(grid);

  // How far inside the part each raster point lies, in cubes (negative outside); found when asked for.
  const depth = new Float32Array(raster.values.length).fill(NaN);

  const depthAt = (index: number): number => {
    if (Number.isNaN(depth[index]!)) {
      const at = inCubes(index);
      const point = at.map((v, axis) => grid.origin[axis]! + v * grid.h) as Vec3;

      depth[index] = inside[index] && deep[cellAt(at)] ? DEEP : -signedDistance(collider, point) / grid.h;
    }

    return depth[index]!;
  };

  for (let index = 0; index < raster.values.length; index++) {
    const value = raster.values[index]! - level;

    // Material only where the part is: the distance to its surface ends it there.
    raster.values[index] = value > 0 ? roundedMin(value, depthAt(index)) : value;
  }

  const rounding = job.rounding ?? ROUNDING;

  if (rounding > 0) rounded(raster, rounding * fine, depthAt, keptPoints(raster, job, fine));

  dropCrumbs(raster, job, fine);

  const mesh = skin(
    raster,
    (index) => inCubes(index).map((v, axis) => grid.origin[axis]! + v * grid.h) as Vec3,
  );
  const away = (point: Vec3) => signedDistance(collider, point);
  const keptCell = new Uint8Array(cellCount(grid));

  for (let i = 0; i < job.keep.length; i++) keptCell[job.keep[i]!] = 1;

  // Corners near the part's surface (1) can leave the part while the skin is evened out. Corners on
  // it at a kept cube (2) stay on it (they may slide along it): the faces a part is held and pushed
  // at keep their edges.
  const near = Uint8Array.from({ length: mesh.positions.length / 3 }, (_, corner) => {
    const point = Array.from(mesh.positions.subarray(corner * 3, corner * 3 + 3)) as Vec3;
    const distance = away(point) / grid.h;
    const cell = cellAt(point.map((value, axis) => (value - grid.origin[axis]!) / grid.h) as Vec3);

    return Math.abs(distance) < ON_FACE && cell >= 0 && keptCell[cell] ? 2 : distance > -NEAR ? 1 : 0;
  });

  // A corner that has left the part is set back onto its surface, straight down; a corner that
  // belongs on the surface (`always`) also when it has sunk into the part.
  const backOnPart = (point: Vec3, always: boolean): Vec3 => {
    const distance = away(point);
    if (!always && !(distance > 0)) return point;

    const reach = 0.01 * grid.h;
    const slope = point.map((_, axis) => {
      const step = point.map((value, k) => (k === axis ? value + reach : value)) as Vec3;
      const back = point.map((value, k) => (k === axis ? value - reach : value)) as Vec3;

      return (away(step) - away(back)) / (2 * reach);
    });

    return point.map((value, axis) => value - distance * slope[axis]!) as Vec3;
  };

  return { positions: evened(mesh.positions, mesh.indices, near, backOnPart), indices: mesh.indices };
}

/** A corner closer to the part's surface than this (in cubes) lies on it. */
const ON_FACE = 0.3;
/**
 * Corners further inside the part than this (in cubes) never reach its surface while the skin is
 * evened out, and need not be watched.
 */
const NEAR = 1.5;
/**
 * How far a corner goes towards the middle of its neighbours in a round, and back out in the next:
 * pulling alone would thin every strut, the push after it keeps their size (Taubin smoothing).
 */
const PULL = 0.5;
const PUSH = -0.53;
const ROUNDS = 30;

/**
 * The corners of a skin evened out: ripples of the raster go, the shape stays. The skin may not
 * leave the part: after every pull and push the corners near its surface are set back into it. All
 * corners are treated alike, so the skin runs into the part's faces in a smooth line (corners held
 * on the faces while their neighbours move would leave that line jagged).
 */
function evened(
  positions: Float32Array,
  indices: Uint32Array,
  near: Uint8Array,
  backOnPart: (point: Vec3, always: boolean) => Vec3,
): Float32Array {
  const linked: Set<number>[] = Array.from(near, () => new Set());

  // Each face is two triangles a b c, a c d: its edges are a–b, b–c, c–d, d–a (not the diagonal).
  for (let t = 0; t < indices.length; t += 6) {
    const ring = [indices[t]!, indices[t + 1]!, indices[t + 2]!, indices[t + 5]!];

    ring.forEach((corner, i) => {
      linked[corner]!.add(ring[(i + 1) % 4]!);
      linked[ring[(i + 1) % 4]!]!.add(corner);
    });
  }

  let now = positions;

  for (let round = 0; round < ROUNDS; round++) {
    const next = now.slice();

    linked.forEach((others, corner) => {
      for (let axis = 0; axis < 3; axis++) {
        let middle = 0;

        others.forEach((other) => (middle += now[other * 3 + axis]!));
        next[corner * 3 + axis]! +=
          (round % 2 ? PUSH : PULL) * (middle / others.size - now[corner * 3 + axis]!);
      }
    });

    if (round % 2) {
      near.forEach((watched, corner) => {
        if (watched) {
          const point = Array.from(next.subarray(corner * 3, corner * 3 + 3)) as Vec3;

          next.set(backOnPart(point, watched === 2), corner * 3);
        }
      });
    }

    now = next;
  }

  return now;
}

/**
 * Over how many cubes the skin turns from following the density to following the part's surface.
 * Less than the half cube a full cube lies above the level, so full material ends exactly at the
 * part's faces.
 */
const BLEND = 0.4;

/**
 * The smaller of two numbers, with the kink where they are equal rounded off: where a strut runs
 * into the part's surface the skin turns smoothly instead of in a sharp, jagged rim.
 */
function roundedMin(a: number, b: number): number {
  const near = Math.max(BLEND - Math.abs(a - b), 0) / BLEND;

  return Math.min(a, b) - (near * near * BLEND) / 4;
}

/** The depth given to raster points far inside the part: more than any distance that matters. */
const DEEP = 1000;
/** Over how far (in cubes) corners and edges of the skin are rounded off, unless a job says. */
const ROUNDING = 1.2;
/** The skin's field is cut off at ±1 this many cubes⁻¹ from the skin: all that rounding needs of it. */
const STEEP = 2;

/**
 * Rounds the skin: struts cut flat by the part's surface get round shoulders, sharp edges become
 * soft, corners between struts fill in a little. The field (positive in the material) is cut off
 * to ±1 near the skin and blurred along each axis in turn; where it changes sign afterwards lies
 * the rounded skin. Large flat faces stay where they are (the blur is the same on both sides),
 * the kept cubes stay whole, and the skin still never leaves the part.
 */
function rounded(raster: Field, sigma: number, depthAt: (index: number) => number, kept: Uint8Array): void {
  const reach = Math.ceil(3 * sigma);
  const weights = Array.from({ length: reach + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  const total = weights.reduce((sum, weight, k) => sum + (k ? 2 : 1) * weight, 0);
  const stride = [1, raster.nx, raster.nx * raster.ny];
  const size = [raster.nx, raster.ny, raster.nz];
  const sharp = raster.values.map((value) => Math.max(-1, Math.min(1, value * STEEP)));
  let from = sharp;

  for (let axis = 0; axis < 3; axis++) {
    const to = new Float32Array(from.length);

    for (let index = 0; index < from.length; index++) {
      const along = Math.floor(index / stride[axis]!) % size[axis]!;
      let sum = weights[0]! * from[index]!;

      for (let k = 1; k <= reach; k++) {
        // Past the rim of the raster there is no material.
        const before = along - k >= 0 ? from[index - k * stride[axis]!]! : -1;
        const after = along + k < size[axis]! ? from[index + k * stride[axis]!]! : -1;

        sum += weights[k]! * (before + after);
      }

      to[index] = sum / total;
    }

    from = to;
  }

  // Rounding alone would thin every strut: the skin is moved out until it holds as much as before.
  const shift = levelOfCount(
    from,
    sharp.reduce((count, value) => count + (value > 0 ? 1 : 0), 0),
  );

  for (let index = 0; index < from.length; index++) {
    // Where the part is held or pushed nothing is rounded away: those faces and their edges stay.
    const value = kept[index] ? Math.max(from[index]! - shift, sharp[index]!) : from[index]! - shift;

    raster.values[index] = value > 0 ? Math.min(value, depthAt(index) * STEEP) : value;
  }
}

/** The level above which `count` of the values lie (to a thousandth), found by halving. */
function levelOfCount(values: Float32Array, count: number): number {
  let low = -1;
  let high = 1;

  for (let round = 0; round < 11; round++) {
    const level = (low + high) / 2;
    let above = 0;

    for (let i = 0; i < values.length; i++) above += values[i]! > level ? 1 : 0;

    if (above > count) low = level;
    else high = level;
  }

  return (low + high) / 2;
}

/** 1 for the raster points in or on the kept cubes. */
function keptPoints(raster: Field, job: SmoothJob, fine: number): Uint8Array {
  const { grid } = job;
  const kept = new Uint8Array(raster.values.length);

  for (let i = 0; i < job.keep.length; i++) {
    const cell = job.keep[i]!;
    const at = [cell % grid.nx, Math.floor(cell / grid.nx) % grid.ny, Math.floor(cell / (grid.nx * grid.ny))];

    for (let dz = 0; dz <= fine; dz++) {
      for (let dy = 0; dy <= fine; dy++) {
        for (let dx = 0; dx <= fine; dx++) {
          kept[
            (at[0]! + 1) * fine +
              dx +
              raster.nx * ((at[1]! + 1) * fine + dy + raster.ny * ((at[2]! + 1) * fine + dz))
          ] = 1;
        }
      }
    }
  }

  return kept;
}

/** 1 for the cubes with material all around them (edges and corners too): far from the part's surface. */
function deepCells(grid: VoxelGrid): Uint8Array {
  const deep = new Uint8Array(cellCount(grid));

  for (let z = 1; z < grid.nz - 1; z++) {
    for (let y = 1; y < grid.ny - 1; y++) {
      for (let x = 1; x < grid.nx - 1; x++) {
        let all = 1;

        for (let d = 0; d < 27 && all; d++) {
          all =
            grid.solid[
              x +
                (d % 3) -
                1 +
                grid.nx * (y + (Math.floor(d / 3) % 3) - 1 + grid.ny * (z + Math.floor(d / 9) - 1))
            ]!;
        }

        deep[x + grid.nx * (y + grid.ny * z)] = all;
      }
    }
  }

  return deep;
}

/** Takes away material that does not hang together with a kept cube: it would be a loose piece. */
function dropCrumbs(raster: Field, job: SmoothJob, fine: number): void {
  const { grid } = job;
  const reached = new Uint8Array(raster.values.length);
  const open: number[] = [];

  const reach = (index: number) => {
    if (reached[index] || !(raster.values[index]! > 0)) return;

    reached[index] = 1;
    open.push(index);
  };

  for (let i = 0; i < job.keep.length; i++) {
    const cell = job.keep[i]!;
    const at = [cell % grid.nx, Math.floor(cell / grid.nx) % grid.ny, Math.floor(cell / (grid.nx * grid.ny))];

    // The raster point in the middle of the cube (or next to it).
    reach(
      Math.round((at[0]! + 1.5) * fine) +
        raster.nx * (Math.round((at[1]! + 1.5) * fine) + raster.ny * Math.round((at[2]! + 1.5) * fine)),
    );
  }

  // No kept cube with material in its middle (rounded away at a corner): nothing to hang on.
  if (!open.length) return;

  while (open.length) around(raster, open.pop()!, reach);

  for (let index = 0; index < reached.length; index++) {
    if (!reached[index] && raster.values[index]! > 0) raster.values[index] = -1e-3;
  }
}

/**
 * The surface where a raster of numbers changes from positive (material) to negative, as triangles
 * facing outwards (surface nets): every raster cube the surface passes gets one corner, in the
 * middle of the places where the surface crosses the cube's edges; every raster edge it crosses
 * gets a face between the four cubes around that edge.
 */
function skin(
  raster: Field,
  place: (index: number) => Vec3,
): { positions: Float32Array; indices: Uint32Array } {
  const stride = [1, raster.nx, raster.nx * raster.ny];
  const size = [raster.nx, raster.ny, raster.nz];
  const cornerOf = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];

  /** The corner in the raster cube whose lowest point is `cube`. */
  const corner = (cube: number): number => {
    const known = cornerOf.get(cube);
    if (known !== undefined) return known;

    const sum = [0, 0, 0];
    let crossings = 0;

    for (let axis = 0; axis < 3; axis++) {
      for (const [du, dv] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const from = cube + du * stride[(axis + 1) % 3]! + dv * stride[(axis + 2) % 3]!;
        const a = raster.values[from]!;
        const b = raster.values[from + stride[axis]!]!;

        if (a > 0 === b > 0) continue;

        const start = place(from);
        const end = place(from + stride[axis]!);

        for (let k = 0; k < 3; k++) sum[k]! += start[k]! + (a / (a - b)) * (end[k]! - start[k]!);

        crossings++;
      }
    }

    positions.push(sum[0]! / crossings, sum[1]! / crossings, sum[2]! / crossings);
    cornerOf.set(cube, positions.length / 3 - 1);

    return positions.length / 3 - 1;
  };

  for (let index = 0; index < raster.values.length; index++) {
    const at = [index % raster.nx, Math.floor(index / raster.nx) % raster.ny, Math.floor(index / stride[2]!)];

    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;

      // The margin is never material, so edges at the rim of the raster are not crossed.
      if (at[axis]! >= size[axis]! - 1 || at[u]! < 1 || at[v]! < 1) continue;

      const here = raster.values[index]! > 0;

      if (here === raster.values[index + stride[axis]!]! > 0) continue;

      const ring = [index - stride[u]! - stride[v]!, index - stride[v]!, index, index - stride[u]!].map(
        corner,
      );

      if (!here) ring.reverse();

      indices.push(ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!);
    }
  }

  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
