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
/**
 * A smooth curve through points, in order (`closed` joins the last to the first). The points are
 * ordinary sketch points, so they can be dimensioned and constrained; the curve is a centripetal
 * Catmull-Rom spline through them (no overshoot, no loops), a smooth B-spline in the model.
 */
export interface SplineEntity {
  id: string;
  type: "spline";
  points: string[];
  closed?: boolean;
  construction?: boolean;
}
/** Model edges projected into the sketch as fixed reference geometry. */
export interface ProjectionEntity {
  id: string;
  type: "projection";
  edges: EdgeSelector[];
  construction?: boolean;
}
export type SketchEntity = PointEntity | LineEntity | CircleEntity | ArcEntity | SplineEntity | ProjectionEntity;

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
  /** Variable rounding: the radius at the edge's other end; it changes smoothly along the edge. */
  radius2?: Expr;
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
  /** 45° chamfer of the tooth tips at both ends, mm (spur and ring gears). */
  chamfer?: Expr;
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

/**
 * Moves a part so that one of its faces mates with a face of another part (flat faces: they touch,
 * facing each other; `flip` makes them face the same way, flush) or so that a round face's axis
 * lines up with another's (a shaft in a hole, a screw in its hole). `offset` leaves a gap along the
 * target's normal or axis; `angle` turns the part about it afterwards.
 */
export interface AlignFeature extends FeatureBase {
  op: "align";
  /** Parts to move; default the part `from` belongs to. */
  bodies?: string[];
  from: { face: FaceSelector } | { axisOf: FaceSelector };
  to: { face: FaceSelector } | { axisOf: FaceSelector };
  offset?: Expr;
  angle?: Expr;
  flip?: boolean;
}

/**
 * Scales parts uniformly, e.g. to correct a scan to a measured size (factor = wanted ÷ measured) or
 * to make a part larger. About each part's centre (its box's middle), or the origin.
 */
export interface ScaleFeature extends FeatureBase {
  op: "scale";
  bodies: string[];
  factor: Expr;
  center?: "part" | "origin";
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
  /** STEP files with several solids: each becomes its own part (ids im1, im1_2, …) instead of one. */
  split?: boolean;
}

/**
 * A solid through two or more profiles, in order: a funnel, an adapter from round to square. Each
 * profile is one closed sketch region (a whole sketch with one region, or a picked region) or a flat
 * model face, so a loft can start on a part. Profiles with holes give a hollow loft when they all
 * have the same number of holes.
 */
export interface LoftFeature extends FeatureBase {
  op: "loft";
  profiles: ProfileRef[];
  /** Straight faces between the profiles instead of a smooth transition. */
  ruled?: boolean;
  mode: BooleanMode;
  targets?: string[];
}

/**
 * A sketch profile moved along a path: pipes, cable ducts, handles. The path is a chain of lines and
 * arcs in a sketch (all its non-construction curves, or the listed ones), usually on a plane across
 * the profile's, starting in the profile.
 */
export interface SweepFeature extends FeatureBase {
  op: "sweep";
  profile: ProfileRef;
  path: { sketch: string; curves?: string[] };
  mode: BooleanMode;
  targets?: string[];
}

/**
 * Standard parts placed on a flat face (or a plane) at points in its coordinates: socket head cap
 * and hex head screws (ISO 4762, ISO 4017; the head stands on the face, the shank goes in),
 * countersunk screws (ISO 10642), set screws (ISO 4026) and heat-set inserts (flush in the face),
 * hex nuts (ISO 4032), washers (ISO 7089), ball bearings and round magnets (standing on the face). Each point gives its own
 * part (ids sp1, sp1_2, …). `flip` turns them the other way.
 */
export interface StandardPartFeature extends FeatureBase {
  op: "standard_part";
  kind: "socket_screw" | "countersunk_screw" | "hex_screw" | "set_screw" | "hex_nut" | "washer" | "insert" | "bearing" | "magnet";
  /** "M3" for screws, nuts and washers, "608" for bearings. */
  size?: string;
  /** Screw length: under the head; countersunk screws and set screws overall. */
  length?: Expr;
  /** Magnets. */
  diameter?: Expr;
  height?: Expr;
  plane: PlaneSpec;
  points: [Expr, Expr][];
  flip?: boolean;
}

