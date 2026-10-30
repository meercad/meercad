/** Labels, icons and default drafts for every feature type. */
import {
  ArrowUpFromLine,
  Bolt,
  Box,
  Cone,
  Magnet,
  Nut,
  Scaling,
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
import { t } from "./i18n";

export interface FeatureMeta {
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  hint: string;
}

export const FEATURES: Record<FeatureOp, FeatureMeta> = {
  sketch: { label: t("Sketch"), icon: Pencil, shortcut: "S", hint: t("Draw a constrained 2D sketch on a plane or face") },
  extrude: { label: t("Extrude"), icon: ArrowUpFromLine, shortcut: "E", hint: t("Extrude sketch regions to add, cut or intersect") },
  revolve: { label: t("Revolve"), icon: Rotate3d, shortcut: "V", hint: t("Revolve sketch regions around an axis") },
  fillet: { label: t("Fillet"), icon: SquareRoundCorner, shortcut: "F", hint: t("Round edges") },
  chamfer: { label: t("Chamfer"), icon: Triangle, shortcut: "C", hint: t("Bevel edges") },
  shell: { shortcut: "H", label: t("Shell"), icon: Shell, hint: t("Hollow a body, removing selected faces") },
  thread: { shortcut: "T", label: t("Thread"), icon: Bolt, hint: t("ISO metric thread in a hole or on a shaft") },
  loft: { shortcut: "Shift+L", label: t("Loft"), icon: Cone, hint: t("Solid through two or more profiles: funnels, round-to-square adapters") },
  sweep: { shortcut: "W", label: t("Sweep"), icon: Spline, hint: t("Move a profile along a path of lines and arcs: pipes, ducts, handles") },
  scale: { label: t("Scale"), icon: Scaling, hint: t("Make parts larger or smaller, e.g. correct a scan to a measured size") },
  align: { shortcut: "Shift+A", label: t("Align"), icon: Magnet, hint: t("Set a part's face onto another's, or a shaft's axis onto a hole's") },
  standard_part: { shortcut: "Shift+P", label: t("Standard part"), icon: Nut, hint: t("Screws, nuts, washers, bearings and magnets to standard sizes, placed on a face") },
  text: { shortcut: "Shift+T", label: t("Text"), icon: Type, hint: t("Raised or engraved lettering on a face") },
  draft: { shortcut: "Shift+D", label: t("feature::Draft"), icon: Pyramid, hint: t("Tilt side faces by an angle so a cast or moulded part leaves its mould") },
  rib: { shortcut: "Shift+B", label: t("Rib"), icon: Slash, hint: t("Stiffening web from an open sketch line to the walls it meets") },
  split: { shortcut: "Shift+K", label: t("Split"), icon: Scissors, hint: t("Cut parts in two at a plane or flat face, e.g. for the printer's build volume") },
  hole: { shortcut: "Shift+H", label: t("Hole"), icon: CircleDot, hint: t("Holes for screws (clearance, counterbore, countersink), threads and heat-set inserts") },
  gear: { shortcut: "G", label: t("Gear"), icon: Cog, hint: t("Involute gear, ring gear or rack; adds the mating gear at the right distance") },
  linear_pattern: { shortcut: "L", label: t("Linear pattern"), icon: Grid3x3, hint: t("Repeat features or bodies along a direction") },
  circular_pattern: { shortcut: "O", label: t("Circular pattern"), icon: Orbit, hint: t("Repeat features or bodies around an axis") },
  mirror: { shortcut: "I", label: t("Mirror"), icon: SquareSplitHorizontal, hint: t("Mirror features or bodies about a plane") },
  transform: { shortcut: "M", label: t("Move"), icon: Move3d, hint: t("Move, rotate or copy parts") },
  boolean: { shortcut: "B", label: t("Boolean"), icon: Combine, hint: t("Union, subtract or intersect bodies") },
  plane: { shortcut: "N", label: t("Plane"), icon: Layers, hint: t("Construction plane offset from a plane or face") },
  delete: { label: t("Delete part"), icon: Trash2, hint: t("Remove parts from the model") },
  import: { label: t("Import"), icon: FileUp, hint: t("Import STEP or STL") },
  mesh_convert: { label: t("Convert mesh"), icon: Shapes, hint: t("Turn an imported mesh into a body with editable faces") },
};

export const BODY_ICON = Box;
export const COPY_ICON = Copy;

export const TOOLBAR: FeatureOp[] = ["sketch", "extrude", "revolve", "loft", "sweep", "rib", "text", "standard_part", "fillet", "chamfer", "shell", "draft", "thread", "hole", "split", "gear", "transform", "align", "scale", "linear_pattern", "circular_pattern", "mirror", "boolean", "plane"];

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
    case "scale":
      return { id, op, bodies: [], factor: 1 };
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
      return "face" in f.profile || f.profile.sketch ? null : t("Select sketch regions or a face as profile");
    case "fillet":
    case "chamfer":
      return (Array.isArray(f.edges) ? f.edges.length : 1) ? null : t("Select edges");
    case "shell":
      return f.faces.length ? null : t("Select faces to remove");
    case "thread":
      return "face" in f.face && !f.face.face ? t("Select a hole wall or a round shaft") : null;
    case "linear_pattern":
    case "circular_pattern":
    case "mirror":
      return ("features" in f.source ? f.source.features : f.source.bodies).length ? null : t("Select features or bodies to copy");
    case "boolean":
      return !f.target ? t("Select the target body") : f.tools.length ? null : t("Select tool bodies");
    case "transform":
      return f.bodies.length ? null : t("Select parts to move");
    case "delete":
      return f.bodies.length ? null : t("Select parts to delete");
    case "import":
      return f.data ? null : t("Choose a file");
    case "mesh_convert":
      return f.body ? null : t("Select a mesh part");
    case "scale":
      return f.bodies.length ? null : t("Pick the parts to scale");
    case "align": {
      const empty = (s: Feature & { op: "align" }, k: "from" | "to") => {
        const v = s[k];
        const sel = "face" in v ? v.face : v.axisOf;
        return "face" in sel && !sel.face;
      };
      return empty(f, "from") ? t("Pick the face of the part to move") : empty(f, "to") ? t("Pick the face to set it onto") : null;
    }
    case "standard_part":
      return f.points.length ? null : t("Tap a flat face where the part goes");
    case "draft":
      return f.faces.length ? null : t("Pick the side faces to draft");
    case "rib":
      return f.sketch ? null : t("Pick the rib's line in a sketch");
    case "loft":
      return f.profiles.length >= 2 ? null : t("Pick at least two profiles in order: sketch regions or flat faces");
    case "sweep":
      return !("face" in f.profile) && !f.profile.sketch ? t("Pick the profile: sketch regions") : f.path.sketch ? null : t("Pick the path: lines and arcs of a sketch");
    case "hole":
      return f.points.length ? null : t("Tap a flat face where the hole goes");
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
