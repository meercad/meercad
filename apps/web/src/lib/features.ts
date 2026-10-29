/** Labels, icons and default drafts for every feature type. */
import {
  ArrowUpFromLine,
  Bolt,
  Box,
  Cone,
  Magnet,
  Nut,
  Pyramid,
  Scissors,
  Slash,
  Type,
  Spline,
  Cog,
  CircleDot,
  Combine,
  Copy,
  FileUp,
  Grid3x3,
  Layers,
  Pencil,
  Rotate3d,
  Shell,
  SquareRoundCorner,
  SquareSplitHorizontal,
  Triangle,
  Orbit,
  Shapes,
  Move3d,
  type LucideIcon, Trash2 } from "lucide-react";
import type { EdgeSelector, Feature, FeatureOp, MeercadDocument } from "@meercad/schema";
import { nextFeatureId, standardShape } from "@meercad/model";

export interface FeatureMeta {
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  hint: string;
}

export const FEATURES: Record<FeatureOp, FeatureMeta> = {
  sketch: { label: "Sketch", icon: Pencil, shortcut: "S", hint: "Draw a constrained 2D sketch on a plane or face" },
  extrude: { label: "Extrude", icon: ArrowUpFromLine, shortcut: "E", hint: "Extrude sketch regions to add, cut or intersect" },
  revolve: { label: "Revolve", icon: Rotate3d, shortcut: "V", hint: "Revolve sketch regions around an axis" },
  fillet: { label: "Fillet", icon: SquareRoundCorner, shortcut: "F", hint: "Round edges" },
  chamfer: { label: "Chamfer", icon: Triangle, shortcut: "C", hint: "Bevel edges" },
  shell: { shortcut: "H", label: "Shell", icon: Shell, hint: "Hollow a body, removing selected faces" },
  thread: { shortcut: "T", label: "Thread", icon: Bolt, hint: "ISO metric thread in a hole or on a shaft" },
  loft: { shortcut: "Shift+L", label: "Loft", icon: Cone, hint: "Solid through two or more profiles: funnels, round-to-square adapters" },
  sweep: { shortcut: "W", label: "Sweep", icon: Spline, hint: "Move a profile along a path of lines and arcs: pipes, ducts, handles" },
  align: { shortcut: "Shift+A", label: "Align", icon: Magnet, hint: "Set a part's face onto another's, or a shaft's axis onto a hole's" },
  standard_part: { shortcut: "Shift+P", label: "Standard part", icon: Nut, hint: "Screws, nuts, washers, bearings and magnets to standard sizes, placed on a face" },
  text: { shortcut: "Shift+T", label: "Text", icon: Type, hint: "Raised or engraved lettering on a face" },
  draft: { shortcut: "Shift+D", label: "Draft", icon: Pyramid, hint: "Tilt side faces by an angle so a cast or moulded part leaves its mould" },
  rib: { shortcut: "Shift+B", label: "Rib", icon: Slash, hint: "Stiffening web from an open sketch line to the walls it meets" },
  split: { shortcut: "Shift+K", label: "Split", icon: Scissors, hint: "Cut parts in two at a plane or flat face, e.g. for the printer's build volume" },
  hole: { shortcut: "Shift+H", label: "Hole", icon: CircleDot, hint: "Holes for screws (clearance, counterbore, countersink), threads and heat-set inserts" },
  gear: { shortcut: "G", label: "Gear", icon: Cog, hint: "Involute gear, ring gear or rack; adds the mating gear at the right distance" },
  linear_pattern: { shortcut: "L", label: "Linear pattern", icon: Grid3x3, hint: "Repeat features or bodies along a direction" },
  circular_pattern: { shortcut: "O", label: "Circular pattern", icon: Orbit, hint: "Repeat features or bodies around an axis" },
  mirror: { shortcut: "I", label: "Mirror", icon: SquareSplitHorizontal, hint: "Mirror features or bodies about a plane" },
  transform: { shortcut: "M", label: "Move", icon: Move3d, hint: "Move, rotate or copy parts" },
  boolean: { shortcut: "B", label: "Boolean", icon: Combine, hint: "Union, subtract or intersect bodies" },
  plane: { shortcut: "N", label: "Plane", icon: Layers, hint: "Construction plane offset from a plane or face" },
  delete: { label: "Delete part", icon: Trash2, hint: "Remove parts from the model" },
  import: { label: "Import", icon: FileUp, hint: "Import STEP or STL" },
  mesh_convert: { label: "Convert mesh", icon: Shapes, hint: "Turn an imported mesh into a body with editable faces" },
};

