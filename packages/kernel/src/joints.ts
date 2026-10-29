/**
 * Joint axes after a rebuild: each joint's anchor (a round face, an edge, an origin axis or a gear)
 * becomes an origin and a unit direction in model coordinates, or an error the app shows on the joint.
 */

import { gearDims } from "@meercad/model";
import { resolveEdges, resolveFaces } from "@meercad/naming";
import type { JointAnchor, Mechanism } from "@meercad/schema";
import { toWorld } from "@meercad/sketch";
import { Arena } from "./arena.js";
import { occtErrorMessage, type OC } from "./occt.js";
import type { ModelState } from "./state.js";

type V3 = [number, number, number];

export interface JointFrame {
  id: string;
  origin: V3;
  axis: V3;
  error?: string;
}

/** A gear as the app needs it to add joints: its axis, size and partner. */
export interface GearView {
  id: string;
  kind: "spur" | "internal" | "rack";
  teeth: number;
  /** Pitch radius (racks: NaN). */
  radius: number;
  origin: V3;
  /** Axis (racks: direction along the rack). */
  axis: V3;
  meshWith?: string;
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function gearViews(state: ModelState, meshWith: ReadonlyMap<string, string>): GearView[] {
  return [...state.gears].map(([id, g]): GearView => {
    const o = toWorld(g.frame, g.center);
    const along: V3 = norm([
      g.frame.u[0] * Math.cos(g.rotation) + g.frame.v[0] * Math.sin(g.rotation),
      g.frame.u[1] * Math.cos(g.rotation) + g.frame.v[1] * Math.sin(g.rotation),
      g.frame.u[2] * Math.cos(g.rotation) + g.frame.v[2] * Math.sin(g.rotation),
    ]);
    const z = g.width / 2;
    const n = g.frame.normal;
    const p = g.params;
    return {
      id,
      kind: p.kind,
      teeth: p.teeth,
      radius: p.kind === "rack" ? NaN : gearDims(p).d / 2,
      origin: [o[0] + n[0] * z, o[1] + n[1] * z, o[2] + n[2] * z],
      axis: p.kind === "rack" ? along : n,
      ...(meshWith.get(id) ? { meshWith: meshWith.get(id)! } : {}),
    };
  });
}

export function jointFrames(oc: OC, state: ModelState, mechanism: Mechanism | undefined): JointFrame[] {
  if (!mechanism) return [];
  const arena = new Arena();
  try {
    return mechanism.joints.map((j) => {
      try {
        return { id: j.id, ...anchorFrame(oc, arena, state, j.anchor) };
      } catch (e) {
        return { id: j.id, origin: [0, 0, 0], axis: [0, 0, 1], error: e instanceof Error ? e.message : occtErrorMessage(oc, e) };
      }
    });
  } finally {
    arena.dispose();
  }
}

function anchorFrame(oc: OC, arena: Arena, state: ModelState, anchor: JointAnchor): { origin: V3; axis: V3 } {
  const bodies = [...state.bodies.values()];
  if ("axis" in anchor) {
    const axis: V3 = anchor.axis.ref === "origin.X" ? [1, 0, 0] : anchor.axis.ref === "origin.Y" ? [0, 1, 0] : [0, 0, 1];
    return { origin: [0, 0, 0], axis };
  }
  if ("gear" in anchor) {
    const g = gearViews(state, new Map()).find((x) => x.id === anchor.gear);
    if (!g) throw new Error(`gear "${anchor.gear}" not found`);
    return { origin: g.origin, axis: g.axis };
  }
  if ("axisOf" in anchor) {
    const refs = resolveFaces(anchor.axisOf, bodies);
    if (refs.reduce((n, r) => n + r.faces.length, 0) !== 1) throw new Error("the axis needs exactly one round face");
    const body = state.bodies.get(refs[0]!.body)!;
    const face = body.faces[refs[0]!.faces[0]!]!;
    const surf = arena.track(new oc.BRepAdaptor_Surface(face, true));
    const type = surf.GetType();
    if (type !== "GeomAbs_Cylinder") throw new Error("the face is not round: pick a hole, a shaft or a round edge");
    const pos = arena.track(arena.track(surf.Cylinder()).Position());
    const loc = arena.track(pos.Location());
    const d = arena.track(pos.Direction());
    const o: V3 = [loc.X(), loc.Y(), loc.Z()];
    const axis = norm([d.X(), d.Y(), d.Z()]);
    // Centre the origin on the face along the axis.
    const ts: number[] = [];
    const ex = arena.track(new oc.TopExp_Explorer(face, "TopAbs_VERTEX"));
    for (; ex.More(); ex.Next()) {
      const p = arena.track(oc.BRep_Tool.Pnt(arena.track(oc.TopoDS.Vertex(arena.track(ex.Current())))));
      ts.push(dot([p.X() - o[0], p.Y() - o[1], p.Z() - o[2]], axis));
    }
    const t = ts.length ? (Math.min(...ts) + Math.max(...ts)) / 2 : 0;
    return { origin: [o[0] + axis[0] * t, o[1] + axis[1] * t, o[2] + axis[2] * t], axis };
  }
  const ref = resolveEdges([anchor.edge], bodies);
  if (ref.edges.length !== 1) throw new Error("the axis needs exactly one edge");
  const edge = state.bodies.get(ref.body)!.edges[ref.edges[0]!]!;
  const curve = arena.track(new oc.BRepAdaptor_Curve(edge));
  const type = curve.GetType();
  if (type === "GeomAbs_Circle") {
    const circ = arena.track(curve.Circle());
    const pos = arena.track(circ.Position());
    const loc = arena.track(pos.Location());
    const d = arena.track(pos.Direction());
    return { origin: [loc.X(), loc.Y(), loc.Z()], axis: norm([d.X(), d.Y(), d.Z()]) };
  }
  if (type !== "GeomAbs_Line") throw new Error("the edge must be straight or round");
  const p0 = arena.track(curve.Value(curve.FirstParameter()));
  const p1 = arena.track(curve.Value(curve.LastParameter()));
  const a: V3 = [p0.X(), p0.Y(), p0.Z()];
  const b: V3 = [p1.X(), p1.Y(), p1.Z()];
  return { origin: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], axis: norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) };
}
