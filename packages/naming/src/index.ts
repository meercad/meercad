/**
 * Persistent references (§5.4). Kernel-independent: the kernel describes a body's topology as
 * face tags + edge/face adjacency, this package resolves selectors against it and propagates tags
 * through modelling history.
 */

import type { EdgeSelector, FaceSelector } from "@opencad/schema";

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
}

export class ResolveError extends Error {}

export function tagMatches(pattern: string, tag: string): boolean {
  return pattern.endsWith("[*]") ? tag.startsWith(pattern.slice(0, -3)) : tag === pattern;
}

function facesMatching(topo: Topology, pattern: string): number[] {
  const out: number[] = [];
  topo.faceTags.forEach((tags, i) => {
    if (tags.some((t) => tagMatches(pattern, t))) out.push(i);
  });
  return out;
}

export interface EdgeRef {
  body: string;
  edges: number[];
}

/** Resolves edge selectors to edges of exactly one body. Never guesses: no or ambiguous match is an error. */
export function resolveEdges(selectors: readonly EdgeSelector[], bodies: readonly Topology[]): EdgeRef {
  const found = new Map<string, Set<number>>();
  const add = (body: string, e: number) => {
    let s = found.get(body);
    if (!s) found.set(body, (s = new Set()));
    s.add(e);
  };

  for (const sel of selectors) {
    let count = 0;
    if ("edge" in sel) {
      const [a, b] = sel.edge;
      for (const topo of bodies) {
        const fa = new Set(facesMatching(topo, a));
        const fb = new Set(facesMatching(topo, b));
        topo.edgeFaces.forEach((faces, e) => {
          const hit = faces.some((x) => fa.has(x)) && faces.some((y) => fb.has(y)) && new Set(faces).size > 1;
          if (hit) {
            add(topo.bodyId, e);
            count++;
          }
        });
      }
      if (count === 0) throw new ResolveError(`no edge between faces "${a}" and "${b}" (was one of them removed?)`);
      if (count > 1 && !a.endsWith("[*]") && !b.endsWith("[*]")) {
        throw new ResolveError(`edge between "${a}" and "${b}" is ambiguous (${count} edges match)`);
      }
    } else {
      const pattern = faceSelectorTag(sel.of, sel.where?.face);
      for (const topo of bodies) {
        const faces = new Set(facesMatching(topo, pattern));
        topo.edgeFaces.forEach((adj, e) => {
          if (adj.some((f) => faces.has(f))) {
            add(topo.bodyId, e);
            count++;
          }
        });
      }
      if (count === 0) throw new ResolveError(`no edges on faces matching "${pattern}"`);
    }
  }

  if (found.size > 1) throw new ResolveError(`selected edges span several bodies (${[...found.keys()].join(", ")})`);
  const [entry] = found;
  if (!entry) throw new ResolveError("no edges selected");
  return { body: entry[0], edges: [...entry[1]].sort((x, y) => x - y) };
}

function faceSelectorTag(of: string | undefined, face: string | undefined): string {
  if (face === undefined) {
    if (of === undefined) throw new ResolveError("edge selector needs `of` or `where.face`");
    return `${of}.[*]`;
  }
  return face.includes(".") || of === undefined ? face : `${of}.${face}`;
}

const DIRS: Record<string, [number, number, number]> = {
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

export function resolveFaces(sel: FaceSelector, bodies: readonly Topology[]): FaceRef[] {
  const out: FaceRef[] = [];
  if ("face" in sel) {
    for (const topo of bodies) {
      const faces = facesMatching(topo, sel.face);
      if (faces.length) out.push({ body: topo.bodyId, faces });
    }
    if (!out.length) throw new ResolveError(`no face tagged "${sel.face}"`);
    return out;
  }
  const pattern = sel.where?.tag ?? (sel.of !== undefined ? `${sel.of}.[*]` : undefined);
  const candidates: { body: string; face: number; area: number }[] = [];
  for (const topo of bodies) {
    topo.faceTags.forEach((tags, i) => {
      if (pattern && !tags.some((t) => tagMatches(pattern, t))) return;
      const info = topo.faceInfo?.[i];
      if (sel.where?.planar !== undefined && info?.planar !== sel.where.planar) return;
      if (sel.where?.normal) {
        const d = DIRS[sel.where.normal]!;
        const n = info?.normal;
        if (!n || n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 1 - 1e-6) return;
      }
      candidates.push({ body: topo.bodyId, face: i, area: info?.area ?? 0 });
    });
  }
  if (!candidates.length) throw new ResolveError("no face matches the selector");
  let picked = candidates;
  if (sel.pick) {
    const best = candidates.reduce((a, b) => ((sel.pick === "largest" ? b.area > a.area : b.area < a.area) ? b : a));
    const ties = candidates.filter((c) => Math.abs(c.area - best.area) <= 1e-6 * Math.max(1, best.area));
    if (ties.length > 1) throw new ResolveError(`"${sel.pick}" face is ambiguous (${ties.length} faces with equal area)`);
    picked = [best];
  }
  for (const c of picked) {
    const ref = out.find((r) => r.body === c.body) ?? (out.push({ body: c.body, faces: [] }), out.at(-1)!);
    ref.faces.push(c.face);
  }
  return out;
}

/** Stable, order-independent selector for an edge given its adjacent faces' tags. */
export function edgeSelectorFor(tagsA: readonly string[], tagsB: readonly string[]): EdgeSelector | null {
  const a = tagsA[0];
  const b = tagsB[0];
  if (!a || !b || a === b) return null;
  return { edge: a < b ? [a, b] : [b, a] };
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
  const push = (i: number, t: string) => {
    const list = tags[i];
    if (list && !list.includes(t)) list.push(t);
  };
  history.descendants.forEach((outs, i) => {
    for (const o of outs) for (const t of inputTags[i] ?? []) push(o, t);
  });
  for (const g of history.generated) push(g.face, g.tag);
  const untagged: number[] = [];
  tags.forEach((list, i) => {
    if (!list.length) {
      list.push(`${fallbackPrefix}.face[${i}]`);
      untagged.push(i);
    }
  });
  return { tags, untagged };
}
