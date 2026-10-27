import type { Body } from "./body.js";
import type { OC } from "./occt.js";

/** Tessellated body, made of plain typed arrays so it can be transferred from the worker. */
export interface BodyMesh {
  bodyId: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Triples (firstIndex, indexCount, faceIndex) into `indices`. */
  faceRanges: Int32Array;
  /** Line segment vertex pairs (xyz xyz ...). */
  edgeLines: Float32Array;
  /** Triples (firstVertex, vertexCount, edgeIndex) into `edgeLines` (in vertices, not floats). */
  edgeRanges: Int32Array;
  faceTags: string[][];
  edgeFaces: number[][];
}

export interface BodySummary {
  id: string;
  volume: number;
  area: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  faces: number;
  edges: number;
}

const HASH_BOUND = 2147483647;

/** `coarse` > 1 loosens the tessellation tolerances by that factor (fewer triangles, faster). */
export function meshBody(oc: OC, body: Body, bbox: BodySummary["bbox"], coarse = 1): BodyMesh {
  const diag = Math.hypot(...bbox.max.map((v, i) => v - bbox.min[i]!));
  const linear = Math.max(0.01, diag * 5e-4) * coarse;
  const angular = Math.min(0.4, 0.25 * coarse);

  const faceByHash = new Map<number, number>();
  body.faces.forEach((f, i) => faceByHash.set(oc.ReplicadShapeHasher.HashCode(f, HASH_BOUND), i));
  const edgeByHash = new Map<number, number>();
  body.edges.forEach((e, i) => edgeByHash.set(oc.ReplicadShapeHasher.HashCode(e, HASH_BOUND), i));

  const m = oc.ReplicadMeshExtractor.extract(body.shape, linear, angular, false);
  const em = oc.ReplicadEdgeMeshExtractor.extract(body.shape, linear, angular);
  try {
    // Take buffer views only after both extractions: memory growth detaches earlier views.
    const buf = oc.wasmMemory.buffer;
    const positions = new Float32Array(buf, m.getVerticesPtr(), m.getVerticesSize()).slice();
    const normals = new Float32Array(buf, m.getNormalsPtr(), m.getNormalsSize()).slice();
    const indices = new Uint32Array(buf, m.getTrianglesPtr(), m.getTrianglesSize()).slice();
    const faceRanges = new Int32Array(buf, m.getFaceGroupsPtr(), m.getFaceGroupsSize()).slice();
    for (let i = 2; i < faceRanges.length; i += 3) faceRanges[i] = faceByHash.get(faceRanges[i]!) ?? -1;
    repairNormals(positions, normals, indices);
    const edgeLines = new Float32Array(buf, em.getLinesPtr(), em.getLinesSize()).slice();
    const edgeRanges = new Int32Array(buf, em.getEdgeGroupsPtr(), em.getEdgeGroupsSize()).slice();
    for (let i = 2; i < edgeRanges.length; i += 3) edgeRanges[i] = edgeByHash.get(edgeRanges[i]!) ?? -1;
    return {
      bodyId: body.bodyId,
      positions,
      normals,
      indices,
      faceRanges,
      edgeLines,
      edgeRanges,
      faceTags: body.faceTags.map((t) => [...t]),
      edgeFaces: body.edgeFaces.map((a) => [...a]),
    };
  } finally {
    m.delete();
    em.delete();
  }
}

/** Bounding box and counts; with `props`, also volume and surface area (integrals, slow on curved parts). */
export function summarizeBody(oc: OC, body: Body, props = true): BodySummary {
  const vol = new oc.GProp_GProps();
  const surf = new oc.GProp_GProps();
  const box = new oc.Bnd_Box();
  try {
    if (props) {
      oc.BRepGProp.VolumeProperties(body.shape, vol, false, false, false);
      oc.BRepGProp.SurfaceProperties(body.shape, surf, false, false);
    }
    oc.BRepBndLib.Add(body.shape, box, false);
    const lo = box.CornerMin();
    const hi = box.CornerMax();
    const bbox = { min: [lo.X(), lo.Y(), lo.Z()] as [number, number, number], max: [hi.X(), hi.Y(), hi.Z()] as [number, number, number] };
    lo.delete();
    hi.delete();
    return { id: body.bodyId, volume: props ? vol.Mass() : NaN, area: props ? surf.Mass() : NaN, bbox, faces: body.faces.length, edges: body.edges.length };
  } finally {
    vol.delete();
    surf.delete();
    box.delete();
  }
}

/**
 * Replaces vertex normals that disagree with the surrounding triangles (e.g. at the apex of a cone
 * where the surface normal is undefined) by the area-weighted triangle normal. Faces do not share
 * vertices, so this never smooths across sharp edges.
 */
export function repairNormals(positions: Float32Array, normals: Float32Array, indices: Uint32Array): number {
  const acc = new Float32Array(normals.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3];
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      acc[i]! += nx;
      acc[i + 1]! += ny;
      acc[i + 2]! += nz;
    }
  }
  let fixed = 0;
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(acc[i]!, acc[i + 1]!, acc[i + 2]!);
    if (!l) continue;
    const [x, y, z] = [acc[i]! / l, acc[i + 1]! / l, acc[i + 2]! / l];
    if (normals[i]! * x + normals[i + 1]! * y + normals[i + 2]! * z < 0.85) {
      normals[i] = x;
      normals[i + 1] = y;
      normals[i + 2] = z;
      fixed++;
    }
  }
  return fixed;
}
