/**
 * TypeScript types for the meerCAD document format. The JSON Schema in `schema.ts` mirrors these
 * types and is what untrusted input (share links, files, AI tool calls) is validated against.
 */

export const FORMAT = "meercad/1" as const;

/** A number (mm, or degrees for angles) or an expression such as `"wall * 2"`, `"2 mm"`, `"45 deg"`. */
export type Expr = number | string;

/** Origin planes, or the id of a `plane` feature. */
export type PlaneRef = "origin.XY" | "origin.XZ" | "origin.YZ" | (string & {});

/** Where a sketch or plane sits: a named plane, or a planar face of the model. */
export type PlaneSpec = { ref: PlaneRef } | { face: FaceSelector };

/** Axis for revolve and circular patterns. */
export type AxisRef =
  | { ref: "origin.X" | "origin.Y" | "origin.Z" }
  /** A sketch line, e.g. `{ line: "sk1.l3" }` (construction lines work too). */
  | { line: string }
  | { edge: EdgeSelector };

// ---------------------------------------------------------------- sketch

export interface PointEntity {
  id: string;
  type: "point";
  x: number;
  y: number;
  construction?: boolean;
}
export interface LineEntity {
  id: string;
  type: "line";
  p1: string;
  p2: string;
  construction?: boolean;
}
export interface CircleEntity {
  id: string;
  type: "circle";
  center: string;
  radius: number;
  construction?: boolean;
}
/** Counter-clockwise arc from `start` to `end` around `center`. */
export interface ArcEntity {
  id: string;
  type: "arc";
  center: string;
  start: string;
  end: string;
  construction?: boolean;
}
/** Model edges projected into the sketch as fixed reference geometry. */
export interface ProjectionEntity {
  id: string;
  type: "projection";
  edges: EdgeSelector[];
  construction?: boolean;
}
export type SketchEntity = PointEntity | LineEntity | CircleEntity | ArcEntity | ProjectionEntity;

/** Point reference: a point entity id, "origin", or a curve's characteristic point like "l1.p1", "c1.center". */
export type PointRef = string;

export type SketchConstraint =
  | { id: string; type: "coincident"; a: PointRef; b: PointRef }
  | { id: string; type: "horizontal" | "vertical"; line: string }
  | { id: string; type: "horizontal_points" | "vertical_points"; a: PointRef; b: PointRef }
  | { id: string; type: "parallel" | "perpendicular" | "collinear"; a: string; b: string }
  | { id: string; type: "tangent"; a: string; b: string }
  | { id: string; type: "equal"; a: string; b: string }
  | { id: string; type: "point_on"; point: PointRef; curve: string }
  | { id: string; type: "midpoint"; point: PointRef; line: string }
  | { id: string; type: "symmetric"; a: PointRef; b: PointRef; axis: string }
  | { id: string; type: "fix"; point: PointRef }
  | { id: string; type: "distance"; a: PointRef; b: PointRef | string; value: Expr; axis?: "x" | "y"; label?: [number, number] }
  | { id: string; type: "length"; line: string; value: Expr; label?: [number, number] }
  | { id: string; type: "radius" | "diameter"; curve: string; value: Expr; label?: [number, number] }
  | { id: string; type: "angle"; a: string; b: string; value: Expr; label?: [number, number] }
  /** How far an arc sweeps from its start to its end (counter-clockwise), in degrees. */
  | { id: string; type: "arc_angle"; curve: string; value: Expr; label?: [number, number] };

export type ConstraintType = SketchConstraint["type"];

// ---------------------------------------------------------------- features

interface FeatureBase {
  id: string;
  /** Display name; defaults to the id. */
  name?: string;
  suppressed?: boolean;
}

