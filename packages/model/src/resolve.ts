import type {
  AxisRef,
  ChamferFeature,
  CircularPatternFeature,
  Expr,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  GearFeature,
  CoilFeature,
  SpringFeature,
  ScrewFeature,
  HoleFeature,
  DraftFeature,
  OffsetFaceFeature,
  TextFeature,
  PrimitiveFeature,
  StandardPartFeature,
  GridfinityFeature,
  WallFeature,
  LabelFeature,
  LithophaneFeature,
  AlignFeature,
  ScaleFeature,
  RibFeature,
  LinearPatternFeature,
  MeshConvertFeature,
  BendFeature,
  PlaneFeature,
  RevolveFeature,
  ShellFeature,
  SketchConstraint,
  SplitFeature,
  ThreadFeature,
  SketchFeature,
  TransformFeature,
} from "@meercad/schema";
import { evaluate, ExprError } from "./expr.js";
import { boxDefaults, snapHookDefaults, type ResolvedBox, type ResolvedSnapHook } from "./closures.js";

/** `T` with the expression fields `K` evaluated to numbers. */
type R<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: undefined extends T[P] ? number | undefined : number;
};

export type ResolvedSketchConstraint = SketchConstraint extends infer C
  ? C extends { value: Expr }
    ? R<C, "value">
    : C
  : never;
export type ResolvedSketch = Omit<SketchFeature, "constraints"> & { constraints: ResolvedSketchConstraint[] };
export type ResolvedPlane = R<PlaneFeature, "offset" | "angle">;
export type ResolvedExtrude = R<ExtrudeFeature, "distance" | "distance2">;
export type ResolvedRevolve = R<RevolveFeature, "angle">;
export type ResolvedFillet = R<FilletFeature, "radius" | "radius2">;
export type ResolvedChamfer = R<ChamferFeature, "distance">;
export type ResolvedShell = R<ShellFeature, "thickness">;
export type ResolvedThread = R<ThreadFeature, "pitch" | "length" | "clearance" | "diameter" | "starts">;
export type ResolvedCoil = R<CoilFeature, "pitch" | "turns" | "taper">;
export type ResolvedSpring = R<
  Omit<SpringFeature, "center">,
  "wire" | "diameter" | "coils" | "length" | "gap" | "legs"
> & { center?: [number, number] };
export type ResolvedScrew = R<
  Omit<ScrewFeature, "center">,
  "diameter" | "pitch" | "starts" | "length" | "threadLength" | "clearance"
> & { center?: [number, number] };
export type ResolvedLinearPattern = R<LinearPatternFeature, "count" | "spacing" | "count2" | "spacing2">;
export type ResolvedCircularPattern = R<CircularPatternFeature, "count" | "angle">;
export type ResolvedGear = R<
  Omit<GearFeature, "center" | "meshWith" | "bore" | "hub">,
  | "module"
  | "teeth"
  | "width"
  | "pressureAngle"
  | "profileShift"
  | "helix"
  | "backlash"
  | "clearance"
  | "rotation"
  | "rim"
  | "chamfer"
> & {
  center?: [number, number];
  meshWith?: { gear: string; direction?: number };
  bore?: { diameter: number; allowance?: number; shape?: "round" | "d_flat" | "hex"; flat?: number };
  hub?: { diameter: number; length: number; side?: "front" | "back" | "both" };
};
export type ResolvedHole = Omit<HoleFeature, "points" | "diameter" | "depth" | "allowance" | "length"> & {
  points: [number, number][];
  diameter?: number;
  depth?: number;
  allowance?: number;
  length?: number;
};
export type ResolvedRib = R<RibFeature, "thickness">;
export type ResolvedDraft = R<DraftFeature, "angle">;
export type ResolvedOffsetFace = R<OffsetFaceFeature, "distance">;
export type ResolvedScale = R<ScaleFeature, "factor">;
export type ResolvedAlign = R<AlignFeature, "offset" | "angle">;
export type ResolvedStandardPart = Omit<
  StandardPartFeature,
  "points" | "length" | "diameter" | "height" | "angle"
