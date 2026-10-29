/**
 * Hole tools: per centre, the hole's profile (bore, counterbore or 90° countersink) turned about
 * its axis into a solid, all centres in one compound to cut in one boolean. Faces are tagged by
 * what they are: `ho1.wall` (the bore), `ho1.counterbore`, `ho1.seat` (the counterbore's floor),
 * `ho1.countersink`, `ho1.bottom` (blind holes).
 */

import { FeatureError, type HoleShape } from "@meercad/model";
import { toWorld, type PlaneFrame, type Vec3 } from "@meercad/sketch";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import type { OC } from "./occt.js";

/** Starts this far above the surface, so the cut does not share the face it starts on. */
const ABOVE = 0.05;

export function holeTools(oc: OC, arena: Arena, id: string, frame: PlaneFrame, points: [number, number][], shape: HoleShape, depth: number, flip: boolean): Body {
  const a: Vec3 = flip ? frame.normal : [-frame.normal[0], -frame.normal[1], -frame.normal[2]];
  const r = shape.diameter / 2;
  if (!(r > 0)) throw new FeatureError("the hole's diameter must be greater than zero");
  if (!(depth > 0)) throw new FeatureError("the hole's depth must be greater than zero");
  // Profile (radius, depth into the material), closed along the axis.
  const prof: [number, number][] = [[0, -ABOVE]];
  let top = 0;
  if (shape.counterbore) {
    const R = shape.counterbore.diameter / 2;
    if (R <= r) throw new FeatureError("the counterbore must be wider than the hole");
    if (shape.counterbore.depth >= depth) throw new FeatureError("the counterbore is deeper than the hole");
    prof.push([R, -ABOVE], [R, shape.counterbore.depth], [r, shape.counterbore.depth]);
    top = shape.counterbore.depth;
  } else if (shape.countersink) {
    const R = shape.countersink.diameter / 2;
    if (R <= r) throw new FeatureError("the countersink must be wider than the hole");
    // 90°: the cone narrows by as much as it goes down.
    prof.push([R + ABOVE, -ABOVE], [r, R - r]);
    top = R - r;
    if (top >= depth) throw new FeatureError("the countersink is deeper than the hole");
  } else prof.push([r, -ABOVE]);
  prof.push([r, depth], [0, depth]);

  const builder = arena.track(new oc.TopoDS_Builder());
  const compound = arena.track(new oc.TopoDS_Compound());
  builder.MakeCompound(compound);
  for (const [u, v] of points) {
    const c = toWorld(frame, [u, v]);
    const at = ([rad, t]: [number, number]): Vec3 => [c[0] + a[0] * t + frame.u[0] * rad, c[1] + a[1] * t + frame.u[1] * rad, c[2] + a[2] * t + frame.u[2] * rad];
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const vs = prof.map((p) => arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(arena.track(new oc.gp_Pnt(...at(p))))).Vertex()));
    vs.forEach((v0, i) => mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v0, vs[(i + 1) % vs.length]!)).Edge())));
    const face = arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(mw.Wire()), true)).Face());
    const axis = arena.track(new oc.gp_Ax1(arena.track(new oc.gp_Pnt(...c)), arena.track(new oc.gp_Dir(...a))));
    const rev = arena.track(new oc.BRepPrimAPI_MakeRevol(face, axis, 2 * Math.PI, false));
    if (!rev.IsDone()) throw new FeatureError("could not build the hole");
    builder.Add(compound, arena.track(rev.Shape()) as TopoDS_Shape);
  }
  const body = new Body(oc, arena, id, compound);
  // Tags by geometry: radius for round faces, depth for flat ones.
  body.faceTags = body.faces.map((f, i) => {
    const s = arena.track(new oc.BRepAdaptor_Surface(f, true));
    const type = s.GetType();
    const name = (part: string) => [`${id}.${part}`];
    if (type === "GeomAbs_Cylinder") return name(Math.abs(arena.track(s.Cylinder()).Radius() - r) < 1e-6 ? "wall" : "counterbore");
    if (type === "GeomAbs_Cone") return name("countersink");
    const p = body.facePoints[i]!;
    // Depth of a flat face below the surface, measured from the nearest centre.
    const t = Math.min(...points.map(([u, v]) => {
      const c = toWorld(frame, [u, v]);
      return (p[0] - c[0]) * a[0] + (p[1] - c[1]) * a[1] + (p[2] - c[2]) * a[2];
    }));
    if (Math.abs(t - depth) < 1e-6) return name("bottom");
    if (top > 0 && Math.abs(t - top) < 1e-6) return name("seat");
    return name("top");
  });
  return body;
}
