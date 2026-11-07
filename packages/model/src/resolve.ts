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
  TextureFeature,
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
type R<T, K extends keyof T> = Omit<T, K> & { [P in K]: undefined extends T[P] ? number | undefined : number };

export type ResolvedSketchConstraint = SketchConstraint extends infer C ? (C extends { value: Expr } ? R<C, "value"> : C) : never;
export type ResolvedSketch = Omit<SketchFeature, "constraints"> & { constraints: ResolvedSketchConstraint[] };
export type ResolvedPlane = R<PlaneFeature, "offset" | "angle">;
export type ResolvedExtrude = R<ExtrudeFeature, "distance" | "distance2">;
export type ResolvedRevolve = R<RevolveFeature, "angle">;
export type ResolvedFillet = R<FilletFeature, "radius" | "radius2">;
export type ResolvedChamfer = R<ChamferFeature, "distance">;
export type ResolvedShell = R<ShellFeature, "thickness">;
export type ResolvedThread = R<ThreadFeature, "pitch" | "length" | "clearance" | "diameter" | "starts">;
export type ResolvedCoil = R<CoilFeature, "pitch" | "turns" | "taper">;
export type ResolvedSpring = R<Omit<SpringFeature, "center">, "wire" | "diameter" | "coils" | "length" | "gap" | "legs"> & { center?: [number, number] };
export type ResolvedScrew = R<Omit<ScrewFeature, "center">, "diameter" | "pitch" | "starts" | "length" | "threadLength" | "clearance"> & { center?: [number, number] };
export type ResolvedLinearPattern = R<LinearPatternFeature, "count" | "spacing" | "count2" | "spacing2">;
export type ResolvedCircularPattern = R<CircularPatternFeature, "count" | "angle">;
export type ResolvedGear = R<
  Omit<GearFeature, "center" | "meshWith" | "bore" | "hub">,
  "module" | "teeth" | "width" | "pressureAngle" | "profileShift" | "helix" | "backlash" | "clearance" | "rotation" | "rim" | "chamfer"
> & {
  center?: [number, number];
  meshWith?: { gear: string; direction?: number };
  bore?: { diameter: number; allowance?: number; shape?: "round" | "d_flat" | "hex"; flat?: number };
  hub?: { diameter: number; length: number; side?: "front" | "back" | "both" };
};
export type ResolvedHole = Omit<HoleFeature, "points" | "diameter" | "depth" | "allowance"> & { points: [number, number][]; diameter?: number; depth?: number; allowance?: number };
export type ResolvedRib = R<RibFeature, "thickness">;
export type ResolvedDraft = R<DraftFeature, "angle">;
export type ResolvedOffsetFace = R<OffsetFaceFeature, "distance">;
export type ResolvedScale = R<ScaleFeature, "factor">;
export type ResolvedAlign = R<AlignFeature, "offset" | "angle">;
export type ResolvedStandardPart = Omit<StandardPartFeature, "points" | "length" | "diameter" | "height" | "angle"> & { points: [number, number][]; length?: number; diameter?: number; height?: number; angle?: number };
export type ResolvedText = Omit<TextFeature, "position" | "size" | "angle" | "depth"> & { position: [number, number]; size: number; angle: number; depth: number };
export type ResolvedPrimitive = Omit<PrimitiveFeature, "size" | "diameter" | "height" | "center"> & { size?: [number, number, number]; diameter?: number; height?: number; center: [number, number, number] };
export type ResolvedGridfinity = Omit<
  GridfinityFeature,
  "units" | "height" | "wall" | "floor" | "dividers" | "dividerThickness" | "scoop" | "tab" | "magnetDiameter" | "magnetDepth" | "drawer" | "position" | "cell"