export const BODY_ICON = Box;
export const COPY_ICON = Copy;

export const TOOLBAR: FeatureOp[] = ["sketch", "extrude", "revolve", "loft", "sweep", "rib", "text", "standard_part", "fillet", "chamfer", "shell", "draft", "thread", "hole", "split", "gear", "transform", "align", "linear_pattern", "circular_pattern", "mirror", "boolean", "plane"];

/** A new feature with sensible defaults; selections start empty and are filled from the viewport. */
export function draftFeature(op: FeatureOp, doc: MeercadDocument): Feature {
  const id = nextFeatureId(doc, op);
  const lastSketch = [...doc.features].reverse().find((f) => f.op === "sketch");
  const lastSketchUsed = lastSketch && sketchesUsed(doc.features).has(lastSketch.id);
  const profile = lastSketch && !lastSketchUsed ? { sketch: lastSketch.id } : { sketch: "" };
  const noEdges: EdgeSelector[] = [];
  switch (op) {
    case "sketch":
      return { id, op, plane: { ref: "origin.XY" }, entities: [], constraints: [] };
    case "extrude":
      return { id, op, profile, extent: "blind", distance: 10, mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "import") ? "join" : "new_body" };
    case "revolve":
      return { id, op, profile, axis: { ref: "origin.Z" }, angle: 360, mode: "new_body" };
    case "fillet":
      return { id, op, edges: noEdges, radius: 2 };
    case "chamfer":
      return { id, op, edges: noEdges, distance: 1 };
    case "shell":
      return { id, op, faces: [], thickness: 2 };
    case "thread":
      return { id, op, face: { face: "" } };
    case "gear":
      return { id, op, kind: "spur", module: 1.5, teeth: 20, width: 8, plane: { ref: "origin.XY" }, mode: "new_body" };
    case "linear_pattern":
      return { id, op, source: { features: [] }, direction: { ref: "origin.X" }, count: 3, spacing: 20 };
    case "circular_pattern":
      return { id, op, source: { features: [] }, axis: { ref: "origin.Z" }, count: 6 };
    case "mirror":
      return { id, op, source: { features: [] }, plane: { ref: "origin.YZ" } };
    case "boolean":
      return { id, op, operation: "union", target: "", tools: [] };
    case "transform":
      return { id, op, bodies: [], translate: [0, 0, 0] };
    case "delete":
      return { id, op, bodies: [] };
    case "plane":
      return { id, op, base: { ref: "origin.XY" }, offset: 20 };
    case "import":
      return { id, op, format: "step", fileName: "", data: "" };
    case "mesh_convert":
      return { id, op, body: "" };
    case "loft":
      return { id, op, profiles: [], mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "loft" || f.op === "sweep" || f.op === "import") ? "join" : "new_body" };
    case "sweep":
      return { id, op, profile, path: { sketch: "" }, mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "loft" || f.op === "sweep" || f.op === "import") ? "join" : "new_body" };
    case "align":
      return { id, op, from: { face: { face: "" } }, to: { face: { face: "" } } };
    case "standard_part":
      return { id, op, kind: "socket_screw", size: "M3", length: 10, plane: { ref: "origin.XY" }, points: [] } as unknown as Feature;
    case "text":
      return { id, op, plane: { ref: "origin.XY" }, text: "meerCAD", size: 8, depth: 1, mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "import") ? "join" : "new_body" };
    case "draft":
      return { id, op, faces: [], angle: 3, neutral: { ref: "origin.XY" } };
    case "rib":
      return { id, op, sketch: lastSketch && !lastSketchUsed ? lastSketch.id : "", thickness: 3 };
    case "split":
      return { id, op, plane: { ref: "origin.YZ" }, bodies: [] };
    case "hole":
      return { id, op, plane: { ref: "origin.XY" }, points: [], kind: "clearance", size: "M3" } as unknown as Feature;
  }
}

