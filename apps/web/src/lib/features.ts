/** Labels, icons and default drafts for every feature type. */
import {
  ArrowUpFromLine,
  Box,
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
  Move3d,
  type LucideIcon, Trash2 } from "lucide-react";
import type { EdgeSelector, Feature, FeatureOp, LeocadDocument } from "@leocad/schema";
import { nextFeatureId } from "@leocad/model";

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
  linear_pattern: { shortcut: "L", label: "Linear pattern", icon: Grid3x3, hint: "Repeat features or bodies along a direction" },
  circular_pattern: { shortcut: "O", label: "Circular pattern", icon: Orbit, hint: "Repeat features or bodies around an axis" },
  mirror: { shortcut: "I", label: "Mirror", icon: SquareSplitHorizontal, hint: "Mirror features or bodies about a plane" },
  transform: { shortcut: "M", label: "Move", icon: Move3d, hint: "Move, rotate or copy parts" },
  boolean: { shortcut: "B", label: "Boolean", icon: Combine, hint: "Union, subtract or intersect bodies" },
  plane: { shortcut: "N", label: "Plane", icon: Layers, hint: "Construction plane offset from a plane or face" },
  delete: { label: "Delete part", icon: Trash2, hint: "Remove parts from the model" },
  import: { label: "Import", icon: FileUp, hint: "Import STEP or STL" },
};

export const BODY_ICON = Box;
export const COPY_ICON = Copy;

export const TOOLBAR: FeatureOp[] = ["sketch", "extrude", "revolve", "fillet", "chamfer", "shell", "transform", "linear_pattern", "circular_pattern", "mirror", "boolean", "plane"];

/** A new feature with sensible defaults; selections start empty and are filled from the viewport. */
export function draftFeature(op: FeatureOp, doc: LeocadDocument): Feature {
  const id = nextFeatureId(doc, op);
  const lastSketch = [...doc.features].reverse().find((f) => f.op === "sketch");
  const lastSketchUsed = lastSketch && doc.features.some((f) => (f.op === "extrude" || f.op === "revolve") && "sketch" in f.profile && f.profile.sketch === lastSketch.id);
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
    default:
      return null;
  }
}

export function featureName(f: Feature): string {
  return f.name ?? `${FEATURES[f.op].label} ${f.id.replace(/^\D+/, "")}`;
}