export interface SketchFeature extends FeatureBase {
  op: "sketch";
  plane: PlaneSpec;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

export interface PlaneFeature extends FeatureBase {
  op: "plane";
  base: PlaneSpec;
  offset: Expr;
  /** Rotation about the base plane's u axis, degrees. */
  angle?: Expr;
}

/**
 * Profile of an extrude/revolve: sketch regions (`"all"` takes regions at odd nesting depth, so
 * circles inside a rectangle become holes), or a model face (push/pull; flat or curved).
 */
export type ProfileRef = { sketch: string; regions?: "all" | string[] } | { face: FaceSelector };

export type BooleanMode = "new_body" | "join" | "cut" | "intersect";

export interface ExtrudeFeature extends FeatureBase {
  op: "extrude";
  profile: ProfileRef;
  extent: "blind" | "symmetric" | "two_sided" | "through_all";
  distance: Expr;
  /** Second side for `two_sided`. */
  distance2?: Expr;
  flip?: boolean;
  mode: BooleanMode;
  /** Bodies a join/cut/intersect applies to; default all bodies the tool touches. */
  targets?: string[];
}

export interface RevolveFeature extends FeatureBase {
  op: "revolve";
  profile: ProfileRef;
  axis: AxisRef;
  angle: Expr;
  symmetric?: boolean;
  mode: BooleanMode;
  targets?: string[];
}

export interface FilletFeature extends FeatureBase {
  op: "fillet";
  edges: EdgeSelector | EdgeSelector[];
  radius: Expr;
}

export interface ChamferFeature extends FeatureBase {
  op: "chamfer";
  edges: EdgeSelector | EdgeSelector[];
  distance: Expr;
}

export interface ShellFeature extends FeatureBase {
  op: "shell";
  /** Faces to remove (open). Empty = hollow closed solid. */
  faces: FaceSelector[];
  thickness: Expr;
  outward?: boolean;
}

/**
 * ISO metric thread on a cylindrical face: a hole gets an internal thread, a shaft an external one.
 * The thread is modelled (real geometry), sized to the standard whatever diameter was drawn.
 */
export interface ThreadFeature extends FeatureBase {
  op: "thread";
  face: FaceSelector;
  /** Designation such as "M8"; omitted = picked from the cylinder's diameter. */
  size?: string;
  /** Pitch in mm; omitted = the standard coarse pitch of the size. */
  pitch?: Expr;
  /** Threaded length from the open end; omitted = the whole face. */
  length?: Expr;
  /** Extra room per side for printed fits: internal threads grow, external ones shrink. */
  clearance?: Expr;
  leftHanded?: boolean;
}

/**
 * Involute gear, ring gear or rack built from its parameters (ISO 21771 notation). It sits on a
 * plane with its axis along the plane's normal; `meshWith` places it in mesh with an earlier gear.
 */
export interface GearFeature extends FeatureBase {
  op: "gear";
  kind: "spur" | "internal" | "rack";
  /** Normal module, mm. Taken from the partner with `meshWith`. */
  module?: Expr;
  /** Number of teeth (rack: teeth along its length). */
  teeth: Expr;
  /** Face width along the axis. */
  width: Expr;
  /** Degrees, default 20. Taken from the partner with `meshWith`. */
  pressureAngle?: Expr;
  /** Profile shift coefficient x (spur gears), default 0. */
  profileShift?: Expr;
  /** Helix angle in degrees, + right hand, − left hand; default 0. With `meshWith`, follows the partner. */
  helix?: Expr;
  herringbone?: boolean;
  /** Circumferential backlash of the pair, mm, default 0.15; each gear takes half. */
  backlash?: Expr;
  /** Tip clearance factor c*, default 0.25. */
  clearance?: Expr;
  /** Default origin.XY. Taken from the partner with `meshWith`. */
  plane?: PlaneSpec;
  /** Centre in plane coordinates (rack: middle of its pitch line). Ignored with `meshWith`. */
  center?: [Expr, Expr];
  /** Turn about the axis, degrees: where tooth 1 points (rack: direction of its length). */
  rotation?: Expr;
  /** Mesh with an earlier gear: `direction` (degrees) is the line from its centre to this one. */
  meshWith?: { gear: string; direction?: Expr };
  /** Ring gear: outside diameter. Rack: height of its back below the teeth. */
  rim?: Expr;
  /** Bore through the gear; `allowance` is added for printed fits; `flat` = across the flat (d_flat). */
  bore?: { diameter: Expr; allowance?: Expr; shape?: "round" | "d_flat" | "hex"; flat?: Expr };
  hub?: { diameter: Expr; length: Expr; side?: "front" | "back" | "both" };
  mode: BooleanMode;
  targets?: string[];
}

/** What a pattern or mirror copies: the geometry added/removed by features, or whole bodies. */
export type PatternSource = { features: string[] } | { bodies: string[] };

export interface LinearPatternFeature extends FeatureBase {
  op: "linear_pattern";
  source: PatternSource;
  direction: AxisRef;
  count: Expr;
  spacing: Expr;
  direction2?: AxisRef;
  count2?: Expr;
  spacing2?: Expr;
}

export interface CircularPatternFeature extends FeatureBase {
  op: "circular_pattern";
  source: PatternSource;
  axis: AxisRef;
  count: Expr;
  /** Total angle in degrees (default 360, spread evenly). */
  angle?: Expr;
}

export interface MirrorFeature extends FeatureBase {
  op: "mirror";
  source: PatternSource;
  plane: PlaneSpec;
}

export interface BooleanFeature extends FeatureBase {
  op: "boolean";
  operation: "union" | "subtract" | "intersect";
  target: string;
  tools: string[];
  keepTools?: boolean;
}

/** Moves (or copies) whole bodies: rotation about an axis, then translation. */
export interface TransformFeature extends FeatureBase {
  op: "transform";
  bodies: string[];
  translate?: [Expr, Expr, Expr];
  rotate?: { axis: AxisRef; angle: Expr };
  copy?: boolean;
}

/** Removes parts from the model from this point on (earlier features still see them). */
export interface DeleteFeature extends FeatureBase {
  op: "delete";
  bodies: string[];
}

export interface ImportFeature extends FeatureBase {
  op: "import";
  format: "step" | "stl";
  fileName: string;
  /** Base64 file contents. */
  data: string;
}

export type Feature =
  | SketchFeature
  | PlaneFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | ThreadFeature
  | GearFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | MirrorFeature
  | BooleanFeature
  | TransformFeature
  | DeleteFeature
  | ImportFeature;
export type FeatureOp = Feature["op"];

// ---------------------------------------------------------------- selectors

/**
 * Face tags are names assigned by the feature that created a face, e.g. `ex1.end_cap` or
 * `ex1.side[sk1.l1]`. A tag ending in `[*]` matches every tag with that prefix.
 */
export type FaceTag = string;
export type Vec3 = [number, number, number];
export type Direction = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

export interface FaceFilter {
  planar?: boolean;
  normal?: Direction;
}

export type FaceSelector =
  /** Faces carrying a tag; `near` picks the closest one when the tag is shared by several faces. */
  | { face: FaceTag; near?: Vec3 }
  | { select: "faces"; of?: string; where?: FaceFilter & { tag?: FaceTag }; pick?: "largest" | "smallest" };

export type EdgeSelector =
  /** The edge shared by two tagged faces; `near` disambiguates when several edges qualify. */
  | { edge: [FaceTag, FaceTag]; near?: Vec3 }
  /** All edges bounding faces matching `where.face` (relative to `of` when it has no dot). */
  | { select: "edges"; of?: string; where?: { face?: FaceTag } };

export type LengthUnit = "mm" | "in";

export interface MeercadDocument {
  format: typeof FORMAT;
  /** Named user parameters, e.g. `{ wall: "2 mm", width: "wall * 10" }`. */
  params: Record<string, Expr>;
  /** Parameters an assistant created (listed apart from the user's own). */
  autoParams?: string[];
  /** Order of parts in the parts list (body ids; parts not listed follow in model order). */
  partOrder?: string[];
  /** Named folders of parts in the parts list. */
  partGroups?: { name: string; parts: string[] }[];
  /**
   * Unit lengths are shown and typed in (default mm). Bare numbers in the file are always
   * millimetres; an inch design stores typed values with their unit, e.g. "2 in".
   */
  units?: LengthUnit;
  features: Feature[];
  /** Id of the last feature that is evaluated, or null for all. */
  rollback: string | null;
}

/** Operations-API: the only way UI, AI, scripting and MCP change a document. */
export type DocOp =
  | { type: "add_features"; features: Feature[]; after?: string | null }
  | { type: "edit_feature"; id: string; patch: Record<string, unknown> }
  | { type: "delete_feature"; id: string }
  | { type: "move_feature"; id: string; after: string | null }
  /** `auto`: true marks it as created by an assistant, false as the user's own; omitted keeps it. */
  | { type: "set_param"; name: string; expr: Expr | null; auto?: boolean }
  | { type: "rename_param"; name: string; to: string }
  | { type: "set_rollback"; id: string | null }
  | { type: "replace"; doc: MeercadDocument };

export function emptyDocument(): MeercadDocument {
  return { format: FORMAT, params: {}, features: [], rollback: null };
}

export const ORIGIN_PLANES = ["origin.XY", "origin.XZ", "origin.YZ"] as const;
