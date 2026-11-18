/**
 * Where a sketch lies on a part: the triangles of the parts' faces in the sketch's plane, in sketch
 * coordinates. A dimension drawn there lies on the face; drawn past the face's edge it hangs in the
 * air, which seen from the side looks as if it floated above the part.
 */
type V2 = readonly [number, number];
type V3 = readonly [number, number, number];

export interface PlaneFrame {
  origin: V3;
  u: V3;
  v: V3;
  normal: V3;
}

export interface MeshLike {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/** A point this close to the plane (mm) is in it. */
const IN_PLANE = 1e-3;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Found once per set of meshes and plane (the parts change with each rebuild, the zoom does not). */
const found = new WeakMap<readonly MeshLike[], Map<string, (p: V2) => boolean>>();

/**
 * Whether a point of the plane (sketch coordinates) lies on a face of `meshes` in that plane; where no
 * face lies in the plane (a sketch in the air), everywhere is as good. The faces are looked for at the
 * first question only.
 */
export function planeSupport(meshes: readonly MeshLike[], frame: PlaneFrame): (p: V2) => boolean {
  const key = JSON.stringify(frame);
  const known = found.get(meshes)?.get(key);
  if (known) return known;

  let triangles: [V2, V2, V2][] | null = null;

  const onFace = (q: V2) => {
    triangles ??= trianglesIn(meshes, frame);

    return !triangles.length || triangles.some((tri) => inTriangle(q, tri));
  };

  if (!found.has(meshes)) found.set(meshes, new Map());

  found.get(meshes)!.set(key, onFace);

  return onFace;
}

/** The triangles of `meshes` lying in the plane, in its coordinates. */
function trianglesIn(meshes: readonly MeshLike[], frame: PlaneFrame): [V2, V2, V2][] {
  const triangles: [V2, V2, V2][] = [];

  for (const mesh of meshes) {
    const p = mesh.positions;

    const local = (i: number): [V2, number] => {
      const d: V3 = [
        p[i * 3]! - frame.origin[0],
        p[i * 3 + 1]! - frame.origin[1],
        p[i * 3 + 2]! - frame.origin[2],
      ];

      return [[dot(d, frame.u), dot(d, frame.v)], dot(d, frame.normal)];
    };

    for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
      const corners = [local(mesh.indices[t]!), local(mesh.indices[t + 1]!), local(mesh.indices[t + 2]!)];

      if (corners.every(([, h]) => Math.abs(h) < IN_PLANE)) {
        triangles.push(corners.map(([q]) => q) as [V2, V2, V2]);
      }
    }
  }

  return triangles;
}

/** Whether `q` lies in the triangle (its edges included). */
export function inTriangle(q: V2, [a, b, c]: readonly [V2, V2, V2]): boolean {
  const side = (p: V2, r: V2) => (r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0]);
  const [s1, s2, s3] = [side(a, b), side(b, c), side(c, a)];
  const eps = 1e-9;

  return (s1 >= -eps && s2 >= -eps && s3 >= -eps) || (s1 <= eps && s2 <= eps && s3 <= eps);
}
