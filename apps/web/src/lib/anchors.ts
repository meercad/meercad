/** Positions and directions on tessellated bodies for drag handles and floating UI. */
import type { BodyMesh, RebuildOutput } from "@opencad/kernel";
import { resolveEdges, resolveFaces } from "@opencad/naming";
import type { EdgeSelector, FaceSelector, ProfileRef } from "@opencad/schema";
import { toWorld } from "@opencad/sketch";
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
