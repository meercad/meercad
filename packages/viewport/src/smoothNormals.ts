/**
 * Smooth shading for a mesh that comes as loose triangles: every corner takes the mean direction of
 * all triangles meeting at its place, so a curved surface made of many small triangles looks curved
 * instead of faceted. At a sharp edge (the triangles there face more than the crease angle apart)
 * a corner keeps its own triangle's direction, so edges stay edges.
 */

/** Triangles facing further apart than this (degrees) meet in an edge that stays sharp. */
export const CREASE_DEGREES = 40;

/**
 * `positions`: x, y, z per corner, three corners per triangle. `flat`: the direction each corner's
 * own triangle faces (length 1). Returns the directions to shade with.
 */
export function smoothNormals(
  positions: Float32Array,
  flat: Float32Array,
  crease = CREASE_DEGREES,
): Float32Array {
  const sums = new Map<string, [number, number, number]>();
  const key = (corner: number) => `${positions[corner]},${positions[corner + 1]},${positions[corner + 2]}`;

  for (let t = 0; t < positions.length; t += 9) {
    // Weighted by the triangle's area, so slivers do not tilt the mean.
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.subarray(t, t + 9) as unknown as number[];
    const area =
      Math.hypot(
        (by! - ay!) * (cz! - az!) - (bz! - az!) * (cy! - ay!),
        (bz! - az!) * (cx! - ax!) - (bx! - ax!) * (cz! - az!),
        (bx! - ax!) * (cy! - ay!) - (by! - ay!) * (cx! - ax!),
      ) / 2;

    for (let corner = t; corner < t + 9; corner += 3) {
      const sum = sums.get(key(corner)) ?? sums.set(key(corner), [0, 0, 0]).get(key(corner))!;

      for (let axis = 0; axis < 3; axis++) sum[axis]! += area * flat[corner + axis]!;
    }
  }

  const out = flat.slice();
  const limit = Math.cos((crease * Math.PI) / 180);

  for (let corner = 0; corner < positions.length; corner += 3) {
    const sum = sums.get(key(corner))!;
    const length = Math.hypot(...sum);
    const along = (sum[0] * flat[corner]! + sum[1] * flat[corner + 1]! + sum[2] * flat[corner + 2]!) / length;

    // NaN (triangles without area, or facing opposite ways) keeps the flat direction too.
    if (along >= limit) for (let axis = 0; axis < 3; axis++) out[corner + axis] = sum[axis]! / length;
  }

  return out;
}