/**
 * Text on a plane or a flat face, raised (`join`, embossed) or cut in (`cut`, engraved). The text
 * starts at `position` in the plane's coordinates; `size` is the height of capital letters; new
 * lines (\n) go downwards. Raised text grows along the plane's normal, engraved text goes against it
 * (`flip` reverses either).
 */
export interface TextFeature extends FeatureBase {
  op: "text";
  plane: PlaneSpec;
  text: string;
  position?: [Expr, Expr];
  size: Expr;
  /** Rotation in the plane, degrees counter-clockwise. */
  angle?: Expr;
  font?: "sans" | "sans-bold" | "mono";
  align?: "left" | "center" | "right";
  depth: Expr;
  mode: BooleanMode;
  targets?: string[];
  flip?: boolean;
}

/**
 * Draft for cast and moulded parts: tilts side faces by an angle so the part comes out of its
 * mould. The faces keep their line on the neutral plane (usually the parting face or the bottom)
 * and lean inwards along the pull direction (the neutral plane's normal; `flip` reverses it).
 */
export interface DraftFeature extends FeatureBase {
  op: "draft";
  faces: FaceSelector[];
  /** Draft angle in degrees, typically 1–5. */
  angle: Expr;
  neutral: PlaneSpec;
  flip?: boolean;
}

/**
 * Faces moved along their normals: out of the material for a positive distance (the part grows
 * there), into it for a negative one. With `upTo`, flat faces move onto that plane instead (they
 * must be parallel to it) and `distance` is the gap left before it. Works on curved faces too, e.g.
 * a hole wall moved in makes the hole tighter.
 */
export interface OffsetFaceFeature extends FeatureBase {
  op: "offset_face";
  faces: FaceSelector[];
  distance: Expr;
  upTo?: PlaneSpec;
}

/**
 * A stiffening rib from open lines in a sketch: each line is thickened across the sketch plane and
 * filled from the line to the part's walls (in the sketch plane, at right angles to the line), so
 * a line drawn across a corner or between two walls becomes a web joining them.
 */
export interface RibFeature extends FeatureBase {
  op: "rib";
  /** The sketch with the rib lines: all its non-construction lines, or the listed ones. */
  sketch: string;
  curves?: string[];
  /** Rib thickness, centred on the sketch plane. */
  thickness: Expr;
  /** Fill towards the other side of the line. */
  flip?: boolean;
}

/**
 * Cuts parts in two at a plane or a flat face, e.g. a part too large for the printer. The piece on
 * the side the plane's normal points to keeps the part's id, the other becomes a new part named after
 * the step (`sp1`, or `sp1_<part>` when several parts are split). `keep` drops one side instead.
 */
export interface SplitFeature extends FeatureBase {
  op: "split";
  plane: PlaneSpec;
  /** Parts to split; empty = every part the plane crosses. */
  bodies: string[];
  /** "both" (default), or only the piece in front of the plane (along its normal) or behind it. */
  keep?: "both" | "front" | "back";
}

/**
 * Holes for screws, threads and inserts, drilled into a flat face (or a plane) at points in its
 * coordinates, against its normal. Sizes follow the standards for metric screws (see model/holes.ts).
 */
export interface HoleFeature extends FeatureBase {
  op: "hole";
  /** The face or plane the holes start on; they go in against its normal (`flip` reverses). */
  plane: PlaneSpec;
  /** Hole centres in the plane's coordinates. */
  points: [Expr, Expr][];
  /** simple: a plain bore of `diameter`; clearance/counterbore/countersink: for a screw of `size`; tapped: threaded; insert: for a heat-set insert. */
  kind: "simple" | "clearance" | "counterbore" | "countersink" | "tapped" | "insert";
  /** Screw size such as "M3" (all kinds but simple). */
  size?: string;
  diameter?: Expr;
  /** Clearance hole series (ISO 273), default normal. */
  fit?: "close" | "normal" | "loose";
  /** Bore depth; omitted = through all (inserts: the insert's length + 1 mm). */
  depth?: Expr;
  /** Added to every diameter for printed parts, mm. */
  allowance?: Expr;
  flip?: boolean;
}

