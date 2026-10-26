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

export function meshBody(oc: OC, body: Body, bbox: BodySummary["bbox"]): BodyMesh {
  const diag = Math.hypot(...bbox.max.map((v, i) => v - bbox.min[i]!));
  const linear = Math.max(0.01, diag * 5e-4);
  const angular = 0.25;

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

export function summarizeBody(oc: OC, body: Body): BodySummary {
  const vol = new oc.GProp_GProps();
  const surf = new oc.GProp_GProps();
  const box = new oc.Bnd_Box();
  try {
    oc.BRepGProp.VolumeProperties(body.shape, vol, false, false, false);
    oc.BRepGProp.SurfaceProperties(body.shape, surf, false, false);
    oc.BRepBndLib.Add(body.shape, box, false);
    const lo = box.CornerMin();
    const hi = box.CornerMax();
    const bbox = { min: [lo.X(), lo.Y(), lo.Z()] as [number, number, number], max: [hi.X(), hi.Y(), hi.Z()] as [number, number, number] };
    lo.delete();
    hi.delete();
    return { id: body.bodyId, volume: vol.Mass(), area: surf.Mass(), bbox, faces: body.faces.length, edges: body.edges.length };
  } finally {
    vol.delete();
    surf.delete();
    box.delete();
  }
}
