/** Positions and directions on tessellated bodies for drag handles and floating UI. */
import type { BodyMesh, RebuildOutput } from "@meercad/kernel";
import { resolveEdges, resolveFaces } from "@meercad/naming";
import type { EdgeSelector, FaceSelector, ProfileRef } from "@meercad/schema";
import { toWorld } from "@meercad/sketch";
import { THREE } from "@meercad/viewport";
import { meshTopology } from "./topology";

type Vec3 = [number, number, number];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Area-weighted centroid and average normal of a face's triangles. */
export function faceAnchor(m: BodyMesh, face: number): { origin: Vec3; normal: Vec3 } | null {
  let cx = 0, cy = 0, cz = 0, area = 0;
  const n: Vec3 = [0, 0, 0];
  for (let g = 0; g < m.faceRanges.length; g += 3) {
    if (m.faceRanges[g + 2] !== face) continue;
    for (let t = m.faceRanges[g]!; t < m.faceRanges[g]! + m.faceRanges[g + 1]!; t += 3) {
      const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
      const p = m.positions;
      const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const cr: Vec3 = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const ar = Math.hypot(...cr) / 2;
      area += ar;
      cx += ((p[a]! + p[b]! + p[c]!) / 3) * ar;
      cy += ((p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3) * ar;
      cz += ((p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3) * ar;
      n[0] += cr[0];
      n[1] += cr[1];
      n[2] += cr[2];
    }
  }
  if (!area) return null;
  return { origin: [cx / area, cy / area, cz / area], normal: norm(n) };
}

export function faceSelectorAnchor(out: RebuildOutput, sel: FaceSelector) {
  try {
    const refs = resolveFaces(sel, out.meshes.map(meshTopology));
    const r = refs[0];
    const m = r && out.meshes.find((x) => x.bodyId === r.body);
    return m && r ? faceAnchor(m, r.faces[0]!) : null;
  } catch {
    return null;
  }
}

/** Edge midpoint and the outward bisector of its two faces (the direction a fillet grows into). */
export function edgeAnchor(m: BodyMesh, edge: number): { origin: Vec3; dir: Vec3 } | null {
  const topo = meshTopology(m);
  const p = topo.edgePoints?.[edge];
  const faces = m.edgeFaces[edge] ?? [];
  if (!p || faces.length < 2) return null;
  const n1 = faceAnchor(m, faces[0]!)?.normal;
  const n2 = faceAnchor(m, faces[1]!)?.normal;
  if (!n1 || !n2) return null;
  return { origin: p, dir: norm([n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]]) };
}

export function edgeSelectorAnchor(out: RebuildOutput, sel: EdgeSelector) {
  try {
    const r = resolveEdges([sel], out.meshes.map(meshTopology));
    const m = out.meshes.find((x) => x.bodyId === r.body);
    return m ? edgeAnchor(m, r.edges[0]!) : null;
  } catch {
    return null;
  }
}

/** Where an extrude handle sits: the profile's center and its plane normal (unflipped). */
export function profileAnchor(out: RebuildOutput, profile: ProfileRef): { origin: Vec3; normal: Vec3 } | null {
  if ("face" in profile) return faceSelectorAnchor(out, profile.face);
  const sk = out.report.sketches.find((s) => s.id === profile.sketch);
  if (!sk) return null;
  const regions = Array.isArray(profile.regions) ? sk.regions.filter((r) => (profile.regions as string[]).includes(r.key)) : sk.regions.filter((r) => r.depth % 2 === 1);
  if (!regions.length) return null;
  // The largest region's interior point.
  const r = regions.reduce((a, b) => (b.area > a.area ? b : a));
  return { origin: toWorld(sk.frame, r.sample), normal: sk.frame.normal };
}

/**
 * Axis and rim of a cylindrical face (hole wall or boss), measured on the tessellation so it is
 * right for pattern and mirror copies too. `prefer` orients the axis (e.g. the sketch normal) and
 * picks the radial direction closest to `radial`.
 */
export function cylinderAnchor(m: BodyMesh, face: number, prefer: Vec3, radial: Vec3): { top: Vec3; dir: Vec3; radius: number } | null {
  const pts: Vec3[] = [];
  const nrm: Vec3[] = [];
  for (let g = 0; g < m.faceRanges.length; g += 3) {
    if (m.faceRanges[g + 2] !== face) continue;
    for (let t = m.faceRanges[g]!; t < m.faceRanges[g]! + m.faceRanges[g + 1]!; t++) {
      const i = m.indices[t]! * 3;
      pts.push([m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!]);
      nrm.push([m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!]);
    }
  }
  if (pts.length < 6) return null;
  // On a cylinder every normal is perpendicular to the axis: the axis is the cross of two of them.
  let axis: Vec3 = [0, 0, 0];
  let best = 0;
  const step = Math.max(1, Math.floor(nrm.length / 24));
  for (let i = 0; i < nrm.length; i += step) {
    for (let j = i + step; j < nrm.length; j += step) {
      const a = nrm[i]!, b = nrm[j]!;
      const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const l = Math.hypot(...c);
      if (l > best) {
        best = l;
        axis = c;
      }
    }
  }
  if (best < 0.2) return null;
  axis = norm(axis);
  if (axis[0] * prefer[0] + axis[1] * prefer[1] + axis[2] * prefer[2] < 0) axis = [-axis[0], -axis[1], -axis[2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Axis point: mean of the points with their axial component removed (exact for full cylinders).
  const c = pts.reduce<Vec3>((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
  let tMax = -Infinity;
  let r = 0;
  for (const p of pts) {
    const d: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const t = dot(d, axis);
    tMax = Math.max(tMax, t);
    r += Math.hypot(d[0] - axis[0] * t, d[1] - axis[1] * t, d[2] - axis[2] * t) / pts.length;
  }
  const along = dot(radial, axis);
  let dir: Vec3 = [radial[0] - axis[0] * along, radial[1] - axis[1] * along, radial[2] - axis[2] * along];
  if (Math.hypot(...dir) < 1e-6) dir = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return { top: [c[0] + axis[0] * tMax, c[1] + axis[1] * tMax, c[2] + axis[2] * tMax], dir: norm(dir), radius: r };
}

/** Whether a face is (part of) a cylinder: every normal perpendicular to one axis, and curved. */
export function isCylinderFace(m: BodyMesh, face: number): boolean {
  const nrm: Vec3[] = [];
  for (let g = 0; g < m.faceRanges.length; g += 3) {
    if (m.faceRanges[g + 2] !== face) continue;
    for (let t = m.faceRanges[g]!; t < m.faceRanges[g]! + m.faceRanges[g + 1]!; t++) {
      const i = m.indices[t]! * 3;
      nrm.push([m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!]);
    }
  }
  if (nrm.length < 6) return false;
  let axis: Vec3 = [0, 0, 0];
  let best = 0;
  const step = Math.max(1, Math.floor(nrm.length / 24));
  for (let i = 0; i < nrm.length; i += step) {
    for (let j = i + step; j < nrm.length; j += step) {
      const a = nrm[i]!, b = nrm[j]!;
      const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const l = Math.hypot(...c);
      if (l > best) {
        best = l;
        axis = c;
      }
    }
  }
  if (best < 0.2) return false;
  axis = norm(axis);
  return nrm.every((n) => Math.abs(n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2]) < 0.05);
}

/**
 * The base of an extrusion as world-space triangles (9 numbers each): the tessellated face, or the
 * sketch regions triangulated. Used for the stand-in shown while a slow rebuild catches up.
 */
export function profileTriangles(out: RebuildOutput, profile: ProfileRef): { triangles: Float32Array; normal: Vec3 } | null {
  const tris: number[] = [];
  if ("face" in profile) {
    try {
      const r = resolveFaces(profile.face, out.meshes.map(meshTopology))[0];
      const m = r && out.meshes.find((x) => x.bodyId === r.body);
      const face = r?.faces[0];
      const a = m && face !== undefined ? faceAnchor(m, face) : null;
      if (!m || !a) return null;
      for (let g = 0; g < m.faceRanges.length; g += 3) {
        if (m.faceRanges[g + 2] !== face) continue;
        for (let t = m.faceRanges[g]!; t < m.faceRanges[g]! + m.faceRanges[g + 1]!; t++) {
          const i = m.indices[t]! * 3;
          tris.push(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!);
        }
      }
      return tris.length ? { triangles: new Float32Array(tris), normal: a.normal } : null;
    } catch {
      return null;
    }
  }
  const sk = out.report.sketches.find((s) => s.id === profile.sketch);
  if (!sk) return null;
  const regions = Array.isArray(profile.regions) ? sk.regions.filter((r) => (profile.regions as string[]).includes(r.key)) : sk.regions.filter((r) => r.depth % 2 === 1);
  for (const r of regions) {
    const [outer, ...holes] = r.polygons.map((poly) => poly.map(([x, y]) => new THREE.Vector2(x, y)));
    if (!outer) continue;
    const all = [outer, ...holes].flat();
    for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) for (const k of tri) tris.push(...toWorld(sk.frame, [all[k]!.x, all[k]!.y]));
  }
  return tris.length ? { triangles: new Float32Array(tris), normal: sk.frame.normal } : null;
}
