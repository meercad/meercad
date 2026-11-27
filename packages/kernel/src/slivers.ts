/**
 * Triangles without area in a closed mesh: three corners on one line, as mesh tools leave them when
 * they reduce or remesh a part. OCCT builds no face from such a triangle and drops it, which tears
 * two slits into an otherwise closed mesh; the import then fell back to sewing all triangles, minutes
 * long, and at 90 000 triangles the kernel ran out of memory (a Voronoi shell, 2026-11-27).
 *
 * Each such triangle is taken out here instead: its middle corner lies on its long edge, so the
 * neighbour across that edge is split in two at that corner and the mesh stays closed. No OCCT.
 */

/** A corner this near (mm) to the opposite edge's line makes a triangle without area. */
export const SLIVER_HEIGHT = 1e-6;

/**
 * `corners` (9 numbers per triangle) without its triangles of no area, or null when it has none or
 * they cannot be taken out (the mesh is open or not wound one way there).
 */
export function withoutSlivers(corners: ArrayLike<number>): Float32Array | null {
  const count = corners.length / 9;
  if (!hasSliver(corners, count)) return null;

  // Corners with equal coordinates are one vertex.
  const ids = new Map<string, number>();
  const xyz: number[] = [];
  const tris: number[] = [];

  for (let k = 0; k < count * 3; k++) {
    const [x, y, z] = [corners[k * 3]!, corners[k * 3 + 1]!, corners[k * 3 + 2]!];
    const key = `${x},${y},${z}`;
    let id = ids.get(key);

    if (id === undefined) {
      ids.set(key, (id = ids.size));
      xyz.push(x, y, z);
    }

    tris.push(id);
  }

  const nv = ids.size;
  const alive: boolean[] = new Array<boolean>(count).fill(true);
  // The triangle that runs each edge a → b.
  const owner = new Map<number, number>();

  const claim = (t: number) => {
    for (let k = 0; k < 3; k++) owner.set(tris[t * 3 + k]! * nv + tris[t * 3 + ((k + 1) % 3)]!, t);
  };

  const release = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const key = tris[t * 3 + k]! * nv + tris[t * 3 + ((k + 1) % 3)]!;
      if (owner.get(key) === t) owner.delete(key);
    }

    alive[t] = false;
  };

  for (let t = 0; t < count; t++) claim(t);

  const queue: number[] = [];
  for (let t = 0; t < count; t++) if (flat(xyz, tris, t) !== null) queue.push(t);

  // Splitting a neighbour can leave new triangles without area; each split takes one away for good,
  // so the work ends, and the limit only guards against a mesh that is not what it seems.
  for (let steps = 0; queue.length; steps++) {
    if (steps > count * 4) return null;

    const t = queue.pop()!;
    if (!alive[t]) continue;

    const k = flat(xyz, tris, t);
    if (k === null) continue;

    // The long edge p → q and the corner m on it.
    const [p, q, m] = [tris[t * 3 + k]!, tris[t * 3 + ((k + 1) % 3)]!, tris[t * 3 + ((k + 2) % 3)]!];
    const n = owner.get(q * nv + p);
    if (n === undefined || n === t || !alive[n]) return null;

    const at = [0, 1, 2].find((j) => tris[n * 3 + j] === q && tris[n * 3 + ((j + 1) % 3)] === p)!;
    const d = tris[n * 3 + ((at + 2) % 3)]!;
    release(t);
    release(n);

    // Two triangles folded onto each other: both go.
    if (d === m) continue;

    for (const [a, b, c] of [
      [q, m, d],
      [m, p, d],
    ] as const) {
      const fresh = alive.length;
      tris.push(a, b, c);
      alive.push(true);
      claim(fresh);
      queue.push(fresh);
    }
  }

  const out: number[] = [];

  alive.forEach((keep, t) => {
    if (!keep) return;

    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k]! * 3;
      out.push(xyz[v]!, xyz[v + 1]!, xyz[v + 2]!);
    }
  });

  return Float32Array.from(out);
}

function hasSliver(corners: ArrayLike<number>, count: number): boolean {
  const index = [0, 1, 2];

  for (let t = 0; t < count; t++) {
    if (flatCorner(corners, t * 9, t * 9 + 3, t * 9 + 6, index) !== null) return true;
  }

  return false;
}

/** For a triangle without area: where in it its longest edge starts (0, 1 or 2); else null. */
function flat(xyz: readonly number[], tris: readonly number[], t: number): number | null {
  return flatCorner(xyz, tris[t * 3]! * 3, tris[t * 3 + 1]! * 3, tris[t * 3 + 2]! * 3, [0, 1, 2]);
}

function flatCorner(
  p: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  index: readonly number[],
): number | null {
  const at = [a, b, c];
  const edge = (i: number, j: number) =>
    Math.hypot(p[at[j]!]! - p[at[i]!]!, p[at[j]! + 1]! - p[at[i]! + 1]!, p[at[j]! + 2]! - p[at[i]! + 2]!);
  const lengths = [edge(0, 1), edge(1, 2), edge(2, 0)];
  const longest = index.reduce((best, k) => (lengths[k]! > lengths[best]! ? k : best), 0);
  const [ux, uy, uz] = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
  const [vx, vy, vz] = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
  const twice = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);

  // Height over the longest edge; three corners in one place have no edge at all.
  return lengths[longest]! === 0 || twice / lengths[longest]! < SLIVER_HEIGHT ? longest : null;
}
