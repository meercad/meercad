/**
 * Persistent references (§5.4). Kernel-independent: the kernel describes a body's topology as
 * face tags + edge/face adjacency, this package resolves selectors against it and propagates tags
 * through modelling history.
 */

import type { EdgeSelector, FaceSelector } from "@meercad/schema";

export interface FaceInfo {
  planar: boolean;
  /** Outward unit normal for planar faces. */
  normal: [number, number, number] | null;
  area: number;
}

export interface Topology {
  readonly bodyId: string;
  /** Tags per face index. The first tag is the face's primary name. */
  readonly faceTags: readonly (readonly string[])[];
  /** Adjacent face indices per edge index (2 for manifold solid edges). */
  readonly edgeFaces: readonly (readonly number[])[];
  readonly faceInfo?: readonly FaceInfo[];
  /** A representative point per edge / face (for `near` disambiguation). */
  readonly edgePoints?: readonly Vec3[];
  readonly facePoints?: readonly Vec3[];
}

type Vec3 = [number, number, number];

/** A pattern ending in this matches every tag that starts with the part before it. */
const WILDCARD = "[*]";
const AREA_TOLERANCE = 1e-6;
const NORMAL_TOLERANCE = 1e-6;

const squaredDistance = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const isWildcard = (pattern: string) => pattern.endsWith(WILDCARD);

export class ResolveError extends Error {}

export function tagMatches(pattern: string, tag: string): boolean {
  return isWildcard(pattern) ? tag.startsWith(pattern.slice(0, -WILDCARD.length)) : tag === pattern;
}

function facesMatching(topology: Topology, pattern: string): number[] {
  const faces: number[] = [];

  topology.faceTags.forEach((tags, face) => {
    if (tags.some((tag) => tagMatches(pattern, tag))) faces.push(face);
  });

  return faces;
}

export interface EdgeRef {
  body: string;
  edges: number[];
}

interface EdgeHit {
  body: string;
  edge: number;
  /** Squared distance to the selector's `near` point; 0 without one. */
  distance: number;
}

/** Every edge that lies between a face matching `tagA` and a face matching `tagB`. */
function edgesBetweenFaces(
  [tagA, tagB]: readonly [string, string],
  near: Vec3 | undefined,
  bodies: readonly Topology[],
): EdgeHit[] {
  const hits: EdgeHit[] = [];

  for (const topology of bodies) {
    const facesA = new Set(facesMatching(topology, tagA));
    const facesB = new Set(facesMatching(topology, tagB));

    topology.edgeFaces.forEach((faces, edge) => {
      const touchesBoth = faces.some((face) => facesA.has(face)) && faces.some((face) => facesB.has(face));

      if (touchesBoth && new Set(faces).size > 1) {
        const point = topology.edgePoints?.[edge];
        const distance = near && point ? squaredDistance(point, near) : 0;

        hits.push({ body: topology.bodyId, edge, distance });
      }
    });
  }

  return hits;
}

/**
 * The edges an "edge between two faces" selector means: all of them for a wildcard, otherwise exactly one.
 */
function resolveEdgeBetweenFaces(
  selector: Extract<EdgeSelector, { edge: unknown }>,
  bodies: readonly Topology[],
): EdgeHit[] {
  const [tagA, tagB] = selector.edge;
  const hits = edgesBetweenFaces(selector.edge, selector.near, bodies);

  if (hits.length === 0) {
    throw new ResolveError(`no edge between faces "${tagA}" and "${tagB}" (was one of them removed?)`);
  }

  const wildcard = isWildcard(tagA) || isWildcard(tagB);

  if (hits.length === 1 || wildcard) return hits;

  if (!selector.near) {
    throw new ResolveError(`edge between "${tagA}" and "${tagB}" is ambiguous (${hits.length} edges match)`);
  }

  const nearest = hits.reduce((best, hit) => (hit.distance < best.distance ? hit : best));

  return [nearest];
}

/** Every edge of the faces matching `pattern`; an edge is listed once per body. */
function resolveEdgesOfFaces(pattern: string, bodies: readonly Topology[]): EdgeHit[] {
  const hits: EdgeHit[] = [];

  for (const topology of bodies) {
    const faces = new Set(facesMatching(topology, pattern));

    topology.edgeFaces.forEach((adjacent, edge) => {
      if (adjacent.some((face) => faces.has(face))) hits.push({ body: topology.bodyId, edge, distance: 0 });
    });
  }

  if (hits.length === 0) throw new ResolveError(`no edges on faces matching "${pattern}"`);

  return hits;
}