> & { points: [number, number][]; length?: number; diameter?: number; height?: number; angle?: number };
export type ResolvedText = Omit<TextFeature, "position" | "size" | "angle" | "depth"> & {
  position: [number, number];
  size: number;
  angle: number;
  depth: number;
};
export type ResolvedPrimitive = Omit<PrimitiveFeature, "size" | "diameter" | "height" | "center"> & {
  size?: [number, number, number];
  diameter?: number;
  height?: number;
  center: [number, number, number];
};
export type ResolvedGridfinity = Omit<
  GridfinityFeature,
  | "units"
  | "height"
  | "wall"
  | "floor"
  | "dividers"
  | "dividerThickness"
  | "scoop"
  | "tab"
  | "magnetDiameter"
  | "magnetDepth"
  | "drawer"
  | "position"
  | "cell"
  | "gap"
  | "bed"
  | "pocket"
> & {
  /** A bin's nest for a part: `sink` as a share (0..1), `clearance` in mm. */
  pocket?: { body: string; sink: number; clearance: number; grip: boolean };
  /** A pocket bin without `units` / `height`: sized round the part by the kernel. */
  autoUnits?: boolean;
  autoHeight?: boolean;
  gap?: number;
  /** The print bed: its size, and what is left of it less the margin. */
  bed?: { size: [number, number]; usable: [number, number] };
  units: [number, number];
  height: number;
  wall?: number;
  floor?: number;
  dividers: [number, number];
  dividerThickness?: number;
  scoop?: number;
  tab?: { width?: number; angle?: number; style?: "full" | "left" | "center" | "right" };
  magnetDiameter?: number;
  magnetDepth?: number;
  drawer?: [number, number];
  position: [number, number];
  cell: [number, number];
};
export type ResolvedWall = Omit<
  WallFeature,
  "units" | "pitch" | "hole" | "thickness" | "plate" | "depth" | "size" | "position" | "cell"
> & {
  units: [number, number];
  pitch?: number;
  hole?: number;
  thickness?: number;
  plate?: number;
  depth?: number;
  size?: number;
  position: [number, number];
  cell: [number, number];
};
export type ResolvedLabel = Omit<
  LabelFeature,
  "width" | "height" | "thickness" | "corner" | "size" | "depth" | "position" | "angle"
> & {
  width: number;
  height: number;
  thickness: number;
  corner: number;
  size?: number;
  depth: number;
  position: [number, number];
  angle: number;
};
/** A split with its connector numbers worked out; unset ones keep their defaults (chosen from the cut). */
export type ResolvedSplit = Omit<SplitFeature, "connectors"> & {
  connectors?: {
    kind: "pins" | "dowels" | "dovetail";
    slide?: "long" | "short";
    size?: number;
    depth?: number;
    clearance?: number;
    count?: number;
    points?: [number, number][];
    angle?: number;
  };
};
export type ResolvedLithophane = Omit<
  LithophaneFeature,
  "width" | "thickness" | "depth" | "frame" | "curve" | "position"
> & {
  kind: "lithophane" | "relief";
  width: number;
  thickness: number;
  depth: number;
  frame: number;
  curve: number;
  position: [number, number];
};
export type ResolvedMeshConvert = R<MeshConvertFeature, "tolerance" | "angle">;
export type ResolvedBend = R<BendFeature, "angle" | "radius" | "gap" | "tolerance">;
export type ResolvedTransform = Omit<TransformFeature, "translate" | "rotate"> & {
  translate?: [number, number, number];
  rotate?: { axis: AxisRef; angle: number };
};
export type ResolvedFeature =
  | ResolvedTransform
  | ResolvedSketch
  | ResolvedPlane
  | ResolvedExtrude
  | ResolvedRevolve
  | ResolvedFillet
  | ResolvedChamfer
  | ResolvedShell
  | ResolvedThread
  | ResolvedGear
  | ResolvedCoil
  | ResolvedSpring
  | ResolvedScrew
  | ResolvedLinearPattern
  | ResolvedCircularPattern
  | ResolvedMeshConvert
  | ResolvedBend
  | ResolvedHole
  | ResolvedRib
  | ResolvedDraft
  | ResolvedOffsetFace
  | ResolvedText
  | ResolvedPrimitive
  | ResolvedStandardPart
  | ResolvedGridfinity
  | ResolvedWall
  | ResolvedLabel
  | ResolvedBox
  | ResolvedSnapHook
  | ResolvedLithophane
  | ResolvedAlign
  | ResolvedScale
  | ResolvedSplit
  | Extract<Feature, { op: "mirror" | "boolean" | "delete" | "import" | "loft" | "sweep" }>;

