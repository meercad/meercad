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
  /** Thread form, default ISO metric. The other forms take the drawn diameter (or `diameter`). */
  profile?: ThreadProfile;
  /** Nominal (major) diameter for a thread that is not a standard size; default the drawn one. */
  diameter?: Expr;
  /** Number of starts (1–8), e.g. 2–4 for bottle caps and fast lids; the lead is starts × pitch. */
  starts?: Expr;
}

/**
 * Thread forms: ISO metric (60°), trapezoidal (ISO 2904), square, buttress (ISO 3030) and round
 * (knuckle, for lids and printed threads).
 */
export type ThreadProfile = "iso" | "trapezoid" | "square" | "buttress" | "round";

/**
 * Coil (helix): a sketch profile swept along a helix round an axis, like a thread, a spring of any
 * cross-section, a worm or a spiral ramp. The helix starts where the profile is, at its distance
 * from the axis, and climbs `pitch` per turn along the axis direction (`flip` the other way);
 * `taper` (degrees) widens (+) or narrows (−) it into a cone.
 */
export interface CoilFeature extends FeatureBase {
  op: "coil";
  profile: ProfileRef;
  axis: AxisRef;
  /** Rise per turn, mm. */
  pitch: Expr;
  /** Number of turns, may be fractional. */
  turns: Expr;
  taper?: Expr;
  leftHanded?: boolean;
  flip?: boolean;
  mode: BooleanMode;
  targets?: string[];
}

/**
 * Coil spring from its spec: compression (ends closed and ground flat by default), extension (close
 * wound with a loop at each end) or torsion (close wound with two straight legs). It stands on a
 * plane at `center`, its axis along the plane's normal.
 */
export interface SpringFeature extends FeatureBase {
  op: "spring";
  kind: "compression" | "extension" | "torsion";
  /** Wire diameter, mm. */
  wire: Expr;
  /** Outside diameter of the coils, mm. */
  diameter: Expr;
  /** Active (springing) coils; fractional values turn a torsion spring's second leg. */
  coils: Expr;
  /** Compression: free length, mm (default 3 × diameter). */
  length?: Expr;
  /** Compression spring ends: open, closed (the last turn touches the next) or closed and ground flat (default). */
  ends?: "open" | "closed" | "ground";
  /** Extension and torsion: gap between neighbouring coils, mm (default 0.3, so printed coils stay apart). */
  gap?: Expr;
  /** Torsion: length of each leg from the coil, mm (default the outside diameter). */
  legs?: Expr;
  leftHanded?: boolean;
  /** Default origin.XY. */
  plane?: PlaneSpec;
  /** Centre in plane coordinates. */
  center?: [Expr, Expr];
  mode: BooleanMode;
  targets?: string[];
}

/**
 * A screw, threaded rod or nut of any size and thread form, standing on a plane at `center` (screws
 * head down, the shank up along the plane's normal). Head sizes follow the diameter (hex heads like
 * ISO 4017, socket heads like ISO 4762). A screw and a nut with the same thread fit each other;
 * `clearance` makes room for printing (the screw's thread shrinks, the nut's grows).
 */
export interface ScrewFeature extends FeatureBase {
  op: "screw";
  kind: "screw" | "nut";
  /** Screws: hex, socket (cylinder with hex socket), round (button), knob (ribbed thumb head) or none (threaded rod). Nuts: hex, round or knob. Default hex. */
  head?: "hex" | "socket" | "round" | "knob" | "none";
  profile?: ThreadProfile;
  /** Nominal (major) diameter, mm. */
  diameter: Expr;
  /** Default the form's usual pitch (ISO coarse, trapezoidal ISO 2904). */
  pitch?: Expr;
  starts?: Expr;
  /** Screws: shank length under the head; nuts: height (default 0.8 × diameter). */
  length?: Expr;
  /** Screws: threaded length from the tip (default the whole shank). */
  threadLength?: Expr;
  clearance?: Expr;
  leftHanded?: boolean;
  plane?: PlaneSpec;
  center?: [Expr, Expr];
  mode: BooleanMode;
  targets?: string[];
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
  /** A mesh's picture (a scan's colours), shown on the part and exported with OBJ. */
  texture?: MeshTexture;
}

/**
 * The picture laid on an imported mesh. Only the look: the part is built from `data` alone. It
 * follows the part when moved, copied or patterned; after cutting or combining the part is plain.
 */