/** Resolves edge selectors to edges of exactly one body. Never guesses: no or ambiguous match is an error. */
export function resolveEdges(selectors: readonly EdgeSelector[], bodies: readonly Topology[]): EdgeRef {
  const edgesByBody = new Map<string, Set<number>>();

  for (const selector of selectors) {
    const hits =
      "edge" in selector
        ? resolveEdgeBetweenFaces(selector, bodies)
        : resolveEdgesOfFaces(faceSelectorTag(selector.of, selector.where?.face), bodies);

    for (const hit of hits) {
      const edges = edgesByBody.get(hit.body) ?? new Set<number>();

      edges.add(hit.edge);
      edgesByBody.set(hit.body, edges);
    }
  }

  if (edgesByBody.size > 1) {
    throw new ResolveError(`selected edges span several bodies (${[...edgesByBody.keys()].join(", ")})`);
  }

  const [entry] = edgesByBody;

  if (!entry) throw new ResolveError("no edges selected");

  const [body, edges] = entry;

  return { body, edges: [...edges].sort((x, y) => x - y) };
}

function faceSelectorTag(of: string | undefined, face: string | undefined): string {
  if (face === undefined) {
    if (of === undefined) throw new ResolveError("edge selector needs `of` or `where.face`");

    return `${of}.${WILDCARD}`;
  }

  return face.includes(".") || of === undefined ? face : `${of}.${face}`;
}

const DIRECTIONS: Record<string, Vec3> = {
  "+X": [1, 0, 0],
  "-X": [-1, 0, 0],
  "+Y": [0, 1, 0],
  "-Y": [0, -1, 0],
  "+Z": [0, 0, 1],
  "-Z": [0, 0, -1],
};

export interface FaceRef {
  body: string;
  faces: number[];
}

export function resolveFaces(selector: FaceSelector, bodies: readonly Topology[]): FaceRef[] {
  return "face" in selector
    ? resolveFacesByTag(selector, bodies)
    : resolveFacesByProperties(selector, bodies);
}

/** The faces carrying the selector's tag; with `near` and several matches, only the nearest one. */
function resolveFacesByTag(
  selector: Extract<FaceSelector, { face: unknown }>,
  bodies: readonly Topology[],
): FaceRef[] {
  const refs: FaceRef[] = [];

  for (const topology of bodies) {
    const faces = facesMatching(topology, selector.face);

    if (faces.length) refs.push({ body: topology.bodyId, faces });
  }

  if (!refs.length) throw new ResolveError(`no face tagged "${selector.face}"`);

  const near = selector.near;
  const matchCount = refs.reduce((count, ref) => count + ref.faces.length, 0);

  if (!near || matchCount <= 1) return refs;

  let nearest: { body: string; face: number; distance: number } | null = null;

  for (const ref of refs) {
    const topology = bodies.find((candidate) => candidate.bodyId === ref.body)!;

    for (const face of ref.faces) {
      const point = topology.facePoints?.[face];
      const distance = point ? squaredDistance(point, near) : Infinity;

      if (!nearest || distance < nearest.distance) nearest = { body: ref.body, face, distance };
    }
  }

  return [{ body: nearest!.body, faces: [nearest!.face] }];
}

interface FaceCandidate {
  body: string;
  face: number;
  area: number;
}

/** The faces that fit the selector's tag pattern, planarity and normal; `pick` narrows them to one. */
function resolveFacesByProperties(
  selector: Exclude<FaceSelector, { face: unknown }>,
  bodies: readonly Topology[],
): FaceRef[] {
  const where = selector.where;
  const pattern = where?.tag ?? (selector.of !== undefined ? `${selector.of}.${WILDCARD}` : undefined);
  const candidates: FaceCandidate[] = [];

  for (const topology of bodies) {
    topology.faceTags.forEach((tags, face) => {
      if (pattern && !tags.some((tag) => tagMatches(pattern, tag))) return;

      const info = topology.faceInfo?.[face];

      if (where?.planar !== undefined && info?.planar !== where.planar) return;

      if (where?.normal) {
        const wanted = DIRECTIONS[where.normal]!;
        const normal = info?.normal;

        if (!normal || dot(normal, wanted) < 1 - NORMAL_TOLERANCE) return;
      }

      candidates.push({ body: topology.bodyId, face, area: info?.area ?? 0 });
    });
  }

  if (!candidates.length) throw new ResolveError("no face matches the selector");

  const picked = selector.pick ? [pickByArea(candidates, selector.pick)] : candidates;
  const refs: FaceRef[] = [];

  for (const candidate of picked) {
    let ref = refs.find((existing) => existing.body === candidate.body);

    if (!ref) {
      ref = { body: candidate.body, faces: [] };
      refs.push(ref);
    }

    ref.faces.push(candidate.face);
  }

  return refs;
}