/** Why a draft cannot be built yet (missing selections), or null. */
export function draftProblem(f: Feature): string | null {
  switch (f.op) {
    case "extrude":
    case "revolve":
      return "face" in f.profile || f.profile.sketch ? null : "Select sketch regions or a face as profile";
    case "fillet":
    case "chamfer":
      return (Array.isArray(f.edges) ? f.edges.length : 1) ? null : "Select edges";
    case "shell":
      return f.faces.length ? null : "Select faces to remove";
    case "thread":
      return "face" in f.face && !f.face.face ? "Select a hole wall or a round shaft" : null;
    case "linear_pattern":
    case "circular_pattern":
    case "mirror":
      return ("features" in f.source ? f.source.features : f.source.bodies).length ? null : "Select features or bodies to copy";
    case "boolean":
      return !f.target ? "Select the target body" : f.tools.length ? null : "Select tool bodies";
    case "transform":
      return f.bodies.length ? null : "Select parts to move";
    case "delete":
      return f.bodies.length ? null : "Select parts to delete";
    case "import":
      return f.data ? null : "Choose a file";
    case "mesh_convert":
      return f.body ? null : "Select a mesh part";
    case "align": {
      const empty = (s: Feature & { op: "align" }, k: "from" | "to") => {
        const v = s[k];
        const sel = "face" in v ? v.face : v.axisOf;
        return "face" in sel && !sel.face;
      };
      return empty(f, "from") ? "Pick the face of the part to move" : empty(f, "to") ? "Pick the face to set it onto" : null;
    }
    case "standard_part":
      return f.points.length ? null : "Tap a flat face where the part goes";
    case "draft":
      return f.faces.length ? null : "Pick the side faces to draft";
    case "rib":
      return f.sketch ? null : "Pick the rib's line in a sketch";
    case "loft":
      return f.profiles.length >= 2 ? null : "Pick at least two profiles in order: sketch regions or flat faces";
    case "sweep":
      return !("face" in f.profile) && !f.profile.sketch ? "Pick the profile: sketch regions" : f.path.sketch ? null : "Pick the path: lines and arcs of a sketch";
    case "hole":
      return f.points.length ? null : "Tap a flat face where the hole goes";
    default:
      return null;
  }
}

export function featureName(f: Feature): string {
  if (!f.name && f.op === "standard_part") {
    // A standard part is named by what it is, e.g. "M3×12 ISO 4762".
    try {
      const length = typeof f.length === "number" ? f.length : undefined;
      const diameter = typeof f.diameter === "number" ? f.diameter : undefined;
      const height = typeof f.height === "number" ? f.height : undefined;
      return standardShape(f.kind, { size: f.size, length, diameter, height }).label;
    } catch {
      // Falls through to the generic name.
    }
  }
  return f.name ?? `${FEATURES[f.op].label} ${f.id.replace(/^\D+/, "")}`;
}

/**
 * A part's name: the feature that made it ("Extrude 1"), with the copy number for pattern and
 * copy results ("Linear pattern 3 (2)"). Part ids are the making feature's id plus "_…" for copies.
 */
export function partName(id: string, features: readonly Feature[]): string {
  let best: Feature | undefined;
  for (const f of features)
    if ((id === f.id || id.startsWith(`${f.id}_`)) && f.id.length > (best?.id.length ?? 0)) best = f;
  if (!best) return id;
  const rest = id.slice(best.id.length + 1);
  if (!rest) return featureName(best);
  if (/^\d+$/.test(rest)) return `${featureName(best)} (${rest})`;
  // Copies of several parts carry the copied part's id: "lp1_ex2_3".
  const [, of, n] = /^(.*?)(?:_(\d+))?$/.exec(rest)!;
  return `${featureName(best)} (${partName(of!, features)}${n ? ` ${n}` : ""})`;
}

/** Sketches that a feature builds on (they are hidden once used, like a consumed profile). */
export function sketchesUsed(features: readonly Feature[]): Set<string> {
  return new Set(
    features.flatMap((f) => {
      if (f.op === "extrude" || f.op === "revolve") return "sketch" in f.profile ? [f.profile.sketch] : [];
      if (f.op === "rib") return [f.sketch];
      if (f.op === "loft") return f.profiles.flatMap((p) => ("sketch" in p ? [p.sketch] : []));
      if (f.op === "sweep") return ["sketch" in f.profile ? f.profile.sketch : "", f.path.sketch].filter(Boolean);
      return [];
    }),
  );
}