> & {
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
export type ResolvedWall = Omit<WallFeature, "units" | "pitch" | "hole" | "thickness" | "plate" | "depth" | "size" | "position" | "cell"> & {
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
export type ResolvedLabel = Omit<LabelFeature, "width" | "height" | "thickness" | "corner" | "size" | "depth" | "position" | "angle"> & {
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
  connectors?: { kind: "pins" | "dowels" | "dovetail"; slide?: "long" | "short"; size?: number; depth?: number; clearance?: number; count?: number; points?: [number, number][]; angle?: number };
};
export type ResolvedLithophane = Omit<LithophaneFeature, "width" | "thickness" | "depth" | "frame" | "curve" | "position"> & {
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
export type ResolvedTransform = Omit<TransformFeature, "translate" | "rotate"> & { translate?: [number, number, number]; rotate?: { axis: AxisRef; angle: number } };
/** A texture with its numbers worked out; `fade` stays undefined for the default (half the pitch, at most 2 mm). */
export type ResolvedTexture = Omit<TextureFeature, "depth" | "pitch" | "angle" | "ratio" | "fade"> & { depth: number; pitch: number; angle: number; ratio?: number; fade?: number };
export type ResolvedFeature =
  | ResolvedTexture
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
export function resolveFeature(f: Feature, scope: ReadonlyMap<string, number>): ResolvedFeature {
  const ev = (field: string, e: Expr) => {
    try {
      return evaluate(e, scope);
    } catch (err) {
      throw new ExprError(`${field}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const opt = (field: string, e: Expr | undefined) => (e === undefined ? undefined : ev(field, e));
  const count = (field: string, e: Expr | undefined) => {
    if (e === undefined) return undefined;
    const n = Math.round(ev(field, e));
    if (n < 1 || n > 1000) throw new ExprError(`${field}: count must be between 1 and 1000`);
    return n;
  };
  switch (f.op) {
    case "sketch":
      return {
        ...f,
        constraints: f.constraints.map((c) => ("value" in c ? { ...c, value: ev(`${c.id}`, c.value) } : c)) as ResolvedSketchConstraint[],
      };
    case "plane":
      return { ...f, offset: ev("offset", f.offset), angle: opt("angle", f.angle) };
    case "extrude":
      return { ...f, distance: ev("distance", f.distance), distance2: opt("distance2", f.distance2) };
    case "revolve":
      return { ...f, angle: ev("angle", f.angle) };
    case "fillet":
      return { ...f, radius: ev("radius", f.radius), radius2: opt("radius2", f.radius2) };
    case "chamfer":
      return { ...f, distance: ev("distance", f.distance) };
    case "shell":
      return { ...f, thickness: ev("thickness", f.thickness) };
    case "thread":
      return { ...f, pitch: opt("pitch", f.pitch), length: opt("length", f.length), clearance: opt("clearance", f.clearance), diameter: opt("diameter", f.diameter), starts: count("starts", f.starts) };
    case "coil":
      return { ...f, pitch: ev("pitch", f.pitch), turns: ev("turns", f.turns), taper: opt("taper", f.taper) };
    case "spring": {
      const { center, ...rest } = f;
      return {
        ...rest,
        wire: ev("wire", f.wire),
        diameter: ev("diameter", f.diameter),
        coils: ev("coils", f.coils),
        length: opt("length", f.length),
        gap: opt("gap", f.gap),
        legs: opt("legs", f.legs),
        ...(center ? { center: [ev("center[0]", center[0]), ev("center[1]", center[1])] as [number, number] } : {}),
      };
    }
    case "screw": {
      const { center, ...rest } = f;
      return {
        ...rest,
        diameter: ev("diameter", f.diameter),
        pitch: opt("pitch", f.pitch),
        starts: count("starts", f.starts),
        length: opt("length", f.length),
        threadLength: opt("threadLength", f.threadLength),
        clearance: opt("clearance", f.clearance),
        ...(center ? { center: [ev("center[0]", center[0]), ev("center[1]", center[1])] as [number, number] } : {}),
      };
    }
    case "gear": {
      const { center, meshWith, bore, hub, ...rest } = f;
      const teeth = Math.round(ev("teeth", f.teeth));
      if (teeth < (f.kind === "rack" ? 1 : 4) || teeth > 1000) throw new ExprError(`teeth: must be between ${f.kind === "rack" ? 1 : 4} and 1000`);
      return {
        ...rest,
        module: opt("module", f.module),
        teeth,
        width: ev("width", f.width),
        pressureAngle: opt("pressureAngle", f.pressureAngle),
        profileShift: opt("profileShift", f.profileShift),
        helix: opt("helix", f.helix),
        backlash: opt("backlash", f.backlash),
        clearance: opt("clearance", f.clearance),
        rotation: opt("rotation", f.rotation),
        rim: opt("rim", f.rim),
        chamfer: opt("chamfer", f.chamfer),
        ...(center ? { center: [ev("center[0]", center[0]), ev("center[1]", center[1])] as [number, number] } : {}),
        ...(meshWith ? { meshWith: { gear: meshWith.gear, direction: opt("meshWith.direction", meshWith.direction) } } : {}),
        ...(bore ? { bore: { ...bore, diameter: ev("bore.diameter", bore.diameter), allowance: opt("bore.allowance", bore.allowance), flat: opt("bore.flat", bore.flat) } } : {}),
        ...(hub ? { hub: { ...hub, diameter: ev("hub.diameter", hub.diameter), length: ev("hub.length", hub.length) } } : {}),
      };
    }
    case "linear_pattern":
      return { ...f, count: count("count", f.count)!, spacing: ev("spacing", f.spacing), count2: count("count2", f.count2), spacing2: opt("spacing2", f.spacing2) };
    case "circular_pattern":
      return { ...f, count: count("count", f.count)!, angle: opt("angle", f.angle) };
    case "hole":
      return {
        ...f,
        points: f.points.map(([u, v], i) => [ev(`points[${i}][0]`, u), ev(`points[${i}][1]`, v)] as [number, number]),
        diameter: opt("diameter", f.diameter),
        depth: opt("depth", f.depth),
        allowance: opt("allowance", f.allowance),
      };
    case "split": {
      const { connectors: c, ...rest } = f;
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
          ...(c.points ? { points: c.points.map(([u, v], i) => [ev(`connectors.points[${i}][0]`, u), ev(`connectors.points[${i}][1]`, v)] as [number, number]) } : {}),
          angle: opt("connectors.angle", c.angle),
        },
      };
    }
    case "draft":
      return { ...f, angle: ev("angle", f.angle) };
    case "offset_face":
      return { ...f, distance: ev("distance", f.distance) };
    case "texture":
      return { ...f, depth: ev("depth", f.depth), pitch: ev("pitch", f.pitch), angle: opt("angle", f.angle) ?? 0, ratio: opt("ratio", f.ratio), fade: opt("fade", f.fade) };
    case "scale":
      return { ...f, factor: ev("factor", f.factor) };
    case "align":
      return { ...f, offset: opt("offset", f.offset), angle: opt("angle", f.angle) };
    case "standard_part":
      return {
        ...f,
        points: f.points.map(([u, v], i) => [ev(`points[${i}][0]`, u), ev(`points[${i}][1]`, v)] as [number, number]),
        length: opt("length", f.length),
        diameter: opt("diameter", f.diameter),
        height: opt("height", f.height),
        angle: opt("angle", f.angle),
      };
    case "primitive": {
      const v3 = (field: string, e: [Expr, Expr, Expr] | undefined): [number, number, number] | undefined => (e ? [ev(`${field}[0]`, e[0]), ev(`${field}[1]`, e[1]), ev(`${field}[2]`, e[2])] : undefined);
      const size = v3("size", f.size);
      const diameter = opt("diameter", f.diameter);
      const height = opt("height", f.height);
      const { size: _s, diameter: _d, height: _h, center: _c, ...rest } = f;
      return { ...rest, ...(size ? { size } : {}), ...(diameter !== undefined ? { diameter } : {}), ...(height !== undefined ? { height } : {}), center: v3("center", f.center) ?? [0, 0, 0] };
    }
    case "text":
      return {
        ...f,
        position: f.position ? [ev("position[0]", f.position[0]), ev("position[1]", f.position[1])] : [0, 0],
        size: ev("size", f.size),
        angle: opt("angle", f.angle) ?? 0,
        depth: ev("depth", f.depth),
      };
    case "rib":
      return { ...f, thickness: ev("thickness", f.thickness) };
    case "gridfinity": {
      const int = (field: string, e: Expr, lo: number, hi: number) => {
        const n = Math.round(ev(field, e));
        if (n < lo || n > hi) throw new ExprError(`${field}: must be between ${lo} and ${hi}`);
        return n;
      };
      const pair = (field: string, p: [Expr, Expr]) => [ev(`${field}[0]`, p[0]), ev(`${field}[1]`, p[1])] as [number, number];
      const { tab, ...rest } = f;
      return {
        ...rest,
        units: [int("units[0]", f.units[0], 1, 30), int("units[1]", f.units[1], 1, 30)],
        height: f.height === undefined ? 3 : int("height", f.height, 1, 40),
        wall: opt("wall", f.wall),
        floor: opt("floor", f.floor),
        dividers: f.dividers ? [int("dividers[0]", f.dividers[0], 0, 50), int("dividers[1]", f.dividers[1], 0, 50)] : [0, 0],
        dividerThickness: opt("dividerThickness", f.dividerThickness),
        scoop: opt("scoop", f.scoop),
        ...(tab ? { tab: { style: tab.style, width: opt("tab.width", tab.width), angle: opt("tab.angle", tab.angle) } } : {}),
        magnetDiameter: opt("magnetDiameter", f.magnetDiameter),
        magnetDepth: opt("magnetDepth", f.magnetDepth),
        drawer: f.drawer ? pair("drawer", f.drawer) : undefined,
        position: f.position ? pair("position", f.position) : [0, 0],
        cell: f.cell ? [int("cell[0]", f.cell[0], 0, 100), int("cell[1]", f.cell[1], 0, 100)] : [0, 0],
      };
    }
    case "wall": {
      const int = (field: string, e: Expr, lo: number, hi: number) => {
        const n = Math.round(ev(field, e));
        if (n < lo || n > hi) throw new ExprError(`${field}: must be between ${lo} and ${hi}`);
        return n;
      };
      return {
        ...f,
        units: [int("units[0]", f.units[0], 1, 60), int("units[1]", f.units[1], 1, 60)],
        pitch: opt("pitch", f.pitch),
        hole: opt("hole", f.hole),
        thickness: opt("thickness", f.thickness),
        plate: opt("plate", f.plate),
        depth: opt("depth", f.depth),
        size: opt("size", f.size),
        position: f.position ? [ev("position[0]", f.position[0]), ev("position[1]", f.position[1])] : [0, 0],
        cell: f.cell ? [int("cell[0]", f.cell[0], 0, 200), int("cell[1]", f.cell[1], 0, 200)] : [0, 0],
      };
    }
    case "label":
      return {
        ...f,
        width: opt("width", f.width) ?? 36,
        height: opt("height", f.height) ?? 11,
        thickness: opt("thickness", f.thickness) ?? 1.2,
        corner: opt("corner", f.corner) ?? 1,
        size: opt("size", f.size),
        depth: opt("depth", f.depth) ?? 0.6,
        position: f.position ? [ev("position[0]", f.position[0]), ev("position[1]", f.position[1])] : [0, 0],
        angle: opt("angle", f.angle) ?? 0,
      };

    case "box":
      return boxDefaults(f, (field, e) => opt(field, e as Expr | undefined));
    case "snap_hook":
      return snapHookDefaults(f, (field, e) => opt(field, e as Expr | undefined));
    case "lithophane": {
      const kind = f.kind ?? "lithophane";
      return {
        ...f,
        kind,
        width: ev("width", f.width),
        thickness: opt("thickness", f.thickness) ?? (kind === "relief" ? 1.6 : 0.8),
        depth: opt("depth", f.depth) ?? (kind === "relief" ? 1.6 : 2.2),
        frame: opt("frame", f.frame) ?? 0,
        curve: opt("curve", f.curve) ?? 0,
        position: f.position ? [ev("position[0]", f.position[0]), ev("position[1]", f.position[1])] : [0, 0],
      };
    }
    case "mesh_convert":
      return { ...f, tolerance: opt("tolerance", f.tolerance), angle: opt("angle", f.angle) };
    case "bend":
      return { ...f, angle: opt("angle", f.angle), radius: opt("radius", f.radius), gap: opt("gap", f.gap), tolerance: opt("tolerance", f.tolerance) };
    case "transform": {
      const { translate, rotate, ...rest } = f;
      return {
        ...rest,
        ...(translate ? { translate: translate.map((e, i) => ev(`translate[${i}]`, e)) as [number, number, number] } : {}),
        ...(rotate ? { rotate: { axis: rotate.axis, angle: ev("angle", rotate.angle) } } : {}),
      };
    }
    default:
      return f;
  }
}

/** Visits every expression in a feature (for renaming parameters). */
export function mapFeatureExprs(f: Feature, fn: (e: Expr) => Expr): Feature {
  const g = structuredClone(f) as unknown as Record<string, unknown>;
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
    gear: ["module", "teeth", "width", "pressureAngle", "profileShift", "helix", "backlash", "clearance", "rotation", "rim", "chamfer"],
    linear_pattern: ["count", "spacing", "count2", "spacing2"],
    circular_pattern: ["count", "angle"],
    mesh_convert: ["tolerance", "angle"],
    bend: ["angle", "radius", "gap", "tolerance"],
    hole: ["diameter", "depth", "allowance"],
    rib: ["thickness"],
    draft: ["angle"],
    offset_face: ["distance"],
    texture: ["depth", "pitch", "angle", "ratio", "fade"],
    text: ["size", "angle", "depth"],
    primitive: ["diameter", "height"],
    standard_part: ["length", "diameter", "height", "angle"],
    gridfinity: ["height", "wall", "floor", "dividerThickness", "scoop", "magnetDiameter", "magnetDepth"],
    label: ["width", "height", "thickness", "corner", "size", "depth", "angle"],
    box: ["width", "depth", "height", "wall", "floor", "corner", "lidThickness", "clearance", "snap", "lipHeight", "pitch", "neck", "starts"],
    snap_hook: ["angle", "length", "thickness", "width", "overhang", "insertAngle", "retainAngle", "clearance"],
    wall: ["pitch", "hole", "thickness", "plate", "depth", "size"],
    lithophane: ["width", "thickness", "depth", "frame", "curve"],
    align: ["offset", "angle"],
    scale: ["factor"],
  };
  if (f.op === "transform") {
    if (Array.isArray(g["translate"])) g["translate"] = (g["translate"] as Expr[]).map(fn);
    const rot = g["rotate"] as { angle: Expr } | undefined;
    if (rot) rot.angle = fn(rot.angle);
  }
  if (f.op === "text" && Array.isArray(g["position"])) g["position"] = (g["position"] as Expr[]).map(fn);
  if (f.op === "primitive") for (const k of ["size", "center"]) if (Array.isArray(g[k])) g[k] = (g[k] as Expr[]).map(fn);
  if (f.op === "gridfinity") for (const k of ["units", "dividers", "drawer", "position", "cell"]) if (Array.isArray(g[k])) g[k] = (g[k] as Expr[]).map(fn);
  if (f.op === "gridfinity" && g["tab"]) {
    const tab = g["tab"] as Record<string, Expr>;
    for (const k of ["width", "angle"]) if (tab[k] !== undefined) tab[k] = fn(tab[k]);
  }
  if (f.op === "box" && Array.isArray(g["position"])) g["position"] = (g["position"] as Expr[]).map(fn);
  if (f.op === "snap_hook") g["points"] = (g["points"] as Expr[][]).map((pt) => pt.map(fn));
  if (f.op === "wall") for (const k of ["units", "position", "cell"]) if (Array.isArray(g[k])) g[k] = (g[k] as Expr[]).map(fn);
  if (f.op === "lithophane" && Array.isArray(g["position"])) g["position"] = (g["position"] as Expr[]).map(fn);
  if (f.op === "label" && Array.isArray(g["position"])) g["position"] = (g["position"] as Expr[]).map(fn);
  if (f.op === "standard_part") g["points"] = (g["points"] as Expr[][]).map((pt) => pt.map(fn));
  if (f.op === "hole") g["points"] = (g["points"] as Expr[][]).map((pt) => pt.map(fn));
  if ((f.op === "spring" || f.op === "screw") && Array.isArray(g["center"])) g["center"] = (g["center"] as Expr[]).map(fn);
  if (f.op === "gear") {
    if (Array.isArray(g["center"])) g["center"] = (g["center"] as Expr[]).map(fn);
    const nested = (o: unknown, ks: string[]) => {
      const r = o as Record<string, Expr> | undefined;
      if (r) for (const k of ks) if (r[k] !== undefined) r[k] = fn(r[k]);
    };
    nested(g["meshWith"], ["direction"]);
    nested(g["bore"], ["diameter", "allowance", "flat"]);
    nested(g["hub"], ["diameter", "length"]);
  }
  for (const k of keys[f.op] ?? []) if (g[k] !== undefined) g[k] = fn(g[k] as Expr);
  if (f.op === "sketch") {
    for (const c of g["constraints"] as { value?: Expr }[]) if (c.value !== undefined) c.value = fn(c.value);
  }
  return g as unknown as Feature;
}
