/**
 * A part that is a copy of another takes that part's triangles, moved the same way (CopyMeshes).
 * Here such a mesh is held against the mesh the part gets by itself: every face and every edge
 * must lie where it lies there, and every triangle must face outwards.
 */
import { meshBody, type BodyMesh, type KernelSession } from "@meercad/kernel";
import type { OC } from "../packages/kernel/src/occt.js";

type Box = { min: number[]; max: number[] };
const boxOf = (points: Float32Array, at: Iterable<number>): Box => {
  const b: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const i of at) for (let k = 0; k < 3; k++) {
    b.min[k] = Math.min(b.min[k]!, points[i * 3 + k]!);
    b.max[k] = Math.max(b.max[k]!, points[i * 3 + k]!);
  }
  return b;
};

/** Area of a face's triangles, and how far its normals agree with the way the triangles turn (1: all). */
function faceOf(m: BodyMesh, start: number, count: number): { box: Box; area: number; outward: number; normal: number[] } {
  const idx = m.indices.subarray(start, start + count);
  let area = 0, agree = 0;
  const normal = [0, 0, 0];
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3];
    const p = m.positions;
    const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const twice = Math.hypot(n[0]!, n[1]!, n[2]!);
    area += twice / 2;
    for (let k = 0; k < 3; k++) normal[k]! += n[k]! / 2;
    const dot = n[0]! * m.normals[a]! + n[1]! * m.normals[a + 1]! + n[2]! * m.normals[a + 2]!;
    agree += (dot > 0 ? 1 : -1) * twice / 2;
  }
  return { box: boxOf(m.positions, idx), area, outward: area ? agree / area : 1, normal };
}

/** What differs between the meshes of copies in the session's last result and the meshes those parts get alone; and how many were compared. */
export function copyMeshProblems(oc: OC, session: KernelSession, meshes: BodyMesh[], coarse = 1): { copies: number; problems: string[] } {
  const problems: string[] = [];
  let copies = 0;
  const byId = new Map(meshes.map((m) => [m.bodyId, m]));
  for (const body of session.state!.bodies.values()) {
    if (!body.copyOf && ![...session.state!.bodies.values()].some((o) => o.copyOf?.root === body)) continue;
    copies++;
    const got = byId.get(body.bodyId)!;
    const bb = boxOf(got.positions, Array.from({ length: got.positions.length / 3 }, (_, i) => i));
    const alone = meshBody(oc, body, bb as { min: [number, number, number]; max: [number, number, number] }, coarse);
    const where = `part ${body.bodyId}`;
    const tol = 0.02 * Math.max(1, Math.hypot(...bb.max.map((v, i) => v - bb.min[i]!)) * 5e-2);
    if (got.faceRanges.length !== alone.faceRanges.length || got.edgeRanges.length !== alone.edgeRanges.length) {
      problems.push(`${where}: ${got.faceRanges.length / 3} faces and ${got.edgeRanges.length / 3} edges, alone ${alone.faceRanges.length / 3} and ${alone.edgeRanges.length / 3}`);
      continue;
    }
    if (JSON.stringify(got.faceTags) !== JSON.stringify(alone.faceTags)) problems.push(`${where}: other face names`);
    if (JSON.stringify(got.edgeFaces) !== JSON.stringify(alone.edgeFaces)) problems.push(`${where}: other faces at the edges`);
    const aloneFaces = new Map<number, { start: number; count: number }>();
    for (let i = 0; i < alone.faceRanges.length; i += 3) aloneFaces.set(alone.faceRanges[i + 2]!, { start: alone.faceRanges[i]!, count: alone.faceRanges[i + 1]! });
    for (let i = 0; i < got.faceRanges.length; i += 3) {
      const face = got.faceRanges[i + 2]!;
      const other = aloneFaces.get(face);
      if (!other) {
        problems.push(`${where}: face ${face} is missing alone`);
        continue;
      }
      const a = faceOf(got, got.faceRanges[i]!, got.faceRanges[i + 1]!);
      const b = faceOf(alone, other.start, other.count);
      for (let k = 0; k < 3; k++) if (Math.abs(a.box.min[k]! - b.box.min[k]!) > tol || Math.abs(a.box.max[k]! - b.box.max[k]!) > tol) problems.push(`${where}: face ${face} lies elsewhere (${a.box.min.map((v) => v.toFixed(2))}…${a.box.max.map((v) => v.toFixed(2))} against ${b.box.min.map((v) => v.toFixed(2))}…${b.box.max.map((v) => v.toFixed(2))})`);
      if (Math.abs(a.area - b.area) > 0.03 * b.area + tol * tol) problems.push(`${where}: face ${face} has area ${a.area.toFixed(3)}, alone ${b.area.toFixed(3)}`);
      if (a.outward < 0.999) problems.push(`${where}: face ${face} has triangles turned against their normals (${a.outward.toFixed(3)})`);
      // The triangles look the same way as alone (summed normals; a closed round face sums to little).
      const dot = a.normal[0]! * b.normal[0]! + a.normal[1]! * b.normal[1]! + a.normal[2]! * b.normal[2]!;
      const len = Math.hypot(...b.normal) * Math.hypot(...a.normal);
      if (len > 1e-6 * b.area * b.area && Math.hypot(...b.normal) > 0.2 * b.area && dot < 0.98 * len) problems.push(`${where}: face ${face} looks another way`);
    }
    const aloneEdges = new Map<number, { start: number; count: number }>();
    for (let i = 0; i < alone.edgeRanges.length; i += 3) aloneEdges.set(alone.edgeRanges[i + 2]!, { start: alone.edgeRanges[i]!, count: alone.edgeRanges[i + 1]! });
    for (let i = 0; i < got.edgeRanges.length; i += 3) {
      const edge = got.edgeRanges[i + 2]!;
      const other = aloneEdges.get(edge);
      if (!other) {
        problems.push(`${where}: edge ${edge} is missing alone`);
        continue;
      }
      const range = (start: number, count: number) => Array.from({ length: count }, (_, k) => start + k);
      const a = boxOf(got.edgeLines, range(got.edgeRanges[i]!, got.edgeRanges[i + 1]!));
      const b = boxOf(alone.edgeLines, range(other.start, other.count));
      for (let k = 0; k < 3; k++) if (Math.abs(a.min[k]! - b.min[k]!) > tol || Math.abs(a.max[k]! - b.max[k]!) > tol) problems.push(`${where}: edge ${edge} lies elsewhere`);
    }
  }
  return { copies, problems };
}