/** Replaces every expression in a feature by its value (mm / degrees). Throws ExprError naming the field. */
export function resolveFeature(feature: Feature, scope: ReadonlyMap<string, number>): ResolvedFeature {
  const ev = (field: string, expr: Expr) => {
    try {
      return evaluate(expr, scope);
    } catch (err) {
      throw new ExprError(`${field}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const opt = (field: string, expr: Expr | undefined) => (expr === undefined ? undefined : ev(field, expr));

  const count = (field: string, expr: Expr | undefined) => {
    if (expr === undefined) return undefined;

    const n = Math.round(ev(field, expr));
    if (n < 1 || n > 1000) throw new ExprError(`${field}: count must be between 1 and 1000`);

    return n;
  };

  switch (feature.op) {
    case "sketch":
      return {
        ...feature,
        constraints: feature.constraints.map((constraint) =>
          "value" in constraint
            ? { ...constraint, value: ev(`${constraint.id}`, constraint.value) }
            : constraint,
        ) as ResolvedSketchConstraint[],
      };
    case "plane":
      return { ...feature, offset: ev("offset", feature.offset), angle: opt("angle", feature.angle) };
    case "extrude":
      return {
        ...feature,
        distance: ev("distance", feature.distance),
        distance2: opt("distance2", feature.distance2),
      };
    case "revolve":
      return { ...feature, angle: ev("angle", feature.angle) };
    case "fillet":
      return { ...feature, radius: ev("radius", feature.radius), radius2: opt("radius2", feature.radius2) };
    case "chamfer":
      return { ...feature, distance: ev("distance", feature.distance) };
    case "shell":
      return { ...feature, thickness: ev("thickness", feature.thickness) };
    case "thread":
      return {
        ...feature,
        pitch: opt("pitch", feature.pitch),
        length: opt("length", feature.length),
        clearance: opt("clearance", feature.clearance),
        diameter: opt("diameter", feature.diameter),
        starts: count("starts", feature.starts),
      };
    case "coil":
      return {
        ...feature,
        pitch: ev("pitch", feature.pitch),
        turns: ev("turns", feature.turns),
        taper: opt("taper", feature.taper),
      };
    case "spring": {
      const { center, ...rest } = feature;

      return {
        ...rest,
        wire: ev("wire", feature.wire),
        diameter: ev("diameter", feature.diameter),
        coils: ev("coils", feature.coils),
        length: opt("length", feature.length),
        gap: opt("gap", feature.gap),
        legs: opt("legs", feature.legs),
        ...(center
          ? { center: [ev("center[0]", center[0]), ev("center[1]", center[1])] as [number, number] }
          : {}),
      };
    }
    case "screw": {
      const { center, ...rest } = feature;

      return {
        ...rest,
        diameter: ev("diameter", feature.diameter),
        pitch: opt("pitch", feature.pitch),
        starts: count("starts", feature.starts),
        length: opt("length", feature.length),
        threadLength: opt("threadLength", feature.threadLength),
        clearance: opt("clearance", feature.clearance),
        ...(center
          ? { center: [ev("center[0]", center[0]), ev("center[1]", center[1])] as [number, number] }
          : {}),
      };
    }
    case "gear": {
      const { center, meshWith, bore, hub, ...rest } = feature;
      const teeth = Math.round(ev("teeth", feature.teeth));

      if (teeth < (feature.kind === "rack" ? 1 : 4) || teeth > 1000) {
        throw new ExprError(`teeth: must be between ${feature.kind === "rack" ? 1 : 4} and 1000`);
      }

      return {
        ...rest,
        module: opt("module", feature.module),
        teeth,
        width: ev("width", feature.width),
        pressureAngle: opt("pressureAngle", feature.pressureAngle),
        profileShift: opt("profileShift", feature.profileShift),
        helix: opt("helix", feature.helix),
        backlash: opt("backlash", feature.backlash),
        clearance: opt("clearance", feature.clearance),
        rotation: opt("rotation", feature.rotation),
        rim: opt("rim", feature.rim),
        chamfer: opt("chamfer", feature.chamfer),
        ...(center
          ? { center: [ev("center[0]", center[0]), ev("center[1]", center[1])] as [number, number] }
          : {}),
        ...(meshWith
          ? { meshWith: { gear: meshWith.gear, direction: opt("meshWith.direction", meshWith.direction) } }
          : {}),
        ...(bore
          ? {
              bore: {
                ...bore,
                diameter: ev("bore.diameter", bore.diameter),
                allowance: opt("bore.allowance", bore.allowance),
                flat: opt("bore.flat", bore.flat),
              },
            }
          : {}),
        ...(hub
          ? {
              hub: {
                ...hub,
                diameter: ev("hub.diameter", hub.diameter),
                length: ev("hub.length", hub.length),
              },
            }
          : {}),
      };
    }
    case "linear_pattern":
      return {
        ...feature,
        count: count("count", feature.count)!,
        spacing: ev("spacing", feature.spacing),
        count2: count("count2", feature.count2),
        spacing2: opt("spacing2", feature.spacing2),
      };
    case "circular_pattern":
      return { ...feature, count: count("count", feature.count)!, angle: opt("angle", feature.angle) };
    case "hole":
      return {
        ...feature,
        points: feature.points.map(
          ([expr, v], i) => [ev(`points[${i}][0]`, expr), ev(`points[${i}][1]`, v)] as [number, number],
        ),
        diameter: opt("diameter", feature.diameter),
        depth: opt("depth", feature.depth),
        allowance: opt("allowance", feature.allowance),
        length: opt("length", feature.length),
      };
    case "split": {
      const { connectors: c, ...rest } = feature;
      if (!c) return rest;

      return {
        ...rest,
        connectors: {
          kind: c.kind,
          ...(c.slide ? { slide: c.slide } : {}),
          size: opt("connectors.size", c.size),
          depth: opt("connectors.depth", c.depth),
          clearance: opt("connectors.clearance", c.clearance),
          count: count("connectors.count", c.count),
          ...(c.points
            ? {
                points: c.points.map(
                  ([expr, v], i) =>
                    [ev(`connectors.points[${i}][0]`, expr), ev(`connectors.points[${i}][1]`, v)] as [
                      number,
                      number,
                    ],
                ),
              }
            : {}),
          angle: opt("connectors.angle", c.angle),
        },
      };
    }
    case "draft":
      return { ...feature, angle: ev("angle", feature.angle) };
    case "offset_face":
      return { ...feature, distance: ev("distance", feature.distance) };
    case "scale":
      return { ...feature, factor: ev("factor", feature.factor) };
    case "align":
      return { ...feature, offset: opt("offset", feature.offset), angle: opt("angle", feature.angle) };
    case "standard_part":
      return {
        ...feature,
        points: feature.points.map(
          ([expr, v], i) => [ev(`points[${i}][0]`, expr), ev(`points[${i}][1]`, v)] as [number, number],
        ),
        length: opt("length", feature.length),
        diameter: opt("diameter", feature.diameter),
        height: opt("height", feature.height),
        angle: opt("angle", feature.angle),
      };
    case "primitive": {
      const v3 = (field: string, e: [Expr, Expr, Expr] | undefined): [number, number, number] | undefined =>
        e ? [ev(`${field}[0]`, e[0]), ev(`${field}[1]`, e[1]), ev(`${field}[2]`, e[2])] : undefined;
      const size = v3("size", feature.size);
      const diameter = opt("diameter", feature.diameter);
      const height = opt("height", feature.height);
      const { size: _s, diameter: _d, height: _h, center: _c, ...rest } = feature;

      return {
        ...rest,
        ...(size ? { size } : {}),
        ...(diameter !== undefined ? { diameter } : {}),
        ...(height !== undefined ? { height } : {}),
        center: v3("center", feature.center) ?? [0, 0, 0],
      };
    }
    case "text":
      return {
        ...feature,
        position: feature.position
          ? [ev("position[0]", feature.position[0]), ev("position[1]", feature.position[1])]
          : [0, 0],
        size: ev("size", feature.size),
        angle: opt("angle", feature.angle) ?? 0,
        depth: ev("depth", feature.depth),
      };
    case "rib":
      return { ...feature, thickness: ev("thickness", feature.thickness) };
    case "gridfinity": {
      const int = (field: string, expr: Expr, lo: number, hi: number) => {
        const n = Math.round(ev(field, expr));
        if (n < lo || n > hi) throw new ExprError(`${field}: must be between ${lo} and ${hi}`);

        return n;
      };

      const pair = (field: string, p: [Expr, Expr]) =>
        [ev(`${field}[0]`, p[0]), ev(`${field}[1]`, p[1])] as [number, number];
      const { tab, pocket, ...rest } = feature;
      const auto = feature.kind === "bin" && !!pocket;

      if (!feature.units && !auto && !(feature.kind === "baseplate" && (feature.drawer || feature.outline))) {
        throw new ExprError("units: required");
      }

      return {
        ...rest,
        // Baseplates in a drawer or outline count their cells themselves; pocket bins are sized in the
        // kernel.
        units: feature.units
          ? [int("units[0]", feature.units[0], 1, 30), int("units[1]", feature.units[1], 1, 30)]
          : [1, 1],
        height: feature.height === undefined ? 3 : int("height", feature.height, 1, 40),
        ...(pocket && feature.kind === "bin"
          ? {
              pocket: {
                body: pocket.body,
                sink: (opt("pocket.sink", pocket.sink) ?? 50) / 100,
                clearance: opt("pocket.clearance", pocket.clearance) ?? 0.5,
                grip: !!pocket.grip,
              },
              ...(feature.units ? {} : { autoUnits: true }),
              ...(feature.height === undefined ? { autoHeight: true } : {}),
            }
          : {}),
        wall: opt("wall", feature.wall),
        floor: opt("floor", feature.floor),
        dividers: feature.dividers
          ? [int("dividers[0]", feature.dividers[0], 0, 50), int("dividers[1]", feature.dividers[1], 0, 50)]
          : [0, 0],
        dividerThickness: opt("dividerThickness", feature.dividerThickness),
        scoop: opt("scoop", feature.scoop),
        ...(tab
          ? {
              tab: {
                style: tab.style,
                width: opt("tab.width", tab.width),
                angle: opt("tab.angle", tab.angle),
              },
            }
          : {}),
        magnetDiameter: opt("magnetDiameter", feature.magnetDiameter),
        magnetDepth: opt("magnetDepth", feature.magnetDepth),
        drawer: feature.drawer ? pair("drawer", feature.drawer) : undefined,
        gap: opt("gap", feature.gap),
        bed: feature.bed ? resolveBed(feature.bed, pair) : undefined,
        position: feature.position ? pair("position", feature.position) : [0, 0],
        cell: feature.cell
          ? [int("cell[0]", feature.cell[0], 0, 100), int("cell[1]", feature.cell[1], 0, 100)]
          : [0, 0],
      };
    }
    case "wall": {
      const int = (field: string, expr: Expr, lo: number, hi: number) => {
        const n = Math.round(ev(field, expr));
        if (n < lo || n > hi) throw new ExprError(`${field}: must be between ${lo} and ${hi}`);

        return n;
      };

      return {
        ...feature,
        units: [int("units[0]", feature.units[0], 1, 60), int("units[1]", feature.units[1], 1, 60)],
        pitch: opt("pitch", feature.pitch),
        hole: opt("hole", feature.hole),
        thickness: opt("thickness", feature.thickness),
        plate: opt("plate", feature.plate),
        depth: opt("depth", feature.depth),
        size: opt("size", feature.size),
        position: feature.position
          ? [ev("position[0]", feature.position[0]), ev("position[1]", feature.position[1])]
          : [0, 0],
        cell: feature.cell
          ? [int("cell[0]", feature.cell[0], 0, 200), int("cell[1]", feature.cell[1], 0, 200)]
          : [0, 0],
      };
    }
    case "label":
      return {
        ...feature,
        width: opt("width", feature.width) ?? 36,
        height: opt("height", feature.height) ?? 11,
        thickness: opt("thickness", feature.thickness) ?? 1.2,
        corner: opt("corner", feature.corner) ?? 1,
        size: opt("size", feature.size),
        depth: opt("depth", feature.depth) ?? 0.6,
        position: feature.position
          ? [ev("position[0]", feature.position[0]), ev("position[1]", feature.position[1])]
          : [0, 0],
        angle: opt("angle", feature.angle) ?? 0,
      };

    case "box":
      return boxDefaults(feature, (field, e) => opt(field, e as Expr | undefined));
    case "snap_hook":
      return snapHookDefaults(feature, (field, e) => opt(field, e as Expr | undefined));
    case "lithophane": {
      const kind = feature.kind ?? "lithophane";

      return {
        ...feature,
        kind,
        width: ev("width", feature.width),
        thickness: opt("thickness", feature.thickness) ?? (kind === "relief" ? 1.6 : 0.8),
        depth: opt("depth", feature.depth) ?? (kind === "relief" ? 1.6 : 2.2),
        frame: opt("frame", feature.frame) ?? 0,
        curve: opt("curve", feature.curve) ?? 0,
        position: feature.position
          ? [ev("position[0]", feature.position[0]), ev("position[1]", feature.position[1])]
          : [0, 0],
      };
    }
    case "mesh_convert":
      return {
        ...feature,
        tolerance: opt("tolerance", feature.tolerance),
        angle: opt("angle", feature.angle),
      };
    case "bend":
      return {
        ...feature,
        angle: opt("angle", feature.angle),
        radius: opt("radius", feature.radius),
        gap: opt("gap", feature.gap),
        tolerance: opt("tolerance", feature.tolerance),
      };
    case "transform": {
      const { translate, rotate, ...rest } = feature;

      return {
        ...rest,
        ...(translate
          ? { translate: translate.map((expr, i) => ev(`translate[${i}]`, expr)) as [number, number, number] }
          : {}),
        ...(rotate ? { rotate: { axis: rotate.axis, angle: ev("angle", rotate.angle) } } : {}),
      };
    }
    default:
      return feature;
  }
}

/** Visits every expression in a feature (for renaming parameters). */
export function mapFeatureExprs(feature: Feature, fn: (expr: Expr) => Expr): Feature {
  const g = structuredClone(feature) as unknown as Record<string, unknown>;
  const keys: Record<string, string[]> = {
    plane: ["offset", "angle"],
    extrude: ["distance", "distance2"],
    revolve: ["angle"],
    fillet: ["radius", "radius2"],
    chamfer: ["distance"],
    shell: ["thickness"],
    thread: ["pitch", "length", "clearance", "diameter", "starts"],
    coil: ["pitch", "turns", "taper"],
    spring: ["wire", "diameter", "coils", "length", "gap", "legs"],
    screw: ["diameter", "pitch", "starts", "length", "threadLength", "clearance"],
    gear: [
      "module",
      "teeth",
      "width",
      "pressureAngle",
      "profileShift",
      "helix",
      "backlash",
      "clearance",
      "rotation",
      "rim",
      "chamfer",
    ],
    linear_pattern: ["count", "spacing", "count2", "spacing2"],
    circular_pattern: ["count", "angle"],
    mesh_convert: ["tolerance", "angle"],
    bend: ["angle", "radius", "gap", "tolerance"],
    hole: ["diameter", "depth", "allowance", "length"],
    rib: ["thickness"],
    draft: ["angle"],
    offset_face: ["distance"],
    text: ["size", "angle", "depth"],
    primitive: ["diameter", "height"],
    standard_part: ["length", "diameter", "height", "angle"],
    gridfinity: [
      "height",
      "wall",
      "floor",
      "dividerThickness",
      "scoop",
      "magnetDiameter",
      "magnetDepth",
      "gap",
    ],
    label: ["width", "height", "thickness", "corner", "size", "depth", "angle"],
    box: [
      "width",
      "depth",
      "height",
      "wall",
      "floor",
      "corner",
      "lidThickness",
      "clearance",
      "snap",
      "lipHeight",
      "pitch",
      "neck",
      "starts",
    ],
    snap_hook: [
      "angle",
      "length",
      "thickness",
      "width",
      "overhang",
      "insertAngle",
      "retainAngle",
      "clearance",
    ],
    wall: ["pitch", "hole", "thickness", "plate", "depth", "size"],
    lithophane: ["width", "thickness", "depth", "frame", "curve"],
    align: ["offset", "angle"],
    scale: ["factor"],
  };

  if (feature.op === "transform") {
    if (Array.isArray(g["translate"])) g["translate"] = (g["translate"] as Expr[]).map(fn);

    const rot = g["rotate"] as { angle: Expr } | undefined;
    if (rot) rot.angle = fn(rot.angle);
  }

  if (feature.op === "text" && Array.isArray(g["position"])) {
    g["position"] = (g["position"] as Expr[]).map(fn);
  }

  if (feature.op === "primitive") {
    for (const k of ["size", "center"]) if (Array.isArray(g[k])) g[k] = (g[k] as Expr[]).map(fn);
  }

  if (feature.op === "gridfinity") {
    for (const k of ["units", "dividers", "drawer", "position", "cell"]) {
      if (Array.isArray(g[k])) g[k] = (g[k] as Expr[]).map(fn);
    }
  }

  if (feature.op === "gridfinity" && g["bed"]) {
    const bed = g["bed"] as Record<string, Expr[] | string>;
    for (const k of ["size", "margin"]) if (Array.isArray(bed[k])) bed[k] = (bed[k] as Expr[]).map(fn);
  }

  if (feature.op === "gridfinity" && g["pocket"]) {
    const pocket = g["pocket"] as Record<string, Expr>;
    for (const k of ["sink", "clearance"]) if (pocket[k] !== undefined) pocket[k] = fn(pocket[k]);
  }

  if (feature.op === "gridfinity" && g["tab"]) {
    const tab = g["tab"] as Record<string, Expr>;
    for (const k of ["width", "angle"]) if (tab[k] !== undefined) tab[k] = fn(tab[k]);
  }

  if (feature.op === "box" && Array.isArray(g["position"])) g["position"] = (g["position"] as Expr[]).map(fn);
  if (feature.op === "snap_hook") g["points"] = (g["points"] as Expr[][]).map((pt) => pt.map(fn));

  if (feature.op === "wall") {
    for (const k of ["units", "position", "cell"]) if (Array.isArray(g[k])) g[k] = (g[k] as Expr[]).map(fn);
  }

  if (feature.op === "lithophane" && Array.isArray(g["position"])) {
    g["position"] = (g["position"] as Expr[]).map(fn);
  }

  if (feature.op === "label" && Array.isArray(g["position"])) {
    g["position"] = (g["position"] as Expr[]).map(fn);
  }

  if (feature.op === "standard_part") g["points"] = (g["points"] as Expr[][]).map((pt) => pt.map(fn));
  if (feature.op === "hole") g["points"] = (g["points"] as Expr[][]).map((pt) => pt.map(fn));

  if ((feature.op === "spring" || feature.op === "screw") && Array.isArray(g["center"])) {
    g["center"] = (g["center"] as Expr[]).map(fn);
  }

  if (feature.op === "gear") {
    if (Array.isArray(g["center"])) g["center"] = (g["center"] as Expr[]).map(fn);

    const nested = (o: unknown, ks: string[]) => {
      const r = o as Record<string, Expr> | undefined;
      if (r) for (const k of ks) if (r[k] !== undefined) r[k] = fn(r[k]);
    };

    nested(g["meshWith"], ["direction"]);
    nested(g["bore"], ["diameter", "allowance", "flat"]);
    nested(g["hub"], ["diameter", "length"]);
  }

  for (const k of keys[feature.op] ?? []) if (g[k] !== undefined) g[k] = fn(g[k] as Expr);

  if (feature.op === "sketch") {
    for (const c of g["constraints"] as { value?: Expr }[]) if (c.value !== undefined) c.value = fn(c.value);
  }

  return g as unknown as Feature;
}

/** A baseplate's print bed: its size less the margin that cannot be printed on. */
function resolveBed(
  bed: NonNullable<GridfinityFeature["bed"]>,
  pair: (field: string, p: [Expr, Expr]) => [number, number],
): NonNullable<ResolvedGridfinity["bed"]> {
  const size = pair("bed.size", bed.size);
  const margin = bed.margin ? pair("bed.margin", bed.margin) : [0, 0];
  if (margin.some((m) => m < 0)) throw new ExprError("bed.margin: must not be negative");

  return { size, usable: [size[0] - margin[0]!, size[1] - margin[1]!] };
}