/**
 * Replaces a part made from an imported mesh by a solid with real faces: planes, cylinders, cones
 * and spheres recognised in the triangles become editable faces; triangles that match no surface
 * stay flat facets. The part keeps its id.
 */
export interface MeshConvertFeature extends FeatureBase {
  op: "mesh_convert";
  /** The mesh part (the id of its import feature). */
  body: string;
  /** Largest distance (mm) between the mesh's vertices and a recognised surface; default from the part's size. */
  tolerance?: Expr;
  /** Angle (degrees) between neighbouring triangles above which they belong to different curved surfaces; default 30. */
  angle?: Expr;
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
  | HoleFeature
  | LoftFeature
  | SplitFeature
  | RibFeature
  | DraftFeature
  | OffsetFaceFeature
  | TextFeature
  | StandardPartFeature
  | AlignFeature
  | ScaleFeature
  | SweepFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | MirrorFeature
  | BooleanFeature
  | TransformFeature
  | DeleteFeature
  | ImportFeature
  | MeshConvertFeature;
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

// ---------------------------------------------------------------- mechanism

/** Where a joint's axis sits; resolved after every rebuild, so it follows parameter changes. */
export type JointAnchor =
  /** Round face (hole, shaft): its axis, through the middle of the face. */
  | { axisOf: FaceSelector }
  /** Straight edge: its direction through its middle; round edge: the circle's axis through its centre. */
  | { edge: EdgeSelector }
  /** An origin axis. */
  | { axis: { ref: "origin.X" | "origin.Y" | "origin.Z" } }
  /** A gear feature: its axis (a rack: the direction along its length). */
  | { gear: string };

/**
 * A joint lets part `a` move relative to part `b` (or stay on the ground) from where it was
 * modelled: revolute turns about the axis (degrees), slider moves along it (mm), cylindrical does
 * both (a pin in a guide, a telescope), fixed holds it.
 */
export interface Joint {
  id: string;
  name?: string;
  type: "revolute" | "slider" | "cylindrical" | "fixed";
  /** Moving part (body id). */
  a: string;
  /** Part it hangs on (body id), or "ground". */
  b: string;
  anchor: JointAnchor;
  /** Lowest and highest value (degrees or mm; a cylindrical joint's turn); none = free. */
  limits?: [Expr, Expr];
  /** A cylindrical joint's lowest and highest slide along the axis (mm); none = free. */
  travel?: [Expr, Expr];
  suppressed?: boolean;
}

/** Drives one joint from another: driven value = ratio × driver value (gears, racks, belts). */
export interface Coupling {
  id: string;
  name?: string;
  driver: string;
  driven: string;
  /** Unit of driven per unit of driver (deg/deg, or mm/deg for a rack). */
  ratio: Expr;
}

/** Moving parts. The modelled position is the rest position; joints say how parts move from it. */
export interface Mechanism {
  joints: Joint[];
  couplings?: Coupling[];
  /** Smallest wanted gap between jointed parts for print-in-place, mm (default 0.3). */
  clearance?: Expr;
}

export type LengthUnit = "mm" | "in";

/**
 * A textured model to look at and design against, not a part: a landscape or building made from
 * photos. Millimetres, Z up; one made from photos with GPS has east along +X and north along +Y.
 */
export interface ReferenceModel {
  id: string;
  name: string;
  format: "glb";
  /** Base64 file contents (in a version: a key into the document's `blobs`). */
  data: string;
  hidden?: boolean;
  /** Where the model's origin is on Earth (degrees, metres above sea level), when its photos had GPS. */
  geo?: { lat: number; lon: number; alt: number };
}

export interface MeercadDocument {
  format: typeof FORMAT;
  /** Named user parameters, e.g. `{ wall: "2 mm", width: "wall * 10" }`. */
  params: Record<string, Expr>;
  /** Parameters an assistant created (listed apart from the user's own). */
  autoParams?: string[];
  /** Order of parts in the parts list (body ids; parts not listed follow in model order). */
  partOrder?: string[];
  /** Colours the user gave parts ("#rrggbb" by body id); other parts are coloured automatically. */
  partColors?: Record<string, string>;
  /** Parts drawn see-through, as a reference to model against (a scan, for instance). */
  seeThrough?: string[];
  /** Materials of parts (material id from the list in model/materials, by body id): mass and weight. */
  partMaterials?: Record<string, string>;
  /** Named folders of parts in the parts list. */
  partGroups?: { name: string; parts: string[] }[];
  /**
   * Unit lengths are shown and typed in (default mm). Bare numbers in the file are always
   * millimetres; an inch design stores typed values with their unit, e.g. "2 in".
   */
  units?: LengthUnit;
  features: Feature[];
  /** Joints between parts; moving them never changes the model. */
  mechanism?: Mechanism;
  /** Models shown with the design but not built into it: an area flown over with a drone, say. */
  references?: ReferenceModel[];
  /**
   * Named sets of parameter values, e.g. one holder for three pipe sizes. The variant in use
   * (`variant`) replaces the values of the parameters it lists; the others keep theirs.
   */
  variants?: Variant[];
  /** Name of the variant in use; absent: the values in `params`. */
  variant?: string;
  /** Named states of the design saved by the user, oldest first; restoring one makes it the design again. */
  versions?: Version[];
  /**
   * Large file contents (imported files) the versions refer to by key ("blob:…"), each kept once
   * however many versions share it.
   */
  blobs?: Record<string, string>;
  /** Id of the last feature that is evaluated, or null for all. */
  rollback: string | null;
}

/** A saved state of the design: everything but the file's own bookkeeping (format, versions, blobs). */
export type VersionState = Omit<MeercadDocument, "format" | "versions" | "blobs">;

export interface Version {
  name: string;
  /** When it was saved, in milliseconds since 1970. */
  at: number;
  /** The design as it was; imported files' contents are keys into the document's `blobs`. */
  state: VersionState;
}

export interface Variant {
  name: string;
  /** Values for some of the document's parameters. */
  params: Record<string, Expr>;
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
  /** Adds a joint or replaces the one with the same id. */
  | { type: "set_joint"; joint: Joint }
  | { type: "delete_joint"; id: string }
  | { type: "set_coupling"; coupling: Coupling }
  | { type: "delete_coupling"; id: string }
  /** Adds a reference model or replaces the one with the same id. */
  | { type: "set_reference"; reference: ReferenceModel }
  | { type: "delete_reference"; id: string }
  /** A part's material (an id from model/materials such as "petg"), or null for none. */
  | { type: "set_material"; part: string; material: string | null }
  /** Adds a variant or replaces the one with that name (`rename` gives it a new name). */
  | { type: "set_variant"; name: string; params: Record<string, Expr>; rename?: string }
  | { type: "delete_variant"; name: string }
  /** Puts a variant in use, or null for the values in `params`. */
  | { type: "use_variant"; name: string | null }
  /** Saves the design as it is now under a name (replacing a version of that name). */
  | { type: "save_version"; name: string }
  /** Makes a saved version the design again; the versions themselves stay. */
  | { type: "restore_version"; name: string }
  | { type: "rename_version"; name: string; to: string }
  | { type: "delete_version"; name: string }
  | { type: "replace"; doc: MeercadDocument };

export function emptyDocument(): MeercadDocument {
  return { format: FORMAT, params: {}, features: [], rollback: null };
}

export const ORIGIN_PLANES = ["origin.XY", "origin.XZ", "origin.YZ"] as const;
