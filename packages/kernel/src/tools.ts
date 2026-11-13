/** Worker-side utilities on the last rebuilt state: STEP export and measuring. */

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { Arena } from "./arena.js";
import type { Body } from "./body.js";
import { bounds, boundsOverlap } from "./boolean.js";
import { meshBody, type BodyMesh } from "./mesh.js";
import { texturedMesh, texturesOf } from "./texture.js";
import type { OC } from "./occt.js";
import type { ModelState } from "./state.js";

/**
 * Names and colours ("#rrggbb") of parts for the STEP file, by body id, and where a moved part is
 * shown (column-major 4×4 from its rest position).
 */
export type StepPart = { id: string; name: string; color?: string; pose?: number[] };

/** The shape moved by a column-major 4×4 matrix. */
function placed(oc: OC, arena: Arena, shape: TopoDS_Shape, m: readonly number[] | undefined): TopoDS_Shape {
  if (!m) return shape;
  const t = arena.track(new oc.gp_Trsf());
  t.SetValues(m[0]!, m[4]!, m[8]!, m[12]!, m[1]!, m[5]!, m[9]!, m[13]!, m[2]!, m[6]!, m[10]!, m[14]!);
  return arena.track(shape.Moved(arena.track(new oc.TopLoc_Location(t)), false));
}

export function exportStep(oc: OC, state: ModelState, bodyIds?: string[], parts?: readonly StepPart[]): Uint8Array {
  const arena = new Arena();
  try {
    const bodies = [...state.bodies.values()].filter((b) => !bodyIds || bodyIds.includes(b.bodyId));
    if (!bodies.length) throw new Error("nothing to export");
    if (parts?.length) {
      try {
        return exportStepParts(oc, arena, bodies, parts);
      } catch (e) {
        // Names and colours are a nicety: without them the shapes still go out.
        /* v8 ignore next -- OCCT throws here only on failures no test can provoke on purpose */
        console.warn("STEP with names and colours failed, writing plain STEP:", e);
      }
    }
    const writer = arena.track(new oc.STEPControl_Writer());
    const range = arena.track(new oc.Message_ProgressRange());
    for (const b of bodies) writer.Transfer(placed(oc, arena, b.shape, parts?.find((p) => p.id === b.bodyId)?.pose), "STEPControl_AsIs", true, range);
    const path = `/export-${Date.now()}.step`;
    writer.Write(path);
    const data = oc.FS.readFile(path) as Uint8Array;
    oc.FS.unlink(path);
    return data.slice();
  } finally {
    arena.dispose();
  }
}

/**
 * STEP (AP214) with each part as a named shape in its colour, through an XCAF document: other CAD
 * tools show the parts list with names and the parts in their colours.
 */
function exportStepParts(oc: OC, arena: Arena, bodies: readonly Body[], parts: readonly StepPart[]): Uint8Array {
  const doc = arena.track(new oc.TDocStd_Document(arena.track(new oc.TCollection_ExtendedString("XmlXCAF", false))));
  oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
  const main = arena.track(doc.Main());
  const shapes = arena.track(oc.XCAFDoc_DocumentTool.ShapeTool(main));
  const colors = arena.track(oc.XCAFDoc_DocumentTool.ColorTool(main));
  for (const b of bodies) {
    const label = arena.track(shapes.NewShape());
    const p = parts.find((x) => x.id === b.bodyId);
    shapes.SetShape(label, placed(oc, arena, b.shape, p?.pose));
    oc.TDataStd_Name.Set(label, arena.track(new oc.TCollection_ExtendedString(p?.name ?? b.bodyId, true)));
    const hex = p?.color && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : null;
    if (hex) {
      // OCCT keeps colours in linear RGB; the hex is sRGB.
      const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const [r, g, bl] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
      colors.SetColor(label, arena.track(new oc.Quantity_ColorRGBA(r!, g!, bl!, 1)), "XCAFDoc_ColorGen" as never);
    }
  }
  shapes.UpdateAssemblies();
  const writer = arena.track(new oc.STEPCAFControl_Writer());
  writer.SetColorMode(true);
  writer.SetNameMode(true);
  // Perform writes one file; Transfer with a name (even empty) would split it into a file per part.
  const path = `/export-${Date.now()}.step`;
  if (!writer.Perform(doc, path, arena.track(new oc.Message_ProgressRange()))) throw new Error("STEP transfer failed");
  const data = oc.FS.readFile(path) as Uint8Array;
  oc.FS.unlink(path);
  return data.slice();
}

/**
 * Export meshes by part, with the height pictures they were made with: a part that has not changed
 * since the last export is not meshed again (a design of some hundred parts took half a minute per
 * export, however little had changed). Parts never change once made, so the part itself is the key.
 */
