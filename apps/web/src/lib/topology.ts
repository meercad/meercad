/** Viewport picks → persistent selectors, and human-readable selector summaries. */
import { t } from "./i18n";
import type { BodyMesh } from "@meercad/kernel";
import { selectorForEdge, selectorForFace, type Topology } from "@meercad/naming";
import type { AxisRef, EdgeSelector, FaceSelector, PlaneSpec } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";

type Vec3 = [number, number, number];

const cache = new WeakMap<BodyMesh, Topology>();

/** Topology of a tessellated body, with sample points computed from the mesh. */
export function meshTopology(mesh: BodyMesh): Topology {
  let topology = cache.get(mesh);
  if (topology) return topology;

  const edgePoints: Vec3[] = mesh.edgeFaces.map(() => [0, 0, 0]);

  for (let g = 0; g < mesh.edgeRanges.length; g += 3) {
    const [start, count, e] = [mesh.edgeRanges[g]!, mesh.edgeRanges[g + 1]!, mesh.edgeRanges[g + 2]!];
    if (e < 0 || count < 1) continue;

    const a = (start + Math.floor((count - 1) / 2)) * 3;
    const b = (start + Math.ceil((count - 1) / 2)) * 3;
    edgePoints[e] = [0, 1, 2].map((k) => (mesh.edgeLines[a + k]! + mesh.edgeLines[b + k]!) / 2) as Vec3;
  }

  const facePoints: Vec3[] = mesh.faceTags.map(() => [0, 0, 0]);

  for (let g = 0; g < mesh.faceRanges.length; g += 3) {
    const [start, , f] = [mesh.faceRanges[g]!, mesh.faceRanges[g + 1]!, mesh.faceRanges[g + 2]!];
    if (f < 0) continue;

    const [a, b, c] = [mesh.indices[start]! * 3, mesh.indices[start + 1]! * 3, mesh.indices[start + 2]! * 3];
    facePoints[f] = [0, 1, 2].map(
      (k) => (mesh.positions[a + k]! + mesh.positions[b + k]! + mesh.positions[c + k]!) / 3,
    ) as Vec3;
  }

  topology = {
    bodyId: mesh.bodyId,
    faceTags: mesh.faceTags,
    edgeFaces: mesh.edgeFaces,
    edgePoints,
    facePoints,
  };
  cache.set(mesh, topology);

  return topology;
}

export function edgeSelectorForPick(pick: Pick, meshes: readonly BodyMesh[]): EdgeSelector | null {
  if (pick.kind === "edge") {
    const mesh = meshes.find((x) => x.bodyId === pick.bodyId);

    return mesh ? selectorForEdge(meshTopology(mesh), pick.edge) : null;
  }

  if (pick.kind === "face") {
    const tag = pick.tags[0];

    return tag ? { select: "edges", where: { face: tag } } : null;
  }

  return null;
}

export function faceSelectorForPick(pick: Pick, meshes: readonly BodyMesh[]): FaceSelector | null {
  if (pick.kind !== "face") return null;

  const mesh = meshes.find((x) => x.bodyId === pick.bodyId);

  return mesh ? selectorForFace(meshTopology(mesh), pick.face) : null;
}

export function planeSpecForPick(pick: Pick, meshes: readonly BodyMesh[]): PlaneSpec | null {
  if (pick.kind === "plane") return { ref: pick.planeId };

  if (pick.kind === "face" && pick.normal) {
    const selector = faceSelectorForPick(pick, meshes);

    return selector ? { face: selector } : null;
  }

  return null;
}

export function axisForPick(pick: Pick, meshes: readonly BodyMesh[]): AxisRef | null {
  if (pick.kind === "sketch_curve") return { line: `${pick.sketchId}.${pick.curveId}` };

  if (pick.kind === "edge") {
    const selector = edgeSelectorForPick(pick, meshes);

    return selector ? { edge: selector } : null;
  }

  return null;
}

let featureLabel: (id: string) => string = (id) => id;

/** Where feature names come from (set once by the store), so chips read "Extrude 1", not "ex1". */
export function setFeatureLabels(fn: (id: string) => string): void {
  featureLabel = fn;
}

const KIND: Record<string, string> = {
  end_cap: t("end face"),
  start_cap: t("start face"),
  side: t("side"),
  // Generators (boxes, lids, snap hooks, bins).
  wall: t("face::wall"),
  inner: t("face::inside"),
  floor: t("face::floor"),
  bottom: t("face::bottom"),
  rim: t("face::rim"),
  groove: t("face::groove"),
  notch: t("face::notch"),
  shoulder: t("face::shoulder"),
  neck: t("face::neck"),
  thread: t("face::thread"),
  lid_top: t("face::lid top"),
  lid_under: t("face::lid underside"),
  lid_side: t("face::lid side"),
  lid_lip: t("face::lid lip"),
  lid_bead: t("face::lid bead"),
  lid_rim: t("face::lid edge"),
  lid_inner: t("face::lid inside"),
  lid_thread: t("face::lid thread"),
  beam: t("face::beam"),
  back: t("face::back"),
  catch: t("face::catch"),
  lead: t("face::lead-in"),
  tip: t("face::tip"),
  window: t("face::window"),
};

/**
 * A face tag in words: "ex1.end_cap" → "Extrude 1 · end face", "ex1.side[sk1.l2]" → "Extrude 1 · side l2".
 */
function short(tag: string): string {
  const match = /^([^.[]+)\.([^[]+)(?:\[(.*)\])?$/.exec(tag);
  if (!match) return tag;

  const [, fid, kind, ref] = match;
  const what = KIND[kind!] ?? kind!.replace(/_/g, " ");

  return `${featureLabel(fid!)} · ${what}${ref ? ` ${ref.split(".").pop()}` : ""}`;
}

export function describeEdgeSelector(selector: EdgeSelector): string {
  if ("edge" in selector) {
    return t("Edge: {a} / {b}", { a: short(selector.edge[0]), b: short(selector.edge[1]) });
  }

  if (selector.where?.face) return t("Edges of {face}", { face: short(selector.where.face) });

  return t("All edges of {feature}", { feature: selector.of ? featureLabel(selector.of) : "?" });
}

export function describeFaceSelector(selector: FaceSelector): string {
  if ("face" in selector) return short(selector.face);

  return `${t("Faces")} ${selector.where?.normal ?? ""} ${selector.pick ?? ""}`.trim();
}

export function describePlane(plane: PlaneSpec): string {
  if ("ref" in plane) {
    return plane.ref.startsWith("origin.")
      ? t("{plane} plane", { plane: PLANE_LABELS[plane.ref] ?? plane.ref })
      : featureLabel(plane.ref);
  }

  return describeFaceSelector(plane.face);
}

export function describeAxis(a: AxisRef): string {
  if ("ref" in a) return t("{axis} axis", { axis: a.ref.slice(7) });

  if ("line" in a) {
    const [sk, line] = a.line.split(".");

    return t("{sketch} · line {line}", { sketch: featureLabel(sk!), line: line ?? "" }).trim();
  }

  return describeEdgeSelector(a.edge);
}

export const PLANE_LABELS: Record<string, string> = {
  "origin.XY": t("plane::Top"),
  "origin.XZ": t("plane::Front"),
  "origin.YZ": t("plane::Right"),
};
