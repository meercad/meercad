import type { Body } from "./body.js";
import type { OC } from "./occt.js";
import type { GProp_GProps } from "replicad-opencascadejs";

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
  /**
   * For a part that still shows an imported mesh's own triangles (also moved, copied or patterned):
   * the import feature, and whether the corners of each triangle were turned round (display corner
   * k of triangle i is then file corner [0, 2, 1][k] of the file's triangle i). Lets a scan's
   * texture follow the part.
   */
  source?: { feature: string; flipped: boolean };
  /**
   * The triangles carry a height picture (a lithophane: finer than the faces, moved off the smooth surface).
   */
  textured?: boolean;
}

export interface BodySummary {
  id: string;
  volume: number;
  area: number;
  /** Centre of volume (with `props`). */
  centroid?: [number, number, number];
  /**
   * Second moments of the volume about the centroid, axes parallel to X, Y, Z (mm⁵; times density
   * gives the inertia): Ixx, Iyy, Izz and the products ∫xy, ∫xz, ∫yz (with `props`).
   */
  inertia?: [number, number, number, number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] };
  faces: number;
  edges: number;
}

const HASH_BOUND = 2147483647;

/**
 * An imported mesh's own triangles as a BodyMesh: triangle i is face i, normals are flat (facing out;
 * a mesh wound the other way round is flipped) and no edges are drawn, as meshes are whole parts.
 */
function sourceMeshOf(body: Body, corners: Float32Array): BodyMesh {
  const n = corners.length / 9;
  let vol = 0;

  for (let t = 0; t < corners.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = corners.subarray(t, t + 9) as unknown as number[];
    vol += ax! * (by! * cz! - bz! * cy!) - ay! * (bx! * cz! - bz! * cx!) + az! * (bx! * cy! - by! * cx!);
  }

  const order = vol < 0 ? [0, 6, 3] : [0, 3, 6];
  const positions = new Float32Array(corners.length);
  const normals = new Float32Array(corners.length);

  for (let t = 0; t < corners.length; t += 9) {
    for (let k = 0; k < 3; k++) positions.set(corners.subarray(t + order[k]!, t + order[k]! + 3), t + k * 3);

    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.subarray(t, t + 9) as unknown as number[];
    const ux = bx! - ax!,
      uy = by! - ay!,
      uz = bz! - az!,
      vx = cx! - ax!,
      vy = cy! - ay!,
      vz = cz! - az!;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 3; k++) normals.set([nx / len, ny / len, nz / len], t + k * 3);
  }

  const faceRanges = new Int32Array(n * 3);
  for (let i = 0; i < n; i++) faceRanges.set([i * 3, 3, i], i * 3);

  return {
    bodyId: body.bodyId,
    positions,
    normals,
    indices: Uint32Array.from({ length: n * 3 }, (_, i) => i),
    faceRanges,
    edgeLines: new Float32Array(),
    edgeRanges: new Int32Array(),
    faceTags: body.faceTags.map((t) => [...t]),
    edgeFaces: body.edgeFaces.map((a) => [...a]),
    ...(body.sourceFeature ? { source: { feature: body.sourceFeature, flipped: vol < 0 } } : {}),
  };
}

/**
 * Tolerances for STL/3MF export: a round face deviates at most ~0.01 mm (less on small parts)
 * from the exact surface and no facet spans more than ~3°, well below what a printer or mill
 * resolves. The model itself keeps exact circles; only exported triangles approximate them.
 */
export function exportTolerance(diag: number): { linear: number; angular: number } {
  return { linear: Math.min(0.01, Math.max(0.001, diag * 1e-4)), angular: 0.05 };
}

/**
 * Display tessellation: `coarse` > 1 loosens the tolerances by that factor (fewer triangles,
 * faster). `exact` asks for print/CNC quality instead (see `exportTolerance`).
 */