const exported = new WeakMap<Body, { sig: string; mesh: BodyMesh }>();
/** Above this many bytes per export nothing is kept: the meshes would fill the kernel's memory. */
const KEEP_EXPORT_BYTES = 1.5 * 2 ** 30;
const meshBytes = (m: BodyMesh) => m.positions.byteLength + m.normals.byteLength + m.indices.byteLength + m.edgeLines.byteLength;

/**
 * Print/CNC-quality triangles of the last rebuild's bodies, for STL and 3MF export. The meshes are
 * kept for the next export (see `exported`): the caller must not hand their buffers away.
 */
export function exportMeshes(oc: OC, state: ModelState, bodyIds?: string[]): BodyMesh[] {
  const arena = new Arena();
  try {
    const bodies = [...state.bodies.values()].filter((b) => !bodyIds || bodyIds.includes(b.bodyId));
    if (!bodies.length) throw new Error("nothing to export");
    const meshed: Body[] = [];
    const out = bodies.map((b) => {
      const tex = texturesOf(state, b);
      const sig = tex?.sig ?? "";
      const kept = exported.get(b);
      if (kept?.sig === sig) return kept.mesh;
      const mesh = meshBody(oc, b, bounds(oc, arena, b.shape), 1, true);
      meshed.push(b);
      const made = tex ? texturedMesh(oc, b, mesh, tex.layers, "export") : mesh;
      exported.set(b, { sig, mesh: made });
      return made;
    });
    // The fine triangulation stays on the shapes otherwise, and later display meshes would reuse it.
    // (Cleaned only now: bodies that share their geometry, such as equal baseplate pieces, are
    // triangulated once.)
    for (const b of meshed) oc.BRepTools.Clean(b.shape, true);
    if (out.reduce((n, m) => n + meshBytes(m), 0) > KEEP_EXPORT_BYTES) for (const b of bodies) exported.delete(b);
    return out;
  } finally {
    arena.dispose();
  }
}

export interface PickRef {
  bodyId: string;
  kind: "face" | "edge";
  index: number;
}

export interface Measurement {
  rows: [string, string][];
  /** Closest points for distance display. */
  points?: [[number, number, number], [number, number, number]];
}

const f = (n: number, unit = "mm") => `${Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(3).replace(/\.?0+$/, "")} ${unit}`;

export function measure(oc: OC, state: ModelState, a: PickRef, b?: PickRef): Measurement {
  const arena = new Arena();
  try {
    const shapeOf = (p: PickRef) => {
      const body = state.bodies.get(p.bodyId);
      const s = body && (p.kind === "face" ? body.faces[p.index] : body.edges[p.index]);
      if (!body || !s) throw new Error("selection no longer exists");
      return { body, s };
    };
    const describe = (p: PickRef, body: Body) => {
      const rows: [string, string][] = [];
      const s = p.kind === "face" ? body.faces[p.index]! : body.edges[p.index]!;
      const props = arena.track(new oc.GProp_GProps());
      if (p.kind === "face") {
        oc.BRepGProp.SurfaceProperties(s, props, false, false);
        rows.push(["Area", f(props.Mass(), "mm²")]);
        const surf = arena.track(new oc.BRepAdaptor_Surface(body.faces[p.index]!, true));
        if (surf.GetType() === "GeomAbs_Cylinder") rows.push(["Radius", f(arena.track(surf.Cylinder()).Radius())]);
      } else {
        oc.BRepGProp.LinearProperties(s, props, false, false);
        rows.push(["Length", f(props.Mass())]);
        const c = arena.track(new oc.BRepAdaptor_Curve(body.edges[p.index]!));
        if (c.GetType() === "GeomAbs_Circle") {
          const r = arena.track(c.Circle()).Radius();
          rows.push(["Radius", f(r)], ["Diameter", f(2 * r)]);
        }
      }
      return rows;
    };
    const A = shapeOf(a);
    if (!b) return { rows: describe(a, A.body) };
    const B = shapeOf(b);
    const d = arena.track(new oc.BRepExtrema_DistShapeShape(A.s, B.s));
    const rows: [string, string][] = [];
    let points: Measurement["points"];
    if (d.IsDone()) {
      rows.push(["Distance", f(d.Value())]);
      const p1 = arena.track(d.PointOnShape1(1));
      const p2 = arena.track(d.PointOnShape2(1));
      points = [[p1.X(), p1.Y(), p1.Z()], [p2.X(), p2.Y(), p2.Z()]];
      const delta = [p2.X() - p1.X(), p2.Y() - p1.Y(), p2.Z() - p1.Z()];
      rows.push(["ΔX / ΔY / ΔZ", delta.map((v) => (Math.round(v * 1000) / 1000).toString()).join(" / ")]);
    }
    const dirA = direction(oc, arena, a, A.body);
    const dirB = direction(oc, arena, b, B.body);
    if (dirA && dirB) {
      const cos = Math.abs(dirA[0] * dirB[0] + dirA[1] * dirB[1] + dirA[2] * dirB[2]);
      let angle = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
      // A face normal against an edge direction: report the angle between face and edge.
      if (a.kind !== b.kind) angle = 90 - angle;
      rows.push(["Angle", f(angle, "°")]);
    }
    return { rows, ...(points ? { points } : {}) };
  } finally {
    arena.dispose();
  }
}