export interface MeshTexture {
  /** Base64 picture (in a version: a key into the document's `blobs`). */
  image: string;
  mime: "image/jpeg" | "image/png";
  /**
   * Base64 little-endian float32 pairs, one per triangle corner of `data` in file order, glTF
   * convention (v runs down the picture). Base64 too, or a blob key in a version.
   */
  uvs: string;
  /** Shown plain (without the picture) and exported without it. */
  hidden?: boolean;
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
  kind: "socket_screw" | "countersunk_screw" | "hex_screw" | "set_screw" | "hex_nut" | "washer" | "insert" | "bearing" | "magnet" | "profile" | "corner_bracket" | "t_nut" | "linear_bearing" | "shaft" | "lead_screw" | "rail";
  /**
   * "M3" for screws, nuts and washers, "608" for bearings; "2020" for aluminium profiles and their
   * corner brackets, "M5-8" for T-nuts (thread, slot), "LM8UU", "8" for shafts, "Tr8x8" lead
   * screws, "MGN12" linear rails.
   */
  size?: string;
  /** Screw length (under the head; countersunk and set screws overall); profiles, shafts, lead screws and rails: their length. */
  length?: Expr;
  /** Lead screws: with their flanged nut; rails: with a carriage. The app joins them so they move (slider, and the nut coupled to the screw's turning). */
  withMoving?: boolean;
  /** Rails and brackets lie on the face along its u axis; this turns them in the plane, degrees. */
  angle?: Expr;
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
 * Gridfinity storage on the open 42 mm grid (7 mm height units): a bin or a baseplate built from its
 * sizes, as an ordinary part that later features can fillet, cut or write on. The part's id is the
 * feature id; it stands on the plane (default origin.XY) centred on `position`.
 *
 * Bin: `units` cells wide and deep, `height` units tall (the stacking lip stands 4.4 mm above), one
 * foot per cell, hollow with `wall` thick walls unless `solid`, `dividers` walls across x and y,
 * a `scoop` (finger slide, radius) at the front of each compartment and a label `tab` at its back.
 * `baseplate` puts the bin into an earlier baseplate at `cell` (its lower-left cell, from 0).
 * Baseplate: `units` cells, or as many as fit a `drawer` (width, depth) or a closed sketch `outline`
 * (any shape, on the sketch's plane), the rest of the area filled with a solid border (`fill: false`
 * leaves it empty). With `bed` the
 * baseplate comes apart along the lines between cells into pieces that each fit the print bed
 * (parts `gf1_A1`, `gf1_A2`, … rows A, B, … from the front, columns from the left), borders included.
 * `magnets` / `screws` add the holes of the standard in the bin's feet or the baseplate's cells.
 * `pocket` makes a solid bin with a nest for a part (e.g. a 3D scan): the part sinks into the bin's top
 * by `sink` of its height, with `clearance` play all round, optionally with a finger `grip` groove
 * across it. Without `units` and `height` the bin takes the fewest cells and height units that hold
 * it, turned on its plane to fit best; it is built round the part where the part lies (`position`
 * is ignored), the bin's rim at the part's sinking line.
 * Faces: gf1.foot, gf1.floor, gf1.wall, gf1.inner, gf1.lip, gf1.top, gf1.divider, gf1.scoop,
 * gf1.tab (top of the label tabs), gf1.tab_under, gf1.pocket (baseplate), gf1.bottom, gf1.hole,
 * gf1.nest (a bin's nest for a part), gf1.grip.
 */
export interface GridfinityFeature extends FeatureBase {
  op: "gridfinity";
  kind: "bin" | "baseplate";
  /**
   * Grid cells along x and y (42 mm each). A baseplate with `drawer` takes as many as fit; a bin with
   * a `pocket` as few as hold the part when left out. Required otherwise.
   */
  units?: [Expr, Expr];
  /** Bin height in 7 mm units, default 3. */
  height?: Expr;
  /** Bin wall thickness, default 1.2 mm. */
  wall?: Expr;
  /**
   * Bin: height of the inside floor above the bottom, default 7 mm.
   * Baseplate: solid bottom below the pockets, default 0 (open grid), 3.4 mm with magnets or screws.
   */
  floor?: Expr;
  /** Number of divider walls across x (splitting the width) and across y. */
  dividers?: [Expr, Expr];
  /** Divider thickness, default the wall's. */
  dividerThickness?: Expr;
  /** Radius of the finger slide at the front (−y) of every compartment; absent or 0 = none. */
  scoop?: Expr;
  /** Label tab at the back (+y) of every compartment, its top flush with the rim. */
  tab?: { width?: Expr; angle?: Expr; style?: "full" | "left" | "center" | "right" };
  /** Stacking lip on top of the bin, default true. */
  lip?: boolean;
  /** A solid block instead of a hollow bin (to cut your own pockets). */
  solid?: boolean;
  magnets?: boolean;
  screws?: boolean;
  /** Magnet holes, default 6.5 mm × 2.4 mm. */
  magnetDiameter?: Expr;
  magnetDepth?: Expr;
  /** Baseplate: fill a drawer of this inside size (mm); the grid is centred, the rest is border. */
  drawer?: [Expr, Expr];
  /** Baseplate: fill this closed outline of a sketch (the plate lies on the sketch's plane). */
  outline?: { sketch: string; regions?: "all" | string[] };
  /** Baseplate in a drawer or outline: gap to its edge all round, default 0.5 mm. */
  gap?: Expr;
  /** Baseplate in a drawer or outline: fill the rest round the cells with a solid border (default true); false leaves it empty. */
  fill?: boolean;
  /** Baseplate: cut it into pieces for this print bed (see GridfinityBed). */
  bed?: GridfinityBed;
  /** Default origin.XY. With `baseplate`, the baseplate's plane. */
  plane?: PlaneSpec;
  /** Centre of the footprint in plane coordinates, default [0, 0]. Ignored with `baseplate`. */
  position?: [Expr, Expr];
  /** Bin: sit in this earlier baseplate (gridfinity feature id). */
  baseplate?: string;
  /** Bin in a baseplate: the baseplate cell under the bin's lower-left cell, from [0, 0]. */
  cell?: [Expr, Expr];
  /** Bin: a nest for a part in the bin's solid top (the bin is solid; dividers, scoop and tab are left out). */
  pocket?: GridfinityPocket;
}

/**
 * The nest for a part in a Gridfinity bin: the part's underside up to `sink` (percent of its height,
 * default 50) widened by `clearance` (mm, default 0.5) all round, open upwards so the part lifts
 * straight out. `grip` adds a finger groove across the part's middle.
 */
export interface GridfinityPocket {
  /** The part to hold (any part; usually an imported scan). Stays in the model, untouched. */
  body: string;
  sink?: Expr;
  clearance?: Expr;
  grip?: boolean;
}

/**
 * The print bed a baseplate is cut up for: its `size` (width, depth; 256 × 256 when made in the
 * app) less `margin`: mm that cannot be printed on across the width and across the depth (e.g.
 * [0, 20] for 2 cm at the back).
 */
export interface GridfinityBed {
  size: [Expr, Expr];
  margin?: [Expr, Expr];
}

/**
 * A printable box with a lid, built from its sizes: the box (part id = the feature id) and its lid
 * (`bx1_lid`) as two parts. `lid: "snap"` gives a plug lid whose lip clicks into a groove round the
 * inside of the rim (rectangular or round); `lid: "screw"` a round jar whose cap screws onto a
 * threaded neck. Sizes are outside sizes: `width` × `depth` (round: `width` is the diameter) and
 * `height` of the box without its lid. `clearance` is the play between box and lid per side.
 * With `layout: "beside"` (default) the lid lies upside down next to the box, ready to print;
 * `"closed"` puts it on the box. The box stands on the plane (default origin.XY) centred on `position`.
 * Faces: bx1.bottom, bx1.wall, bx1.inner, bx1.floor, bx1.rim, bx1.groove, bx1.notch, bx1.shoulder,
 * bx1.neck, bx1.thread; on the lid bx1.lid_top, bx1.lid_side, bx1.lid_under, bx1.lid_lip,
 * bx1.lid_bead, and on a cap bx1.lid_rim (the skirt's edge), bx1.lid_inner, bx1.lid_thread.
 */
export interface BoxFeature extends FeatureBase {
  op: "box";
  lid: "snap" | "screw";
  /** Default "rect" for snap lids; screw lids are always round. */
  shape?: "rect" | "round";
  /** Outside width (round: diameter), mm. */
  width: Expr;
  /** Outside depth (rectangular boxes), default the width. */
  depth?: Expr;
  /** Outside height of the box without the lid. */
  height: Expr;
  /** Wall thickness of box and lid, default 2 mm. */
  wall?: Expr;
  /** Bottom thickness, default the wall's. */
  floor?: Expr;
  /** Corner radius of a rectangular box (outside), default 4 mm. */
  corner?: Expr;
  /** Thickness of the lid's top, default the wall's. */
  lidThickness?: Expr;
  /** Play between box and lid per side, default 0.2 mm. */
  clearance?: Expr;
  /** Snap lid: how far the bead stands out of the lip (the snap's grip), default 0.5 mm. */
  snap?: Expr;
  /** Snap lid: how far the lip reaches into the box, default 6 mm. */
  lipHeight?: Expr;
  /** Screw lid: thread pitch, default 4 mm. */
  pitch?: Expr;
  /** Screw lid: height of the threaded neck (and the cap's skirt), default 12 mm. */
  neck?: Expr;
  /** Screw lid: number of thread starts (2 closes in half the turn), default 1. */
  starts?: Expr;
  /** A notch in the rim to lift a snap lid with a finger nail, default true. */
  notch?: boolean;
  layout?: "beside" | "closed";
  /** Default origin.XY. */
  plane?: PlaneSpec;
  /** Centre of the box's footprint in plane coordinates, default [0, 0]. */
  position?: [Expr, Expr];
}

/**
 * Cantilever snap hooks standing on a flat face (or a plane) at points in its coordinates: a beam
 * `length` tall, `thickness` thick and `width` wide with a barb at its tip that stands `overhang` out
 * towards `angle` (degrees in the plane from its u axis). The barb's lead-in slopes at `insertAngle`
 * (to the beam), its back at `retainAngle` (90: holds for good, 30–45: lets go when pulled hard).
 * `catchIn` cuts the window the barb clicks into (with `clearance`) into those parts, where the barb
 * sits; the window runs on through their wall. Hooks join the part they stand on (`mode`).
 * Faces: sh1.beam, sh1.back, sh1.lead (the lead-in slope), sh1.catch (the holding face), sh1.tip,
 * sh1.side, sh1.root; the window: sh1.window.
 */
export interface SnapHookFeature extends FeatureBase {
  op: "snap_hook";
  plane: PlaneSpec;
  points: [Expr, Expr][];
  /** Direction the barb points, degrees in the plane from its u axis, default 0. */
  angle?: Expr;
  /** Beam height above the face up to the barb's catch, default 10 mm. */
  length?: Expr;
  /** Beam thickness (in the bending direction), default 1.6 mm. */
  thickness?: Expr;
  /** Beam width, default 6 mm. */
  width?: Expr;
  /** How far the barb stands out (the deflection when it snaps), default 0.8 mm. */
  overhang?: Expr;
  /** Lead-in slope to the beam, degrees, default 30. */
  insertAngle?: Expr;
  /** Back of the barb to the beam, degrees: 90 holds for good, default 90. */
  retainAngle?: Expr;
  /** Play round the window cut by `catchIn`, default 0.2 mm. */
  clearance?: Expr;
  catchIn?: string[];
  /** Default join (onto the part under the face). */
  mode?: BooleanMode;
  targets?: string[];
  /** Hooks stand against the plane's normal instead. */
  flip?: boolean;
}

/**
 * Wall storage: a board to mount on the wall and holders that clip into it, built from the
 * published sizes of the open systems as ordinary parts. Everything is built flat for printing:
 * the board's back lies on the plane (default origin.XY), x across, y up the wall, its front
 * facing +z; `position` is the footprint's centre.
 *
 * `system` "opengrid": the openGrid board (28 mm cells; `variant` "full" 6.8 mm or "lite" 4 mm)
 * with countersunk `screws` at the crossings next to its corners, and holders on snaps (one per
 * cell they cover) that click into its openings.
 * `system` "pegboard": a perforated board with round or square holes (`grid` preset, or `pitch`,
 * `hole` and `thickness`) and holders whose pegs go through its holes, the top row hooking up
 * behind the board.
 *
 * Holder (`kind` "holder"): a back plate `plate` thick over `units` cells, with an `accessory`
 * in front: "plain" (just the plate), "hook" (an arm `depth` long, its tip rising `size`),
 * "ring" (a ring of inner diameter `size`, `depth` out from the plate, for tools hung through it),
 * "shelf" (a tray `depth` deep with a front lip `size` high), "bin" (a shelf with Gridfinity cells
 * for `size` bins of 42 mm, 1 cell deep) or "screw" (openGrid only: a bare snap with a
 * countersunk hole of diameter `size` to screw a full board to the wall).
 * `board` puts the holder on an earlier board at `cell` (its lower-left cell, from 0).
 * Faces: wl1.back, wl1.front, wl1.side, wl1.opening (board), wl1.hole, wl1.snap, wl1.peg,
 * wl1.plate, wl1.hook, wl1.ring, wl1.shelf.
 */
export interface WallFeature extends FeatureBase {
  op: "wall";
  system: "opengrid" | "pegboard";
  kind: "board" | "holder";
  /** Cells across (x) and up (y): 28 mm for openGrid, the hole pitch for a pegboard. */
  units: [Expr, Expr];
  /** openGrid thickness: "full" 6.8 mm (default) or "lite" 4 mm. */
  variant?: "full" | "lite";
  /** openGrid board: countersunk screw holes at the crossings one cell in from each corner. */
  screws?: boolean;
  /**
   * Pegboard hole pattern: "us_quarter" (1" pitch, 7.1 mm holes, 6.35 mm board, default),
   * "us_eighth" (1", 4.8 mm, 3.2 mm), "metric_25" (25 mm, 5 mm, 3 mm),
   * "square_38" (38 mm, 10 × 10 mm square holes, 1.5 mm sheet).
   */
  grid?: "us_quarter" | "us_eighth" | "metric_25" | "square_38";
  /** Pegboard: hole pitch, hole size (diameter or square side) and board thickness, overriding the preset. */
  pitch?: Expr;
  hole?: Expr;
  thickness?: Expr;
  /** Holder: what sits on the back plate, default "hook". */
  accessory?: "plain" | "hook" | "ring" | "shelf" | "bin" | "screw";
  /** Holder: back plate thickness, default 3 mm (none for "screw"). */
  plate?: Expr;
  /** Holder: how far the hook, ring or shelf reaches out from the plate (mm). */
  depth?: Expr;
  /** Holder: hook tip rise, ring inner diameter, shelf lip height, number of bins, or screw diameter. */
  size?: Expr;
  /** Default origin.XY. With `board`, the board's plane. */
  plane?: PlaneSpec;
  /** Centre of the footprint in plane coordinates, default [0, 0]. Ignored with `board`. */
  position?: [Expr, Expr];
  /** Holder: mounted on this earlier board (wall feature id) of the same system. */
  board?: string;
  /** Holder on a board: the board cell under the holder's lower-left cell, from [0, 0]. */
  cell?: [Expr, Expr];
}

/** Symbols for printable labels, drawn as clean outlines: screws by head (side view), nuts, washers, inserts. */
export type LabelSymbol = "none" | "screw_pan" | "screw_countersunk" | "screw_socket" | "screw_hex" | "nut" | "washer" | "insert";

/**
 * A printable label: a rounded plate with a symbol on the left and text beside it, raised or
 * engraved. With `separate` the marking is its own part (`lb1_mark`), for a second colour: raised
 * marks stand on the plate, engraved ones fill the engraving flush (an inlay). The plate lies on
 * the plane (default origin.XY) centred on `position`; a Gridfinity bin's `gf1.tab` is a good face.
 * Faces: lb1.top, lb1.side, lb1.bottom, lb1.mark (the marking's top or the engraving's floor).
 */
export interface LabelFeature extends FeatureBase {
  op: "label";
  /** Plate size, default 36 × 11 mm (a 1-unit Gridfinity tab). */
  width?: Expr;
  height?: Expr;
  /** Plate thickness, default 1.2 mm. */
  thickness?: Expr;
  /** Corner radius, default 1 mm. */
  corner?: Expr;
  text?: string;
  symbol?: LabelSymbol;
  /** Capital-letter height; default: as large as fits. */
  size?: Expr;
  font?: "sans" | "sans-bold" | "mono";
  /** Default raised. */
  style?: "raised" | "engraved";
  /** Height of raised marks / depth of engraving, default 0.6 mm. */
  depth?: Expr;
  separate?: boolean;
  plane?: PlaneSpec;
  position?: [Expr, Expr];
  /** Rotation in the plane, degrees counter-clockwise. */
  angle?: Expr;
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
 * A greyscale height picture (a lithophane's picture): `width` × `height` bytes, row by row from the
 * top, 0 = low, 255 = high, base64 (in a version: a key into the document's `blobs`).
 */
export interface TextureImage {
  width: number;
  height: number;
  pixels: string;
}

/**
 * A picture made into a printable plate whose thickness follows the picture's brightness, built on
 * a displacement of the picture face's triangles: a lithophane (dark parts thick, bright parts thin; held
 * against light it shows the photo) or a relief (bright parts high, a picture you see by its
 * shadows). Flat, the plate lies on the plane (default origin.XY), centred on `position`, the
 * picture's top towards the plane's v; curved (`curve` > 0) it stands on the plane, bent round the
 * plane's normal through `position` by `curve` degrees (360: a closed lamp shade), the picture on
 * the outside. A frame keeps the full thickness round the picture. Only the
 * triangles carry the picture: STL, 3MF and OBJ export it; STEP, volume and mass see the plain
 * plate at `thickness`. Faces: li1.picture, li1.back, li1.frame (frame top), li1.side.
 */
export interface LithophaneFeature extends FeatureBase {
  op: "lithophane";
  /** "lithophane" (default): dark = thick; "relief": bright = high. */
  kind?: "lithophane" | "relief";
  image: TextureImage;
  /** Width of the picture, mm (round a curve: along the picture side); its height follows the picture. */
  width: Expr;
  /** Thinnest place (lithophane) or base plate (relief), mm; default 0.8 or 1.6. */
  thickness?: Expr;
  /** Thickness the picture adds at its darkest (lithophane) or brightest (relief) place, mm; default 2.2 or 1.6. */
  depth?: Expr;
  /** Frame width round the picture at the full thickness, mm; default 0 (a curve of 360: only top and bottom). */
  frame?: Expr;
  /** Bend round the plane's normal, degrees: 0 flat (default), up to 360 (closed round). */
  curve?: Expr;
  /** Swaps dark and bright. */
  invert?: boolean;
  plane?: PlaneSpec;
  position?: [Expr, Expr];
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
  /** Connectors at the cut so the pieces go back together in one place (only with keep "both"). */
  connectors?: SplitConnectors;
}

/**
 * How the pieces of a split hold together. `pins`: pegs grow out of the front piece into holes in the
 * back piece. `dowels`: holes in both pieces and loose dowels as extra parts (`sp1_dowel1`, …), or
 * for bought dowel pins. `dovetail`: a dovetail tongue on the front piece runs across the cut, and
 * the back piece slides onto it sideways. Holes and slots are `clearance` larger on every side.
 */
export interface SplitConnectors {
  kind: "pins" | "dowels" | "dovetail";
  /** Pin or dowel diameter; for a dovetail its width at the cut. Default: from the size of the cut. */
  size?: Expr;
  /** How far a pin or tongue reaches into the other piece (dowels: their whole length). Default: from size. */
  depth?: Expr;
  /** Gap on every side between a connector and its hole (default 0.2 mm). */
  clearance?: Expr;
  /** Pins or dowels per cut face when placed automatically (default 2, or 1 on a small cut). */
  count?: Expr;
  /** Pin or dowel centres in the plane's coordinates, instead of automatic placement. */
  points?: [Expr, Expr][];
  /** Dovetail: slides in along the longer side of the cut (default) or the shorter one. */
  slide?: "long" | "short";
  /** Dovetail: direction it slides in, in degrees from the plane's u axis (instead of `slide`). */
  angle?: Expr;
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
  /**
   * Inserts: their length, one of the lengths the size comes in (M3: 5.7, 4 or 3 mm); default the
   * usual one. The rebuild warns where the wall around an insert is thinner than it needs.
   */
  length?: Expr;
  /** Inserts: also place the inserts as parts (`ho1_insert`, `ho1_insert_2`, …) for the parts list. */
  withInserts?: boolean;
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

/**
 * Bends parts as if they were flexible: round an axis by an angle (`bend`), onto a cylinder
 * (`wrap`: a flat pattern becomes a ring or bracelet), or rolled up into a flat spiral (`spiral`:
 * a long strip such as a ruler or a band of text becomes compact enough to print). The parts'
 * length is their longest extent across the axis; lengths along it are kept (in the middle of the
 * thickness for bend and spiral, on the inner face for wrap). The parts become mesh parts (fine
 * triangles) and keep their ids; `tolerance` is how far the triangles may stray from the exact
 * curved shape.
 */
export interface BendFeature extends FeatureBase {
  op: "bend";
  /** Parts to bend; several are bent together, as one piece (a chain of links, a word of letters). */
  bodies: string[];
  mode: "bend" | "wrap" | "spiral";
  /** Direction of the axis it is bent around (a ring's or coil's axis); only the direction counts. */
  axis: AxisRef;
  /** bend: total angle in degrees, at most 360 (instead of `radius`). */
  angle?: Expr;
  /** wrap: the cylinder's radius; spiral: the inner radius; bend: the radius of the middle of the thickness. */
  radius?: Expr;
  /** spiral: gap between neighbouring turns (default 1 mm). */
  gap?: Expr;
  /** Bend the other way round (the centre on the other side of the part). */
  flip?: boolean;
  /** spiral: the coil starts at the other end of the part. */
  reverse?: boolean;
  /** Largest distance (mm) between the triangles and the exact bent shape; default from the part's size. */
  tolerance?: Expr;
}

/**
 * A basic solid without a sketch: a box, a cylinder or a sphere, placed by its centre. For stand-ins
 * (a servo, a battery), quick assemblies and blocks to cut with. Faces: box `<id>.top` (+Z),
 * `.bottom`, `.front` (−Y), `.back`, `.left` (−X), `.right`; cylinder `.side`, `.start_cap`,
 * `.end_cap` (along its axis); sphere `.side`.
 */
export interface PrimitiveFeature extends FeatureBase {
  op: "primitive";
  shape: "box" | "cylinder" | "sphere";
  /** Box: size along X, Y and Z. */
  size?: [Expr, Expr, Expr];
  /** Cylinder and sphere. */
  diameter?: Expr;
  /** Cylinder: length along its axis. */
  height?: Expr;
  /** Cylinder: the axis it stands on (default Z). */
  axis?: "X" | "Y" | "Z";
  /** Centre of the solid (world mm), default the origin. */
  center?: [Expr, Expr, Expr];
  mode: BooleanMode;
  targets?: string[];
}

/** Plugs on a cable's ends. Sizes are typical housings; the cable leaves the back of the plug. */
export type CableConnectorKind = "jst_xh" | "jst_ph" | "jst_sh" | "dupont" | "xt30" | "xt60" | "idc";

export interface CableConnector {
  kind: CableConnectorKind;
  /** Number of contacts (JST and Dupont: 1–16, default 2; IDC: even, default the ribbon's conductors or 10). XT plugs have 2. */
  pins?: Expr;
}

/** A point a cable runs through, fixed to a part (moving with it when a joint moves) or to the ground. */
export interface CablePoint {
  /** Where, in model coordinates (mm), with the part as drawn. */
  at: [Expr, Expr, Expr];
  /** Body id of the part the point is fixed to (a clip, a socket); absent: fixed in place. */
  on?: string;
}

/**
 * A cable laid through 3D points: round (`diameter`) or a flat ribbon of `conductors` wires on a
 * 1.27 mm pitch. It runs smoothly through every point and leaves its ends straight; a plug on an
 * end sits with its mating face on the end point, the cable coming out of its back. Points fixed to
 * parts move with them, so while joints move the app lays the cable again and checks it: longer
 * than the cable (its drawn route plus `slack`) means it is stretched, bends tighter than
 * `bendRadius` or running into a part are reported too. The cable is a part of its own (id = the
 * feature id) with the cable's material.
 */
export interface CableFeature extends FeatureBase {
  op: "cable";
  /** At least two; the first and last are the cable's ends. */
  points: CablePoint[];
  shape?: "round" | "ribbon";
  /** Round cables: outside diameter, mm. */
  diameter?: Expr;
  /** Ribbon cables: number of wires (default 10). */
  conductors?: Expr;
  /** Insulation; gives the density (copper included) and the default bend radius. Default silicone. */
  material?: CableMaterialKind;
  /** Smallest allowed bend radius of the centre line, mm (default from the material: silicone 3 ×, PVC 6 ×, PTFE 8 × the diameter; ribbon 3 mm). */
  bendRadius?: Expr;
  /** Extra length beyond the drawn route, mm (default 0): room to move before the cable is stretched. */
  slack?: Expr;
  start?: CableConnector;
  end?: CableConnector;
}

export type CableMaterialKind = "silicone" | "pvc" | "ptfe";

export type Feature =
  | PrimitiveFeature
  | SketchFeature
  | PlaneFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | ThreadFeature
  | GearFeature
  | CoilFeature
  | SpringFeature
  | ScrewFeature
  | HoleFeature
  | LoftFeature
  | SplitFeature
  | RibFeature
  | DraftFeature
  | OffsetFaceFeature
  | TextFeature
  | StandardPartFeature
  | GridfinityFeature
  | WallFeature
  | LabelFeature
  | BoxFeature
  | SnapHookFeature
  | LithophaneFeature
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
  | MeshConvertFeature
  | BendFeature
  | CableFeature;
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

/** One moment of a motion: the joint values the parts take then. Joints left out keep moving between the moments that name them. */
export interface MotionKey {
  /** Seconds from the start of the motion. */
  at: number;
  /** Joint id → value (degrees or mm; a cylindrical joint's "<id>.turn" / "<id>.slide"). */
  values: Record<string, number>;
}

/**
 * Several joints moved together over time (walking, waving, a gripper closing): poses at moments,
 * run through one after another. A looping motion goes from its last moment back to its first
 * within `duration`, so a walk cycle repeats without a jump.
 */
export interface Motion {
  id: string;
  name?: string;
  /** Length of one run in seconds (a loop: one cycle). */
  duration: number;
  loop?: boolean;
  /** true (default): smooth curves through the moments; false: straight from one to the next. */
  smooth?: boolean;
  keys: MotionKey[];
}

/** Moving parts. The modelled position is the rest position; joints say how parts move from it. */
export interface Mechanism {
  joints: Joint[];
  couplings?: Coupling[];
  /** Linked moves of several joints over time. */
  motions?: Motion[];
  /** Smallest wanted gap between jointed parts for print-in-place, mm (default: the design's fit). */
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
  /** Lines, areas, notes and points put onto it. */
  marks?: TerrainMark[];
  /**
   * Correction of its size (about its origin), e.g. from a distance whose real length is known;
   * its marks are scaled with it.
   */
  scale?: number;
}

/**
 * A marking on a reference model: a line or an area through the clicked points (mm), drawn
 * following the ground between them, a note pinned to one point, a point to stake out (shown
 * with its coordinates), or a stroke painted freehand like a highlighter.
 */
export interface TerrainMark {
  id: string;
  kind: "line" | "area" | "note" | "point" | "stroke";
  points: Vec3[];
  /** "#rrggbb". */
  color: string;
  /** A note's text, or a line's or area's name. */
  text?: string;
  /** A stroke's width on the ground (mm): painted like a highlighter. */
  width?: number;
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
  /**
   * Materials of parts (by body id): an id from the built-in library in model/materials ("petg")
   * or of one of the document's own `materials`. Gives mass and weight, the look in the viewport
   * and the filament in 3MF exports.
   */
  partMaterials?: Record<string, string>;
  /** The user's own materials, each based on one from the library with its own name and colour. */
  materials?: CustomMaterial[];
  /** Named folders of parts in the parts list. */
  partGroups?: { name: string; parts: string[] }[];
  /**
   * Unit lengths are shown and typed in (default mm). Bare numbers in the file are always
   * millimetres; an inch design stores typed values with their unit, e.g. "2 in".
   */
  units?: LengthUnit;
  /**
   * The fit of this design: the gap (mm) the printer needs between two parts that slide or
   * plug into each other, measured with the fit test part. Every expression can use it as
   * `fit` (default 0.2 mm when absent); holes, bores, joints, clips and connectors made in the
   * app start with `fit` as their gap.
   */
  fit?: Expr;
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

/**
 * A material the user defined: a library material (`base`, e.g. "petg") under an own name, with
 * its own colour and optionally its own density. Everything else (finish, print data) comes from
 * the base.
 */
export interface CustomMaterial {
  /** Lowercase letters and digits, not one of the library's ids. */
  id: string;
  name: string;
  base: string;
  /** "#rrggbb": the filament's colour. */
  color?: string;
  /** g/cm³, when it differs from the base. */
  density?: number;
  notes?: string;
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
  /** Adds a motion or replaces the one with the same id. */
  | { type: "set_motion"; motion: Motion }
  | { type: "delete_motion"; id: string }
  /** Adds a reference model or replaces the one with the same id. */
  | { type: "set_reference"; reference: ReferenceModel }
  | { type: "delete_reference"; id: string }
  /** A part's material (an id from model/materials such as "petg", or an own material's id), or null for none. */
  | { type: "set_material"; part: string; material: string | null }
  /** Adds an own material or replaces the one with the same id. */
  | { type: "define_material"; material: CustomMaterial }
  /** Removes an own material; parts that had it keep its base material. */
  | { type: "delete_material"; id: string }
  /** Adds a variant or replaces the one with that name (`rename` gives it a new name). */
  | { type: "set_variant"; name: string; params: Record<string, Expr>; rename?: string }
  | { type: "delete_variant"; name: string }
  /** Puts a variant in use, or null for the values in `params`. */
  | { type: "use_variant"; name: string | null }
  /**
   * Saves the design as it is now under a name (replacing a version of that name). With `doc` it
   * saves that design instead (a backup file brought back in; its own versions are not taken),
   * `at` keeps when it was saved (default now).
   */
  | { type: "save_version"; name: string; doc?: MeercadDocument; at?: number }
  /** Makes a saved version the design again; the versions themselves stay. */
  | { type: "restore_version"; name: string }
  | { type: "rename_version"; name: string; to: string }
  | { type: "delete_version"; name: string }
  /** A part's colour ("#rrggbb"), or null to colour it automatically again; colours also pick 3MF filaments. */
  | { type: "set_part_color"; part: string; color: string | null }
  /** Draws parts see-through (a reference to model against, e.g. a scan), or solid again. */
  | { type: "set_see_through"; parts: string[]; on: boolean }
  /** The parts list: named folders of parts and/or the order of parts (body ids); null clears it. */
  | { type: "set_part_list"; groups?: { name: string; parts: string[] }[] | null; order?: string[] | null }
  /** The unit lengths are shown and typed in; stored values stay as they are. */
  | { type: "set_units"; units: "mm" | "in" }
  /** The design's fit (see `MeercadDocument.fit`), or null for the default. */
  | { type: "set_fit"; fit: Expr | null }
  /** The whole document; saved versions (and their blobs) are kept when `doc` has none. */
  | { type: "replace"; doc: MeercadDocument };

export function emptyDocument(): MeercadDocument {
  return { format: FORMAT, params: {}, features: [], rollback: null };
}

export const ORIGIN_PLANES = ["origin.XY", "origin.XZ", "origin.YZ"] as const;
