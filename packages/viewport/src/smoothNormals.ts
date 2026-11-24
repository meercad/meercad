/**
 * Smooth shading for a mesh that comes as loose triangles: every corner takes the mean direction of
 * all triangles meeting at its place, so a curved surface made of many small triangles looks curved
 * instead of faceted. At a sharp edge (the triangles there face more than the crease angle apart)
 * a corner keeps its own triangle's direction, so edges stay edges.
 */

/** Triangles facing further apart than this (degrees) meet in an edge that stays sharp. */
export const CREASE_DEGREES = 30;

/**
 * `positions`: x, y, z per corner. `flat`: the direction each corner's own face looks (length 1).
 * `indices`: the corners of each triangle; left out, every three corners in a row are one. Returns
 * the directions to shade with.
 */
export function smoothNormals(
  positions: Float32Array,
  flat: Float32Array,
  indices?: ArrayLike<number>,
  crease = CREASE_DEGREES,
): Float32Array {
  const sums = new Map<string, [number, number, number]>();
  const key = (corner: number) => `${positions[corner]},${positions[corner + 1]},${positions[corner + 2]}`;
  const count = indices ? indices.length : positions.length / 3;
  const cornerOf = (k: number) => (indices ? indices[k]! : k) * 3;

  for (let t = 0; t < count; t += 3) {
    const [a, b, c] = [cornerOf(t), cornerOf(t + 1), cornerOf(t + 2)];
    const u = [0, 1, 2].map((axis) => positions[b + axis]! - positions[a + axis]!);
    const v = [0, 1, 2].map((axis) => positions[c + axis]! - positions[a + axis]!);
    // Weighted by the triangle's area, so slivers do not tilt the mean.
    const area =
      Math.hypot(
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ) / 2;

    for (const corner of [a, b, c]) {
      const sum = sums.get(key(corner)) ?? sums.set(key(corner), [0, 0, 0]).get(key(corner))!;

      for (let axis = 0; axis < 3; axis++) sum[axis]! += area * flat[corner + axis]!;
    }
  }

  const out = flat.slice();
  const limit = Math.cos((crease * Math.PI) / 180);

  for (let corner = 0; corner < positions.length; corner += 3) {
    const sum = sums.get(key(corner));
    // A corner no triangle uses keeps what it has.
    if (!sum) continue;

    const length = Math.hypot(...sum);
    const along = (sum[0] * flat[corner]! + sum[1] * flat[corner + 1]! + sum[2] * flat[corner + 2]!) / length;

    // NaN (triangles without area, or facing opposite ways) keeps the flat direction too.
    if (along >= limit) for (let axis = 0; axis < 3; axis++) out[corner + axis] = sum[axis]! / length;
  }

  return out;
}