export function meshBody(oc: OC, body: Body, bbox: BodySummary["bbox"], coarse = 1, exact = false): BodyMesh {
  if (body.sourceMesh) return sourceMeshOf(body, body.sourceMesh);

  const diag = Math.hypot(...bbox.max.map((v, i) => v - bbox.min[i]!));
  if (!exact) coarse *= body.displayCoarse;

  const { linear, angular } = exact
    ? (body.exportTolerance ?? exportTolerance(diag))
    : { linear: Math.max(0.01, diag * 5e-4) * coarse, angular: Math.min(0.3, 0.06 * coarse) };

  const faceByHash = new Map<number, number>();
  body.faces.forEach((face, i) => faceByHash.set(oc.ReplicadShapeHasher.HashCode(face, HASH_BOUND), i));

  const edgeByHash = new Map<number, number>();
  body.edges.forEach((edge, i) => edgeByHash.set(oc.ReplicadShapeHasher.HashCode(edge, HASH_BOUND), i));

  const m = oc.ReplicadMeshExtractor.extract(body.shape, linear, angular, false);
  const em = oc.ReplicadEdgeMeshExtractor.extract(body.shape, linear, angular);

  try {
    // Take buffer views only after both extractions: memory growth detaches earlier views. Pointers
    // past 2 GB arrive as negative int32 from embind, hence `>>> 0`.
    const buf = oc.wasmMemory.buffer;
    const positions = new Float32Array(buf, m.getVerticesPtr() >>> 0, m.getVerticesSize()).slice();
    const normals = new Float32Array(buf, m.getNormalsPtr() >>> 0, m.getNormalsSize()).slice();
    const indices = new Uint32Array(buf, m.getTrianglesPtr() >>> 0, m.getTrianglesSize()).slice();
    const faceRanges = new Int32Array(buf, m.getFaceGroupsPtr() >>> 0, m.getFaceGroupsSize()).slice();
    for (let i = 2; i < faceRanges.length; i += 3) faceRanges[i] = faceByHash.get(faceRanges[i]!) ?? -1;
    repairNormals(positions, normals, indices);

    const edgeLines = new Float32Array(buf, em.getLinesPtr() >>> 0, em.getLinesSize()).slice();
    const allRanges = new Int32Array(buf, em.getEdgeGroupsPtr() >>> 0, em.getEdgeGroupsSize()).slice();
    for (let i = 2; i < allRanges.length; i += 3) allRanges[i] = edgeByHash.get(allRanges[i]!) ?? -1;

    // The seam of a round face (where a cylinder or cone closes on itself) is no real edge: not drawn.
    const isSeam = (e: number) => {
      const faces = body.edgeFaces[e];

      return faces?.length === 1 && oc.BRep_Tool.IsClosed(body.edges[e]!, body.faces[faces[0]!]!);
    };

    const kept: number[] = [];

    for (let i = 0; i < allRanges.length; i += 3) {
      if (allRanges[i + 2]! < 0 || !isSeam(allRanges[i + 2]!)) {
        kept.push(allRanges[i]!, allRanges[i + 1]!, allRanges[i + 2]!);
      }
    }

    const edgeRanges = Int32Array.from(kept);

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

/**
 * Volume, area, centroid and moments of a closed triangle mesh (corners, three per triangle), from
 * the tetrahedra each triangle makes with the origin; a mesh wound inside out counts the same.
 */
export function meshProps(
  c: ArrayLike<number>,
): Pick<BodySummary, "volume" | "area" | "centroid" | "inertia"> {
  let v = 0,
    area = 0;
  let mx = 0,
    my = 0,
    mz = 0;
  // ∫x², ∫y², ∫z², ∫xy, ∫xz, ∫yz over the volume
  let sxx = 0,
    syy = 0,
    szz = 0,
    sxy = 0,
    sxz = 0,
    syz = 0;

  for (let q = 0; q + 8 < c.length; q += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [
      c[q]!,
      c[q + 1]!,
      c[q + 2]!,
      c[q + 3]!,
      c[q + 4]!,
      c[q + 5]!,
      c[q + 6]!,
      c[q + 7]!,
      c[q + 8]!,
    ];
    const d = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    v += d / 6;
    mx += (d * (ax + bx + cx)) / 24;
    my += (d * (ay + by + cy)) / 24;
    mz += (d * (az + bz + cz)) / 24;

    const sq = (p: number, q2: number, r: number) => p * p + q2 * q2 + r * r + p * q2 + p * r + q2 * r;
    const pr = (p1: number, p2: number, q1: number, q2: number, r1: number, r2: number) =>
      2 * (p1 * p2 + q1 * q2 + r1 * r2) + p1 * q2 + p2 * q1 + p1 * r2 + p2 * r1 + q1 * r2 + q2 * r1;
    sxx += (d * sq(ax, bx, cx)) / 60;
    syy += (d * sq(ay, by, cy)) / 60;
    szz += (d * sq(az, bz, cz)) / 60;
    sxy += (d * pr(ax, ay, bx, by, cx, cy)) / 120;
    sxz += (d * pr(ax, az, bx, bz, cx, cz)) / 120;
    syz += (d * pr(ay, az, by, bz, cy, cz)) / 120;

    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az,
      wx = cx - ax,
      wy = cy - ay,
      wz = cz - az;
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }

  if (!v) return { volume: 0, area };

  const g: [number, number, number] = [mx / v, my / v, mz / v];
  // About the centroid; the signs cancel for a mesh wound inside out.
  const V = Math.abs(v);
  const [xx, yy, zz] = [
    (sxx / v - g[0] * g[0]) * V,
    (syy / v - g[1] * g[1]) * V,
    (szz / v - g[2] * g[2]) * V,
  ];
  const [xy, xz, yz] = [
    (sxy / v - g[0] * g[1]) * V,
    (sxz / v - g[0] * g[2]) * V,
    (syz / v - g[1] * g[2]) * V,
  ];

  return { volume: V, area, centroid: g, inertia: [yy + zz, xx + zz, xx + yy, xy, xz, yz] };
}

/**
 * Moments about axes through the centroid: the matrix itself is not reachable from the bindings,
 * so the products come from moments about the diagonals (I along (x+y)/√2 is (Ixx+Iyy)/2 − ∫xy).
 */
function momentsAbout(
  oc: OC,
  props: GProp_GProps,
  c: [number, number, number],
): [number, number, number, number, number, number] {
  const about = (d: [number, number, number]) => {
    const p = new oc.gp_Pnt(...c);
    const dir = new oc.gp_Dir(...d);
    const ax = new oc.gp_Ax1(p, dir);

    try {
      return props.MomentOfInertia(ax);
    } finally {
      ax.delete();
      dir.delete();
      p.delete();
    }
  };

  const [xx, yy, zz] = [about([1, 0, 0]), about([0, 1, 0]), about([0, 0, 1])];

  return [
    xx,
    yy,
    zz,
    (xx + yy) / 2 - about([1, 1, 0]),
    (xx + zz) / 2 - about([1, 0, 1]),
    (yy + zz) / 2 - about([0, 1, 1]),
  ];
}

/**
 * Whether a part has edges along splines of many spans: sketch splines (fitted through their
 * points) and what lofts or sweeps make of them. Circles, lines and the few-span curves of booleans
 * and lofts through circles integrate exactly the quick way. Mesh parts have none.
 */
function hasSplines(oc: OC, body: Body): boolean {
  if (body.sourceMesh) return false;

  return body.edges.some((e) => {
    if (oc.BRep_Tool.Degenerated(e)) return false;

    const c = new oc.BRepAdaptor_Curve(e);

    try {
      return String(c.GetType()) === "GeomAbs_BSplineCurve" && c.NbKnots() >= 16;
    } finally {
      c.delete();
    }
  });
}

/** Bounding box and counts; with `props`, also volume and surface area (integrals, slow on curved parts). */
export function summarizeBody(oc: OC, body: Body, props = true): BodySummary {
  // A part made from a mesh is its triangles: their integrals are exact and take milliseconds, where
  // OCCT's go face by face (seconds for tens of thousands).
  if (props && body.sourceMesh) {
    const quick = summarizeBody(oc, body, false);

    return { ...quick, ...meshProps(body.sourceMesh) };
  }

  const vol = new oc.GProp_GProps();
  const surf = new oc.GProp_GProps();
  const box = new oc.Bnd_Box();

  try {
    if (props) {
      if (body.preciseProps) {
        oc.BRepGProp.VolumeProperties(body.shape, vol, 1e-5, false, false);
      }
      // Spline edges and faces: the quick integration takes too few points along curves of many
      // spans (a symmetric spline profile came out 0.7 mm off centre, its volume 1 % off), and the
      // exact one per span takes seconds on a gear. A fine triangulation (5 µm, or 1/50000 of the
      // part's size) is within 0.01 % and quick; it is dropped again so the display meshes as before.
      else if (hasSplines(oc, body)) {
        const box = new oc.Bnd_Box();
        oc.BRepBndLib.Add(body.shape, box, false);

        const [lo, hi] = [box.CornerMin(), box.CornerMax()];
        const diag = Math.hypot(hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z());
        [lo, hi, box].forEach((x) => x.delete());
        new oc.BRepMesh_IncrementalMesh(body.shape, Math.max(0.005, diag * 2e-5), false, 0.1, false).delete();
        oc.BRepGProp.VolumeProperties(body.shape, vol, false, false, true);
        oc.BRepTools.Clean(body.shape, true);
      } else {
        oc.BRepGProp.VolumeProperties(body.shape, vol, false, false, false);
      }

      oc.BRepGProp.SurfaceProperties(body.shape, surf, false, false);
    }

    // The plain box can be millimetres too big around threads and other spline faces; mesh parts
    // (thousands of flat triangles) keep the quick one, which is exact for them.
    if (body.sourceMesh) oc.BRepBndLib.Add(body.shape, box, false);
    else oc.BRepBndLib.AddOptimal(body.shape, box, false, false);

    const lo = box.CornerMin();
    const hi = box.CornerMax();
    const bbox = {
      min: [lo.X(), lo.Y(), lo.Z()] as [number, number, number],
      max: [hi.X(), hi.Y(), hi.Z()] as [number, number, number],
    };
    lo.delete();
    hi.delete();

    let centroid: [number, number, number] | undefined;

    if (props && vol.Mass() > 0) {
      const c = vol.CentreOfMass();
      centroid = [c.X(), c.Y(), c.Z()];
      c.delete();
    }

    const inertia = centroid ? momentsAbout(oc, vol, centroid) : undefined;

    return {
      id: body.bodyId,
      volume: props ? vol.Mass() : NaN,
      area: props ? surf.Mass() : NaN,
      ...(centroid ? { centroid } : {}),
      ...(inertia ? { inertia } : {}),
      bbox,
      faces: body.faces.length,
      edges: body.edges.length,
    };
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
    const ux = positions[b]! - positions[a]!,
      uy = positions[b + 1]! - positions[a + 1]!,
      uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!,
      vy = positions[c + 1]! - positions[a + 1]!,
      vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;

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
