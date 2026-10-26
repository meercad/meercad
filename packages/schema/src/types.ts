/**
 * TypeScript types for the opencad document format. The JSON Schema in
 * `schema.ts` mirrors these types and is what untrusted input (share links,
 * files, AI tool calls) is validated against.
 */

export const FORMAT = "opencad/1" as const;

/** A number in model units (mm) or an expression string such as `"wall * 2"` or `"2 mm"`. */
export type Expr = number | string;

export type PlaneRef = "origin.XY" | "origin.XZ" | "origin.YZ";

export interface RectangleEntity {
  id: string;
  type: "rectangle";
  /** Lower-left corner in sketch coordinates. */
  corner: [Expr, Expr];
  /** Width (along sketch u) and height (along sketch v). */
  size: [Expr, Expr];
}

export type SketchEntity = RectangleEntity;

export interface Constraint {
  type: string;
  [key: string]: unknown;
}

export interface SketchFeature {
  id: string;
  op: "sketch";
  suppressed?: boolean;
  plane: { ref: PlaneRef };
  entities: SketchEntity[];
  constraints?: Constraint[];
}

export interface ExtrudeFeature {
  id: string;
  op: "extrude";
  suppressed?: boolean;
  /** Profile reference, e.g. `{ ref: "sk1.r1.region" }`. */
  profile: { ref: string };
  /** Extrusion distance along the sketch plane normal. Negative flips direction. */
  distance: Expr;
  mode: "new_body";
}

export interface FilletFeature {
  id: string;
  op: "fillet";
  suppressed?: boolean;
  edges: EdgeSelector | EdgeSelector[];
  radius: Expr;
}

export type Feature = SketchFeature | ExtrudeFeature | FilletFeature;
export type FeatureOp = Feature["op"];

/**
 * Face tags are names assigned by the feature that created a face, e.g.
 * `ex1.end_cap` or `ex1.side[sk1.r1.top]`. A tag ending in `[*]` matches every
 * tag with that prefix (`ex1.side[*]` = all side faces of `ex1`).
 */
export type FaceTag = string;

export type Direction = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

export interface FaceFilter {
  planar?: boolean;
  normal?: Direction;
}

export type FaceSelector =
  | { face: FaceTag }
  | {
      select: "faces";
      of?: string;
      where?: FaceFilter & { tag?: FaceTag };
      pick?: "largest" | "smallest";
    };

export type EdgeSelector =
  /** The single edge shared by two tagged faces. */
  | { edge: [FaceTag, FaceTag] }
  /** All edges bounding faces that match `where.face` (relative to `of` when it has no dot). */
  | { select: "edges"; of?: string; where?: { face?: FaceTag } };

export interface OpencadDocument {
  format: typeof FORMAT;
  /** Named user parameters, e.g. `{ wall: "2 mm", width: "wall * 10" }`. */
  params: Record<string, Expr>;
  features: Feature[];
  /** Id of the last feature that is evaluated, or null for all. */
  rollback: string | null;
}

/** Operations-API: the only way UI, AI, scripting and MCP change a document. */
export type DocOp =
  | { type: "add_features"; features: Feature[]; after?: string | null }
  | { type: "edit_feature"; id: string; patch: Record<string, unknown> }
  | { type: "delete_feature"; id: string }
  | { type: "set_param"; name: string; expr: Expr | null }
  | { type: "set_rollback"; id: string | null }
  | { type: "replace"; doc: OpencadDocument };

export function emptyDocument(): OpencadDocument {
  return { format: FORMAT, params: {}, features: [], rollback: null };
}
