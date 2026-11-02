/**
 * Mesh sections in the sketch: where the sketch plane cuts the imported meshes, shown as a guide,
 * and traced on request into ordinary lines, arcs and circles that can be dimensioned and extruded.
 */
import { fitSection, sectionMesh, type SectionChain, type SectionFrame, type SectionPiece } from "@meercad/kernel/fit";
import type { Feature, SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import type { Vec2 } from "@meercad/sketch";
import { meshBodyIds } from "../lib/meshParts";
import { freshId } from "./actions";

type Draft = Pick<SketchFeature, "entities" | "constraints">;
type NewEntity = SketchEntity extends infer E ? (E extends unknown ? Omit<E, "id"> : never) : never;
type NewConstraint = SketchConstraint extends infer C ? (C extends unknown ? Omit<C, "id"> : never) : never;

/** Where the plane cuts the mesh parts (hidden ones too: the mesh is the reference while it is rebuilt). */
export function meshSections(features: readonly Feature[], meshes: readonly { bodyId: string; positions: Float32Array; indices: Uint32Array; faceTags: string[][] }[], frame: SectionFrame): SectionChain[] {
  const ids = meshBodyIds(features, meshes);
  const plane = [...frame.origin, ...frame.u, ...frame.v].join();
  return meshes
    .filter((m) => ids.has(m.bodyId))
    .flatMap((m) => {
      // Every sketch edit rebuilds the model and hands over fresh (but equal) meshes; a scan has
      // hundreds of thousands of triangles, so cut each mesh at each plane once.
      const n = m.positions.length;
      const key = `${m.bodyId}|${n}|${m.positions[0]},${m.positions[n >> 1]},${m.positions[n - 1]}|${plane}`;
      let chains = cache.get(key);
      if (!chains) {
        chains = sectionMesh(m.positions, m.indices, frame);
        if (cache.size > 20) cache.clear();
        cache.set(key, chains);
      }
      return chains;
    });
}

const cache = new Map<string, SectionChain[]>();

/** Closest chain within `within` of p, with its index. */
export function chainAt(chains: SectionChain[], p: Vec2, within: number): number {
  let best = -1;
  let bd = within;
  chains.forEach((c, i) => {
    const pts = c.closed ? [...c.points, c.points[0]!] : c.points;
    for (let k = 0; k + 1 < pts.length; k++) {
      const d = segmentDistance(pts[k]!, pts[k + 1]!, p);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  });
  return best;
}

/**
 * The chains as sketch geometry: lines, arcs and circles joined end to end, lines within half a
 * degree of the axes held horizontal or vertical, and smooth joints held tangent. Returns the new
 * draft and how many curves were added.
 */
export function traceSections(base: Draft, chains: SectionChain[], tol: number, construction: boolean): { draft: Draft; curves: number } {
  const d: Draft = { entities: [...base.entities], constraints: [...base.constraints] };
  const taken = new Set<string>();
  const cons = construction ? { construction: true } : {};
  const point = (q: Vec2): string => {
    const id = freshId(d, "p", taken);
    d.entities.push({ id, type: "point", x: q[0], y: q[1] });
    return id;
  };
  const entity = (e: NewEntity, prefix: string): string => {
    const id = freshId(d, prefix, taken);
    d.entities.push({ ...e, id } as SketchEntity);
    return id;
  };
  const constraint = (c: NewConstraint) => d.constraints.push({ ...c, id: freshId(d, "c", taken) } as SketchConstraint);
  let curves = 0;
  for (const chain of chains) {
    const pieces = fitSection(chain, tol);
    if (!pieces.length) continue;
    const first = pieces[0]!;
    if (first.kind === "circle") {
      entity({ type: "circle", center: point(first.center), radius: first.radius, ...cons }, "c");
      curves++;
      continue;
    }
    const ends = pieces as Exclude<SectionPiece, { kind: "circle" }>[];
    const lastEnd = ends[ends.length - 1]!.b;
    const closed = ends.length > 1 && Math.hypot(lastEnd[0] - ends[0]!.a[0], lastEnd[1] - ends[0]!.a[1]) < 1e-9;
    const verts = ends.map((pc) => point(pc.a));
    verts.push(closed ? verts[0]! : point(lastEnd));
    const ids = ends.map((pc, k) => {
      if (pc.kind === "line") {
        const id = entity({ type: "line", p1: verts[k]!, p2: verts[k + 1]!, ...cons }, "l");
        const ang = Math.abs(Math.atan2(pc.b[1] - pc.a[1], pc.b[0] - pc.a[0]));
        const half = (0.5 * Math.PI) / 180;
        if (ang < half || Math.abs(ang - Math.PI) < half) constraint({ type: "horizontal", line: id });
        else if (Math.abs(ang - Math.PI / 2) < half) constraint({ type: "vertical", line: id });
        return id;
      }
      const [start, end] = pc.ccw ? [verts[k]!, verts[k + 1]!] : [verts[k + 1]!, verts[k]!];
      return entity({ type: "arc", center: point(pc.center), start, end, ...cons }, "a");
    });
    curves += ids.length;
    for (let k = 0; k + 1 < ends.length || (closed && k < ends.length); k++) {
      const [a, b] = [ends[k]!, ends[(k + 1) % ends.length]!];
      if (a.kind === "line" && b.kind === "line") continue;
      const [da, db] = [direction(a, a.b), direction(b, b.a)];
      if (da[0] * db[0] + da[1] * db[1] > Math.cos((2 * Math.PI) / 180)) constraint({ type: "tangent", a: ids[k]!, b: ids[(k + 1) % ends.length]! });
    }
  }
  return { draft: d, curves };
}

/** Unit direction of travel along a piece (from `a` to `b`) at a point on it. */
function direction(pc: Exclude<SectionPiece, { kind: "circle" }>, at: Vec2): Vec2 {
  if (pc.kind === "line") {
    const l = Math.hypot(pc.b[0] - pc.a[0], pc.b[1] - pc.a[1]) || 1;
    return [(pc.b[0] - pc.a[0]) / l, (pc.b[1] - pc.a[1]) / l];
  }
  const r = Math.hypot(at[0] - pc.center[0], at[1] - pc.center[1]) || 1;
  const [rx, ry] = [(at[0] - pc.center[0]) / r, (at[1] - pc.center[1]) / r];
  return pc.ccw ? [-ry, rx] : [ry, -rx];
}

function segmentDistance(a: Vec2, b: Vec2, p: Vec2): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}
