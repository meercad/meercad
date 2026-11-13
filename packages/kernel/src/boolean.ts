/**
 * Booleans that carry face tags: OCCT history for the boolean itself, then a geometric match
 * through UnifySameDomain (which merges coplanar faces but exposes no history in this build).
 */

import { propagateTags } from "@meercad/naming";
import { FeatureError } from "@meercad/model";
import type { TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import { Arena } from "./arena.js";
import { Body, listToArray } from "./body.js";
import type { OC } from "./occt.js";

export type BoolOp = "fuse" | "cut" | "common";

/** `target` combined with one tool, or with several in one OCCT call (e.g. all copies of a pattern). */
export function booleanBodies(
  oc: OC,
  arena: Arena,
  target: Body,
  tool: Body | readonly Body[],
  op: BoolOp,
  resultId = target.bodyId,
  fuzzy = 0,
): Body {
  const tools = Array.isArray(tool) ? tool : [tool as Body];
  const Algo =
    op === "fuse" ? oc.BRepAlgoAPI_Fuse : op === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
  let algo: InstanceType<typeof Algo>;

  if (tools.length === 1 && !fuzzy) {
    algo = arena.track(new Algo(target.shape, tools[0]!.shape));
  } else {
    algo = arena.track(new Algo());

    const list = (shapes: TopoDS_Shape[]) => {
      const l = arena.track(new oc.NCollection_List_TopoDS_Shape());
      for (const shape of shapes) l.Append(shape);

      return l;
    };

    algo.SetArguments(list([target.shape]));
    algo.SetTools(list(tools.map((t) => t.shape)));
    // A fuzzy boolean treats nearly touching geometry as touching (threads whose groove grazes a seam).
    if (fuzzy) algo.SetFuzzyValue(fuzzy);

    algo.Build(arena.track(new oc.Message_ProgressRange()));
  }

  if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError(`boolean ${op} failed`);

  const raw = arena.track(algo.Shape());

  if (isEmpty(oc, arena, raw)) {
    throw new FeatureError(op === "common" ? "the bodies do not overlap" : `boolean ${op} produced no solid`);
  }

  const pre = new Body(oc, arena, resultId, raw);

  // A cut that takes nothing away (the tool only reaches into the part's box) leaves the part as
  // it is, the very same object: steps after it that read the part need not be run again.
  if (
    op === "cut" &&
    resultId === target.bodyId &&
    pre.faces.length === target.faces.length &&
    target.faces.every((face) => !algo.IsDeleted(face) && !listToArray(arena, algo.Modified(face)).length)
  ) {
    return target;
  }

  const descend = (b: Body) =>
    b.faces.map((face) => {
      if (algo.IsDeleted(face)) return [];

      const mod = listToArray(arena, algo.Modified(face))
        .map((shape) => pre.faceIndex(shape))
        .filter((i) => i >= 0);
      if (mod.length) return mod;

      const same = pre.faceIndex(face);

      return same >= 0 ? [same] : [];
    });
  const inputs = [target, ...tools];
  const { tags } = propagateTags(
    inputs.flatMap((b) => b.faceTags),
    pre.faces.length,
    { descendants: inputs.flatMap(descend), generated: [] },
    `${resultId}.face`,
  );
  pre.faceTags = tags;

  return unify(oc, arena, pre);
}

/** Merges same-domain faces/edges and re-derives tags geometrically. */
export function unify(oc: OC, arena: Arena, body: Body): Body {
  const u = arena.track(new oc.ShapeUpgrade_UnifySameDomain(body.shape, true, true, false));
  u.Build();

  const shape = arena.track(u.Shape());
  const out = new Body(oc, arena, body.bodyId, shape);

  if (out.faces.length === body.faces.length && out.faces.every((face) => body.faceIndex(face) >= 0)) {
    out.faceTags = out.faces.map((face) => [...(body.faceTags[body.faceIndex(face)] ?? [])]);

    return out;
  }

  const samples = body.facePoints;
  const sameIdx = out.faces.map((face) => body.faceIndex(face));
  const matched = new Set(sameIdx.filter((i) => i >= 0));
  const open = body.faces.map((_, i) => i).filter((i) => !matched.has(i));
  // Only points inside a merged face's box can lie on it: the exact test (slow, and its objects
  // live until the feature ends) then runs a few times per face instead of for every pair.
  const near = (p: [number, number, number], b: ReturnType<typeof bounds>) =>
    p.every((v, a) => v >= b.min[a]! - 1e-3 && v <= b.max[a]! + 1e-3);
  out.faceTags = out.faces.map((face, k) => {
    const same = sameIdx[k]!;
    if (same >= 0) return [...(body.faceTags[same] ?? [])];

    const box = bounds(oc, arena, face);
    // Samples lie on the faces' mesh triangles: on a curved face up to the mesh deflection (0.1 mm) off it.
    const flat = String(arena.track(new oc.BRepAdaptor_Surface(face, true)).GetType()) === "GeomAbs_Plane";
    const tol = flat ? 1e-4 : 0.11;
    const tags: string[] = [];

    for (const i of open) {
      if (near(samples[i]!, box) && pointOnFace(oc, arena, samples[i]!, face, tol)) {
        for (const t of body.faceTags[i] ?? []) if (!tags.includes(t)) tags.push(t);
      }
    }

    return tags;
  });
  out.faceTags.forEach((t, i) => {
    if (!t.length) t.push(`${body.bodyId}.face[${i}]`);
  });

  return out;
}

export function pointOnFace(
  oc: OC,
  arena: Arena,
  p: [number, number, number],
  face: TopoDS_Face,
  tol = 1e-4,
): boolean {
  const vertex = arena.track(
    arena.track(new oc.BRepBuilderAPI_MakeVertex(arena.track(new oc.gp_Pnt(p[0], p[1], p[2])))).Vertex(),
  );
  const d = arena.track(new oc.BRepExtrema_DistShapeShape(vertex, face));

  return d.IsDone() && d.Value() < tol;
}

function isEmpty(oc: OC, arena: Arena, shape: TopoDS_Shape): boolean {
  const explorer = arena.track(new oc.TopExp_Explorer(shape, "TopAbs_SOLID"));

  return !explorer.More();
}

/** Axis-aligned bounds of a shape. */
export function bounds(
  oc: OC,
  arena: Arena,
  shape: TopoDS_Shape,
): { min: [number, number, number]; max: [number, number, number] } {
  const box = arena.track(new oc.Bnd_Box());
  oc.BRepBndLib.Add(shape, box, false);
  if (box.IsVoid()) return { min: [0, 0, 0], max: [0, 0, 0] };

  const lo = arena.track(box.CornerMin());
  const hi = arena.track(box.CornerMax());

  return { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] };
}

const bodyBoxes = new WeakMap<Body, ReturnType<typeof bounds>>();

/**
 * A part's bounding box, worked out once per part: a part never changes once made, and steps that
 * cut or join wherever their tool reaches look at the boxes of all parts of a big design every time.
 */
export function bodyBounds(oc: OC, body: Body): ReturnType<typeof bounds> {
  let box = bodyBoxes.get(body);

  if (!box) {
    const arena = new Arena();

    try {
      box = bounds(oc, arena, body.shape);
    } finally {
      arena.dispose();
    }

    bodyBoxes.set(body, box);
  }

  return box;
}

export function boundsOverlap(
  a: ReturnType<typeof bounds>,
  b: ReturnType<typeof bounds>,
  eps = 1e-6,
): boolean {
  return [0, 1, 2].every((i) => a.min[i]! <= b.max[i]! + eps && b.min[i]! <= a.max[i]! + eps);
}
