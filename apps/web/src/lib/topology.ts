/** Viewport picks → persistent selectors, and human-readable selector summaries. */
import type { BodyMesh } from "@meercad/kernel";
import { selectorForEdge, selectorForFace, type Topology } from "@meercad/naming";
import type { AxisRef, EdgeSelector, FaceSelector, PlaneSpec } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";

type Vec3 = [number, number, number];
const cache = new WeakMap<BodyMesh, Topology>();

/** Topology of a tessellated body, with sample points computed from the mesh. */
export function meshTopology(m: BodyMesh): Topology {
  let t = cache.get(m);
  if (t) return t;
  const edgePoints: Vec3[] = m.edgeFaces.map(() => [0, 0, 0]);
  for (let g = 0; g < m.edgeRanges.length; g += 3) {
    const [start, count, e] = [m.edgeRanges[g]!, m.edgeRanges[g + 1]!, m.edgeRanges[g + 2]!];
    if (e < 0 || count < 1) continue;
    const a = (start + Math.floor((count - 1) / 2)) * 3;
    const b = (start + Math.ceil((count - 1) / 2)) * 3;
    edgePoints[e] = [0, 1, 2].map((k) => (m.edgeLines[a + k]! + m.edgeLines[b + k]!) / 2) as Vec3;
  }
  const facePoints: Vec3[] = m.faceTags.map(() => [0, 0, 0]);
  for (let g = 0; g < m.faceRanges.length; g += 3) {
    const [start, , f] = [m.faceRanges[g]!, m.faceRanges[g + 1]!, m.faceRanges[g + 2]!];
    if (f < 0) continue;
    const [a, b, c] = [m.indices[start]! * 3, m.indices[start + 1]! * 3, m.indices[start + 2]! * 3];
    facePoints[f] = [0, 1, 2].map((k) => (m.positions[a + k]! + m.positions[b + k]! + m.positions[c + k]!) / 3) as Vec3;
  }
  t = { bodyId: m.bodyId, faceTags: m.faceTags, edgeFaces: m.edgeFaces, edgePoints, facePoints };
  cache.set(m, t);
  return t;
}

export function edgeSelectorForPick(p: Pick, meshes: readonly BodyMesh[]): EdgeSelector | null {
  if (p.kind === "edge") {
    const m = meshes.find((x) => x.bodyId === p.bodyId);
    return m ? selectorForEdge(meshTopology(m), p.edge) : null;
  }
  if (p.kind === "face") {
    const tag = p.tags[0];
    return tag ? { select: "edges", where: { face: tag } } : null;
  }
  return null;
}

export function faceSelectorForPick(p: Pick, meshes: readonly BodyMesh[]): FaceSelector | null {
  if (p.kind !== "face") return null;
  const m = meshes.find((x) => x.bodyId === p.bodyId);
  return m ? selectorForFace(meshTopology(m), p.face) : null;
}

export function planeSpecForPick(p: Pick, meshes: readonly BodyMesh[]): PlaneSpec | null {
  if (p.kind === "plane") return { ref: p.planeId };
  if (p.kind === "face" && p.normal) {
    const f = faceSelectorForPick(p, meshes);
    return f ? { face: f } : null;
  }
  return null;
}

export function axisForPick(p: Pick, meshes: readonly BodyMesh[]): AxisRef | null {
  if (p.kind === "sketch_curve") return { line: `${p.sketchId}.${p.curveId}` };
  if (p.kind === "edge") {
    const e = edgeSelectorForPick(p, meshes);
    return e ? { edge: e } : null;
  }
  return null;
}

let featureLabel: (id: string) => string = (id) => id;
/** Where feature names come from (set once by the store), so chips read "Extrude 1", not "ex1". */
export function setFeatureLabels(fn: (id: string) => string): void {
  featureLabel = fn;
}

const KIND: Record<string, string> = { end_cap: "end face", start_cap: "start face", side: "side" };
/** A face tag in words: "ex1.end_cap" → "Extrude 1 · end face", "ex1.side[sk1.l2]" → "Extrude 1 · side l2". */
function short(tag: string): string {
  const m = /^([^.[]+)\.([^[]+)(?:\[(.*)\])?$/.exec(tag);
  if (!m) return tag;
  const [, fid, kind, ref] = m;
  const what = KIND[kind!] ?? kind!.replace(/_/g, " ");
  return `${featureLabel(fid!)} · ${what}${ref ? ` ${ref.split(".").pop()}` : ""}`;
}

export function describeEdgeSelector(s: EdgeSelector): string {
  if ("edge" in s) return `Edge: ${short(s.edge[0])} / ${short(s.edge[1])}`;
  if (s.where?.face) return `Edges of ${short(s.where.face)}`;
  return `All edges of ${s.of ? featureLabel(s.of) : "?"}`;
}

export function describeFaceSelector(s: FaceSelector): string {
  if ("face" in s) return short(s.face);
  return `Faces ${s.where?.normal ?? ""} ${s.pick ?? ""}`.trim();
}

export function describePlane(p: PlaneSpec): string {
  if ("ref" in p) return p.ref.startsWith("origin.") ? `${PLANE_LABELS[p.ref] ?? p.ref} plane` : featureLabel(p.ref);
  return describeFaceSelector(p.face);
}

export function describeAxis(a: AxisRef): string {
  if ("ref" in a) return `${a.ref.slice(7)} axis`;
  if ("line" in a) {
    const [sk, line] = a.line.split(".");
    return `${featureLabel(sk!)} · line ${line ?? ""}`.trim();
  }
  return describeEdgeSelector(a.edge);
}

export const PLANE_LABELS: Record<string, string> = { "origin.XY": "Top", "origin.XZ": "Front", "origin.YZ": "Right" };
