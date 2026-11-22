/**
 * Faces of a part for the strength check: their triangles, and the force on them as a direction
 * and a size.
 */
import type { BodyMesh } from "@meercad/kernel";

export type LoadDirection = "into" | "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

export const LOAD_DIRECTIONS: readonly LoadDirection[] = ["into", "-z", "+z", "-x", "+x", "-y", "+y"];

type Vec3 = [number, number, number];

/** The triangles (three corners each, as indices into the part's positions) of some of its faces. */
export function faceTriangles(
  mesh: Pick<BodyMesh, "indices" | "faceRanges">,
  faces: readonly number[],
): Uint32Array {
  const out: number[] = [];

  for (let r = 0; r < mesh.faceRanges.length; r += 3) {
    if (!faces.includes(mesh.faceRanges[r + 2]!)) continue;

    const first = mesh.faceRanges[r]!;

    for (let i = first; i < first + mesh.faceRanges[r + 1]!; i++) out.push(mesh.indices[i]!);
  }

  return Uint32Array.from(out);
}

/**
 * A force of `newton` N on some triangles: along an axis, or straight into the faces (against the
 * direction they face on average). Faces that face all ways (a hole all round) have no "into": the
 * force then goes down.
 */
export function loadForce(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  newton: number,
  direction: LoadDirection,
): Vec3 {
  if (direction !== "into") {
    const force: Vec3 = [0, 0, 0];

    force["xyz".indexOf(direction[1]!)] = direction[0] === "+" ? newton : -newton;

    return force;
  }

  const facing: Vec3 = [0, 0, 0];
  let area = 0;

  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) =>
      [0, 1, 2].map((axis) => positions[triangles[t + k]! * 3 + axis]!),
    ) as [Vec3, Vec3, Vec3];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];

    normal.forEach((value, axis) => (facing[axis]! += value));
    area += Math.hypot(...normal);
  }

  const length = Math.hypot(...facing);

  // Less than a tenth of the area left after adding up: the faces face all ways.
  if (!(length > 0.1 * area)) return [0, 0, -newton];

  return facing.map((value) => (-value / length) * newton) as Vec3;
}
