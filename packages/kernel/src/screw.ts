/**
 * Screws, threaded rods and nuts of any size and thread form. The blank (head and shank, or the nut
 * with its bore) is built from primitives, threaded like any round face (thread.ts), and finished
 * with a 45° chamfer at the screw's tip or countersinks at the nut's ends.
 * Faces: <id>.head, <id>.shank, <id>.tip (screws), <id>.side, <id>.top, <id>.bottom, <id>.bore (nuts),
 * <id>.thread on the thread itself.
 */

import { FeatureError, grooveShape, threadSpec, type ResolvedScrew } from "@meercad/model";
import { toWorld, type PlaneFrame } from "@meercad/sketch";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { threadFace } from "./thread.js";
import { booleanBodies } from "./boolean.js";
import { occtErrorMessage, type OC } from "./occt.js";

type V = [number, number, number];

/** Hex sizes across flats for metric diameters (ISO 4032 / 4017); other sizes ≈ 1.5·d + 1. */
const HEX_AF: Record<number, number> = {
  1.6: 3.2,
  2: 4,
  2.5: 5,
  3: 5.5,
  4: 7,
  5: 8,
  6: 10,
  8: 13,
  10: 16,
  12: 18,
  14: 21,
  16: 24,
  18: 27,
  20: 30,
  22: 34,
  24: 36,
  27: 41,
  30: 46,
  36: 55,
  42: 65,
  48: 75,
};
/** Hex socket sizes of socket head cap screws (ISO 4762). */
const SOCKET_AF: Record<number, number> = {
  1.6: 1.5,
  2: 1.5,
  2.5: 2,
  3: 2.5,
  4: 3,
  5: 4,
  6: 5,
  8: 6,
  10: 8,
  12: 10,
  14: 12,
  16: 14,
  20: 17,
  24: 19,
  30: 22,
  36: 27,
};

export interface ScrewDims {
  /** Head (screws) or nut: across flats (hex) or diameter (round, knob). */
  across: number;
  /** Head height (screws) or nut height. */
  height: number;
  /** Hex socket across flats (socket and round heads). */
  socket?: number;
}

/** The head's or nut's sizes for a nominal diameter. */
export function screwDims(
  kind: "screw" | "nut",
  head: NonNullable<ResolvedScrew["head"]>,
  d: number,
  length?: number,
): ScrewDims {
  const hex = HEX_AF[d] ?? Math.round((1.5 * d + 1) * 2) / 2;
  const socket = SOCKET_AF[d] ?? Math.max(1.5, Math.round(0.75 * d * 2) / 2);

  if (kind === "nut") {
    const h = length ?? 0.8 * d;

    return head === "knob"
      ? { across: Math.max(3 * d, d + 8), height: h }
      : head === "round"
        ? { across: Math.max(1.15 * hex, d + 3), height: h }
        : { across: hex, height: h };
  }

  switch (head) {
    case "socket":
      return { across: HEX_AF[d] ? 1.5 * d + (d <= 3 ? 1 : 0) : 1.5 * d, height: d, socket };
    case "round":
      return { across: 1.75 * d, height: 0.55 * d, socket: Math.max(1, Math.round(0.6 * d * 2) / 2) };
    case "knob":
      return { across: Math.max(3 * d, d + 8), height: Math.max(0.8 * d, 4) };
    case "none":
      return { across: 0, height: 0 };
    default:
      return { across: hex, height: Math.round(0.65 * d * 10) / 10 };
  }
}

export interface ScrewInfo {
  size: string;
  pitch: number;
  /** Overall length, mm. */
  height: number;
}