function direction(oc: OC, arena: Arena, p: PickRef, body: Body): [number, number, number] | null {
  if (p.kind === "face") {
    const info = body.faceInfo[p.index];
    return info?.planar && info.normal ? info.normal : null;
  }
  const c = arena.track(new oc.BRepAdaptor_Curve(body.edges[p.index]!));
  if (c.GetType() !== "GeomAbs_Line") return null;
  const a = arena.track(c.Value(c.FirstParameter()));
  const b = arena.track(c.Value(c.LastParameter()));
  const v: [number, number, number] = [b.X() - a.X(), b.Y() - a.Y(), b.Z() - a.Z()];
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** How close two parts come in a pose: their gap, or how much of them overlaps (mm³). */
export interface Clearance {
  a: string;
  b: string;
  /** Smallest gap, mm (0 when they touch or overlap). */
  distance: number;
  /** Volume both occupy, mm³ (0 when apart). */
  overlap: number;
  /** Closest points, for showing where. */
  points?: [[number, number, number], [number, number, number]];
}

/**
 * Gaps between parts placed by `poses` (column-major 4×4 by body id; others at rest), for every
 * pair where at least one part is in `moving` and their boxes come within `within` mm. Parts in
 * `skip` are left out.
 * Parts with the same number in `rigid` are held together (fixed joints) and never move against
 * each other: their pairs are left out too (a screw in its servo, a servo on its link).
 */
/**
 * Limits for a check of a big design: only pairs with a part reaching into `box`, and at most
 * `budgetMs` of work. `left` is set to the number of pairs that were not looked at for lack of time.
 */
export interface ClearanceLimits {
  box?: { min: [number, number, number]; max: [number, number, number] };
  budgetMs?: number;
  left?: number;
}

export function clearances(oc: OC, state: ModelState, moving: readonly string[], poses: Readonly<Record<string, number[]>>, within = 2, skip: readonly string[] = [], rigid: Readonly<Record<string, number>> = {}, limits: ClearanceLimits = {}): Clearance[] {
  const arena = new Arena();
  try {
    const shapes = new Map<string, TopoDS_Shape>();
    for (const [id, body] of state.bodies) if (!skip.includes(id)) shapes.set(id, placed(oc, arena, body.shape, poses[id]));
    const box = new Map([...shapes].map(([id, s]) => [id, bounds(oc, arena, s)]));
    const grow = (b: ReturnType<typeof bounds>) => ({ min: b.min.map((v) => v - within) as typeof b.min, max: b.max.map((v) => v + within) as typeof b.max });
    const ids = [...shapes.keys()].filter((id) => !limits.box || boundsOverlap(box.get(id)!, limits.box));
    const out: Clearance[] = [];
    const mover = new Set(moving);
    const started = performance.now();
    limits.left = 0;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (!mover.has(a) && !mover.has(b)) continue;
        if (rigid[a] !== undefined && rigid[a] === rigid[b]) continue;
        if (!boundsOverlap(grow(box.get(a)!), box.get(b)!)) continue;
        if (limits.budgetMs !== undefined && performance.now() - started > limits.budgetMs) {
          limits.left++;
          continue;
        }
        const A = shapes.get(a)!;
        const B = shapes.get(b)!;
        const d = arena.track(new oc.BRepExtrema_DistShapeShape(A, B));
        if (!d.IsDone()) continue;
        const distance = d.Value();
        const p1 = arena.track(d.PointOnShape1(1));
        const p2 = arena.track(d.PointOnShape2(1));
        let overlap = 0;
        if (distance < 1e-6) {
          const common = arena.track(new oc.BRepAlgoAPI_Common(A, B));
          if (common.IsDone() && !common.HasErrors()) {
            const props = arena.track(new oc.GProp_GProps());
            oc.BRepGProp.VolumeProperties(arena.track(common.Shape()), props, false, false, false);
            overlap = Math.abs(props.Mass());
          }
        }
        out.push({ a, b, distance, overlap, points: [[p1.X(), p1.Y(), p1.Z()], [p2.X(), p2.Y(), p2.Z()]] });
      }
    return out;
  } finally {
    arena.dispose();
  }
}
