import { displayTolerance, meshBody, type BodyMesh, type BodySummary } from "./mesh.js";
import type { Body } from "./body.js";
import type { OC } from "./occt.js";

/** A move as the rows of a 3×4 matrix (turn or mirror, then shift). */
export type Move = number[];

const IDENTITY: Move = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** `after` following `first`. */
export function composeMoves(after: Move, first: Move): Move {
  const out: Move = [];

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = c === 3 ? after[r * 4 + 3]! : 0;
      for (let k = 0; k < 3; k++) v += after[r * 4 + k]! * first[k * 4 + c]!;
      out.push(v);
    }
  }

  return out;
}

/** The way back of a move without scaling (its turn or mirror part is its own transpose backwards). */
export function invertMove(m: Move): Move {
  const out: Move = [];

  for (let r = 0; r < 3; r++) {
    let t = 0;

    for (let k = 0; k < 3; k++) {
      out.push(m[k * 4 + r]!);
      t -= m[k * 4 + r]! * m[k * 4 + 3]!;
    }

    out.push(t);
  }

  return out;
}

const determinant = (m: Move) =>
  m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
  m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) +
  m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);

/** Points (or, with `directions`, directions) moved by `m`. */
function movePoints(src: Float32Array, m: Move, directions = false): Float32Array {
  const out = new Float32Array(src.length);
  const [a, b, c, d, e, f, g, h, i, j, k, l] = m as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [tx, ty, tz] = directions ? [0, 0, 0] : [d, h, l];

  for (let p = 0; p < src.length; p += 3) {
    const x = src[p]!,
      y = src[p + 1]!,
      z = src[p + 2]!;
    out[p] = a * x + b * y + c * z + tx;
    out[p + 1] = e * x + f * y + g * z + ty;
    out[p + 2] = i * x + j * y + k * z + tz;
  }

  return out;
}

/** `mesh` of one part as the mesh of `body`, which is that part moved by `m`. */
export function moveMesh(mesh: BodyMesh, body: Body, m: Move): BodyMesh {
  // Every mesh has arrays of its own, as if it had been meshed.
  const indices = mesh.indices.slice();

  if (determinant(m) < 0) {
    // Mirrored: the triangles turn the other way round, so that their outside stays outside.
    for (let t = 0; t < indices.length; t += 3) {
      const v = indices[t + 1]!;
      indices[t + 1] = indices[t + 2]!;
      indices[t + 2] = v;
    }
  }

  return {
    bodyId: body.bodyId,
    positions: movePoints(mesh.positions, m),
    normals: movePoints(mesh.normals, m, true),
    indices,
    faceRanges: mesh.faceRanges.slice(),
    edgeLines: movePoints(mesh.edgeLines, m),
    edgeRanges: mesh.edgeRanges.slice(),
    faceTags: body.faceTags.map((t) => [...t]),
    edgeFaces: mesh.edgeFaces.map((a) => [...a]),
  };
}

interface Meshed {
  mesh: BodyMesh;
  /** From the first part of the chain to the part `mesh` shows. */
  matrix: Move;
  linear: number;
  angular: number;
}

/**
 * Display meshes of parts that are copies of each other. A design with a mirrored half, or the same
 * servo in twenty places, meshed each of them anew: of the robot design's 570 parts 517 look like
 * another one, two thirds of its meshing time. A part that is another one moved, turned or mirrored
 * (Body.copyOf) now takes that part's triangles, moved the same way: the very same triangles, so it
 * looks as before, and only when that mesh is at least as fine as its own would be (the tolerance
 * follows the size of the part's box, which changes when it is turned).
 */
export class CopyMeshes {
  private readonly meshed = new WeakMap<Body, Meshed>();

  constructor(private readonly oc: OC) {}

  /** The tolerances `body` would be meshed with by itself. */
  tolerance(body: Body, bbox: BodySummary["bbox"], coarse: number): { linear: number; angular: number } {
    return displayTolerance(
      Math.hypot(...bbox.max.map((v, i) => v - bbox.min[i]!)),
      coarse * body.displayCoarse,
    );
  }

  mesh(body: Body, bbox: BodySummary["bbox"], coarse: number): BodyMesh {
    const root = body.copyOf?.root ?? body;
    const matrix = body.copyOf?.matrix ?? IDENTITY;
    const own = this.tolerance(body, bbox, coarse);
    const have = body.sourceMesh ? undefined : this.meshed.get(root);
    const fits =
      have &&
      have.linear <= own.linear * (1 + 1e-9) &&
      have.angular <= own.angular + 1e-12 &&
      have.mesh.faceTags.length === body.faces.length;
    if (have && fits) return moveMesh(have.mesh, body, composeMoves(matrix, invertMove(have.matrix)));

    const mesh = meshBody(this.oc, body, bbox, coarse);

    // The finest mesh of the chain serves the others.
    if (!body.sourceMesh && (!have || own.linear < have.linear)) {
      this.meshed.set(root, { mesh, matrix, ...own });
    }

    return mesh;
  }
}