export function screwBody(
  oc: OC,
  arena: Arena,
  f: ResolvedScrew,
  frame: PlaneFrame,
  warnings: string[],
): { body: Body; info: ScrewInfo } {
  const d = f.diameter;
  if (!(d > 0.5)) throw new FeatureError("the diameter must be at least 0.5 mm");

  const nut = f.kind === "nut";
  const head = f.head ?? (nut ? "hex" : "hex");

  if (nut && (head === "socket" || head === "none")) {
    throw new FeatureError("nuts are hex, round or knob shaped");
  }

  let spec: ReturnType<typeof threadSpec>;

  try {
    spec = threadSpec(d, nut, { profile: f.profile, diameter: d, pitch: f.pitch, starts: f.starts });
  } catch (e) {
    throw new FeatureError(e instanceof Error ? e.message : String(e));
  }

  const dims = screwDims(f.kind, head, d, nut ? f.length : undefined);
  const L = nut ? dims.height : (f.length ?? 4 * d);

  if (!(L > 0)) {
    throw new FeatureError(
      nut ? "the nut's height must be greater than zero" : "the screw's length must be greater than zero",
    );
  }

  if (L < spec.lead) warnings.push(`shorter than one turn of the thread (${spec.lead} mm)`);

  const R = d / 2;
  const a = frame.normal;
  const c = toWorld(frame, f.center ?? [0, 0]);
  const at = (t: number): V => [c[0] + a[0] * t, c[1] + a[1] * t, c[2] + a[2] * t];
  const pnt = (p: V) => arena.track(new oc.gp_Pnt(...p));
  const ax2 = (t: number) =>
    arena.track(
      new oc.gp_Ax2(pnt(at(t)), arena.track(new oc.gp_Dir(...a)), arena.track(new oc.gp_Dir(...frame.u))),
    );
  const cylinder = (r: number, from: number, to: number): TopoDS_Shape =>
    arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(ax2(from), r, to - from)).Shape());

  // A cone frustum (r1 at `from`, r2 at `to`): its section turned about the axis.
  const cone = (r1: number, r2: number, from: number, to: number): TopoDS_Shape => {
    const pt = (r: number, t: number): V => [0, 1, 2].map((i) => c[i]! + a[i]! * t + frame.u[i]! * r) as V;
    const pts = [pt(0, from), pt(r1, from), pt(r2, to), pt(0, to)];
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const vs = pts.map((p) => arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(pnt(p))).Vertex()));
    vs.forEach((v0, i) =>
      mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v0, vs[(i + 1) % vs.length]!)).Edge())),
    );

    const face = arena.track(
      arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(mw.Wire()), true)).Face(),
    );
    const rev = arena.track(
      new oc.BRepPrimAPI_MakeRevol(
        face,
        arena.track(new oc.gp_Ax1(pnt(c), arena.track(new oc.gp_Dir(...a)))),
        2 * Math.PI,
        false,
      ),
    );
    if (!rev.IsDone()) throw new FeatureError(`could not build the ${nut ? "nut" : "screw"}`);

    return arena.track(rev.Shape());
  };

  const bool = (op: "fuse" | "cut" | "common", x: TopoDS_Shape, y: TopoDS_Shape): TopoDS_Shape => {
    const Algo =
      op === "fuse" ? oc.BRepAlgoAPI_Fuse : op === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
    const algo = arena.track(new Algo(x, y));

    if (!algo.IsDone() || algo.HasErrors()) {
      throw new FeatureError(`could not build the ${nut ? "nut" : "screw"}`);
    }

    return arena.track(algo.Shape());
  };

  const hexPrism = (across: number, from: number, to: number): TopoDS_Shape => {
    const Rh = across / Math.sqrt(3);
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const vs = Array.from({ length: 6 }, (_, k) => {
      const ang = (k * Math.PI) / 3;
      const p = [0, 1, 2].map(
        (i) => at(from)[i]! + Rh * (Math.cos(ang) * frame.u[i]! + Math.sin(ang) * frame.v[i]!),
      ) as V;

      return arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(pnt(p))).Vertex());
    });
    vs.forEach((x, k) =>
      mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(x, vs[(k + 1) % 6]!)).Edge())),
    );

    const face = arena.track(
      arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(mw.Wire()), true)).Face(),
    );
    const h = to - from;

    return arena.track(
      arena
        .track(
          new oc.BRepPrimAPI_MakePrism(
            face,
            arena.track(new oc.gp_Vec(a[0] * h, a[1] * h, a[2] * h)),
            false,
            true,
          ),
        )
        .Shape(),
    );
  };

  // A ribbed grip: a cylinder with round grooves round its edge.
  const knob = (dia: number, from: number, to: number): TopoDS_Shape => {
    let s = cylinder(dia / 2, from, to);
    const n = Math.max(8, Math.round((Math.PI * dia) / Math.max(3, dia / 4)));
    const rg = (Math.PI * dia) / n / 4;

    for (let k = 0; k < n; k++) {
      const ang = (2 * Math.PI * k) / n;
      const off = [0, 1, 2].map(
        (i) => (dia / 2 + rg * 0.3) * (Math.cos(ang) * frame.u[i]! + Math.sin(ang) * frame.v[i]!),
      ) as V;
      const groove = arena.track(
        arena
          .track(
            new oc.BRepPrimAPI_MakeCylinder(
              arena.track(
                new oc.gp_Ax2(
                  pnt([at(from - 1)[0] + off[0], at(from - 1)[1] + off[1], at(from - 1)[2] + off[2]]),
                  arena.track(new oc.gp_Dir(...a)),
                ),
              ),
              rg,
              to - from + 2,
            ),
          )
          .Shape(),
      );
      s = bool("cut", s, groove);
    }

    // Soft top and bottom edges.
    const e = Math.min(0.6, (to - from) / 6);
    const softened = bool(
      "cut",
      s,
      bool("cut", cylinder(dia, to - e, to + 1), cone(dia / 2 - e, dia / 2 + 1 - e, to - e, to + 1)),
    );

    return bool(
      "cut",
      softened,
      bool("cut", cylinder(dia, from - 1, from + e), cone(dia / 2 + 1 - e, dia / 2 - e, from - 1, from + e)),
    );
  };

  // ---- the blank
  let blank: TopoDS_Shape;
  let top: number;

  if (nut) {
    const outer =
      head === "hex"
        ? hexPrism(dims.across, 0, L)
        : head === "knob"
          ? knob(dims.across, 0, L)
          : cylinder(dims.across / 2, 0, L);
    // Hex nuts: the usual 30° chamfer of the corners on both sides (a double cone through the flats' circle).
    let o = outer;

    if (head === "hex") {
      const r0 = dims.across / 2;
      const grow = Math.sqrt(3) * L;
      o = bool("common", bool("common", o, cone(r0, r0 + grow, 0, L)), cone(r0 + grow, r0, 0, L));
    }

    blank = bool("cut", o, cylinder(R, -1, L + 1));
    top = L;
  } else {
    const k = dims.height;
    const shank = cylinder(R, k, k + L);

    if (head === "none") {
      blank = cylinder(R, 0, L);
    } else {
      let h: TopoDS_Shape;

      if (head === "hex") {
        // Chamfered corners on the head's top (here its bottom, at the plane).
        const r0 = dims.across / 2;
        h = bool("common", hexPrism(dims.across, 0, k), cone(r0, r0 + Math.sqrt(3) * k, 0, k));
      } else if (head === "knob") {
        h = knob(dims.across, 0, k);
      } else if (head === "round") {
        h = bool(
          "fuse",
          cylinder(dims.across / 2, 0, k * 0.45),
          cone(dims.across / 2, dims.across * 0.32, k * 0.45, k),
        );
      } else {
        h = cylinder(dims.across / 2, 0, k);
      }

      if (dims.socket) {
        // The socket opens at the head's bottom, which is where a driver reaches it on a screw standing on
        // its head.
        const depth = head === "round" ? 0.6 * k : 0.6 * k;
        h = bool("cut", h, hexPrism(dims.socket, -1, depth));
      }

      blank = bool("fuse", h, shank);
    }

    top = (head === "none" ? 0 : k) + L;
  }

  const body0 = new Body(oc, arena, f.id, blank);
  const axial = (p: readonly number[]) =>
    (p[0]! - c[0]) * a[0] + (p[1]! - c[1]) * a[1] + (p[2]! - c[2]) * a[2];
  // The round face to thread: the cylinder of radius R.
  let fi = -1;
  body0.faceTags = body0.faces.map((face, i) => {
    const info = body0.faceInfo[i]!;
    const z = axial(body0.facePoints[i]!);

    if (!info.planar) {
      const s = arena.track(new oc.BRepAdaptor_Surface(face, true));

      if (s.GetType() === "GeomAbs_Cylinder" && Math.abs(arena.track(s.Cylinder()).Radius() - R) < 1e-6) {
        fi = i;

        return [nut ? `${f.id}.bore` : `${f.id}.shank`];
      }
    }

    if (nut) {
      return [
        info.planar && Math.abs(z - top) < 1e-6
          ? `${f.id}.top`
          : info.planar && Math.abs(z) < 1e-6
            ? `${f.id}.bottom`
            : `${f.id}.side`,
      ];
    }

    return [info.planar && Math.abs(z - top) < 1e-6 ? `${f.id}.tip` : `${f.id}.head`];
  });
  if (fi < 0) throw new FeatureError(`could not build the ${nut ? "nut" : "screw"}`);

  const tl = nut ? undefined : f.threadLength;
  if (tl !== undefined && !(tl > 0)) throw new FeatureError("the thread length must be greater than zero");

  const { body: threaded } = threadFace(oc, arena, body0, fi, {
    profile: spec.profile,
    diameter: d,
    pitch: spec.pitch,
    starts: spec.starts,
    length: tl,
    clearance: f.clearance,
    leftHanded: f.leftHanded,
    tag: `${f.id}.thread`,
  });

  // ---- finish: chamfered tip, countersunk nut ends (skipped with a warning if OCCT cannot do it)
  let body = threaded;
  const shape = grooveShape(spec.profile, d, spec.pitch, nut, f.clearance ?? 0);

  try {
    if (nut) {
      // 90° countersink from just over the major diameter down to the minor one.
      const rOut = Math.max(shape.root, shape.crest) / 2 + 0.1 * spec.pitch;
      const rIn = Math.min(shape.root, shape.crest) / 2;
      const depth = rOut - rIn;
      const sinks = bool(
        "fuse",
        cone(rOut + 1, rIn - 1e-3, top - depth - 1, top + 1e-3 + 0),
        cone(rIn - 1e-3, rOut + 1, -1e-3, depth + 1),
      );
      body = cutBody(oc, arena, body, sinks, `${f.id}.top`);
    } else {
      // 45° from the root diameter at the tip.
      const rRoot = shape.root / 2;
      const span = R + 1 - rRoot;
      const knife = bool("cut", cylinder(R + 1, top - span, top + 1), cone(R + 1, rRoot, top - span, top));
      body = cutBody(oc, arena, body, knife, `${f.id}.tip`);
    }
  } catch (e) {
    warnings.push(
      `left the ${nut ? "nut's ends" : "tip"} without a chamfer (${e instanceof FeatureError ? e.message : occtErrorMessage(oc, e)})`,
    );
    body = threaded;
  }

  return { body, info: { size: spec.size, pitch: spec.pitch, height: top } };
}

/** `body` minus `tool`; the new faces get `tag`, the others keep theirs. */
function cutBody(oc: OC, arena: Arena, body: Body, tool: TopoDS_Shape, tag: string): Body {
  const t = new Body(oc, arena, body.bodyId, tool);
  t.faceTags = t.faces.map(() => [tag]);

  const out = booleanBodies(oc, arena, body, t, "cut");

  const vol = (s: TopoDS_Shape) => {
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(s, props, false, false, false);

    return Math.abs(props.Mass());
  };

  const before = vol(body.shape);
  const after = vol(out.shape);
  // A boolean that lost the thread (or half the part) did not work.
  if (!(after > 0.8 * before) || !(after < before)) throw new FeatureError("the boolean failed");

  return out;
}