/** The single largest or smallest face; two faces of equal area are an error, not a guess. */
function pickByArea(candidates: readonly FaceCandidate[], pick: "largest" | "smallest"): FaceCandidate {
  const isBetter = (candidate: FaceCandidate, best: FaceCandidate) =>
    pick === "largest" ? candidate.area > best.area : candidate.area < best.area;

  const best = candidates.reduce((current, candidate) =>
    isBetter(candidate, current) ? candidate : current,
  );
  const tolerance = AREA_TOLERANCE * Math.max(1, best.area);
  const ties = candidates.filter((candidate) => Math.abs(candidate.area - best.area) <= tolerance);

  if (ties.length > 1) {
    throw new ResolveError(`"${pick}" face is ambiguous (${ties.length} faces with equal area)`);
  }

  return best;
}

/** Coordinates as they are written into a selector: rounded to a thousandth of a millimetre. */
const roundPoint = (point: Vec3) => point.map((value) => Math.round(value * 1000) / 1000) as Vec3;

/** Stable, order-independent selector for an edge given its adjacent faces' tags. */
export function edgeSelectorFor(
  tagsA: readonly string[],
  tagsB: readonly string[],
  near?: Vec3,
): EdgeSelector | null {
  const primaryA = tagsA[0];
  const primaryB = tagsB[0];

  if (!primaryA || !primaryB || primaryA === primaryB) return null;

  const edge: [string, string] = primaryA < primaryB ? [primaryA, primaryB] : [primaryB, primaryA];

  return { edge, ...(near ? { near } : {}) };
}

/** Selector for edge `edge` of a body; adds `near` only when the face pair alone is ambiguous. */
export function selectorForEdge(topology: Topology, edge: number, point?: Vec3): EdgeSelector | null {
  const [faceA, faceB] = topology.edgeFaces[edge] ?? [];

  if (faceA === undefined || faceB === undefined) return null;

  const selector = edgeSelectorFor(topology.faceTags[faceA] ?? [], topology.faceTags[faceB] ?? []);

  if (!selector || !("edge" in selector)) return null;

  try {
    resolveEdges([selector], [topology]);

    return selector;
  } catch {
    const near = point ?? topology.edgePoints?.[edge];

    return near ? { ...selector, near: roundPoint(near) } : null;
  }
}

/** Selector for face `face`; adds `near` only when its primary tag is shared. */
export function selectorForFace(topology: Topology, face: number, point?: Vec3): FaceSelector | null {
  const tag = topology.faceTags[face]?.[0];

  if (!tag) return null;

  const shared = topology.faceTags.filter((tags) => tags.includes(tag)).length > 1;
  const near = point ?? topology.facePoints?.[face];

  return shared && near ? { face: tag, near: roundPoint(near) } : { face: tag };
}

export interface FaceHistory {
  /** For each input face: indices of the output faces it became; [] when deleted. */
  descendants: readonly (readonly number[])[];
  /** Output faces created by the operation, with the tag to give them. */
  generated: readonly { face: number; tag: string }[];
}

/**
 * Carries tags from input faces to output faces. Faces that receive no tag get
 * `${fallbackPrefix}.face[i]` and are reported so the caller can warn.
 */
export function propagateTags(
  inputTags: readonly (readonly string[])[],
  outputFaceCount: number,
  history: FaceHistory,
  fallbackPrefix: string,
): { tags: string[][]; untagged: number[] } {
  const tags: string[][] = Array.from({ length: outputFaceCount }, () => []);

  const addTag = (face: number, tag: string) => {
    const list = tags[face];

    if (list && !list.includes(tag)) list.push(tag);
  };

  history.descendants.forEach((outputFaces, inputFace) => {
    for (const outputFace of outputFaces) {
      for (const tag of inputTags[inputFace] ?? []) addTag(outputFace, tag);
    }
  });

  for (const generated of history.generated) addTag(generated.face, generated.tag);

  const untagged: number[] = [];

  tags.forEach((list, face) => {
    if (!list.length) {
      list.push(`${fallbackPrefix}.face[${face}]`);
      untagged.push(face);
    }
  });

  return { tags, untagged };
}
