import type {
  AxisRef,
  ChamferFeature,
  CircularPatternFeature,
  Expr,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  GearFeature,
  HoleFeature,
  DraftFeature,
  OffsetFaceFeature,
  TextFeature,
  StandardPartFeature,
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
  ThreadFeature,
  SketchFeature,
  TransformFeature,
} from "@meercad/schema";
import { evaluate, ExprError } from "./expr.js";

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
export type ResolvedThread = R<ThreadFeature, "pitch" | "length" | "clearance">;
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
export type ResolvedStandardPart = Omit<StandardPartFeature, "points" | "length" | "diameter" | "height"> & { points: [number, number][]; length?: number; diameter?: number; height?: number };
export type ResolvedText = Omit<TextFeature, "position" | "size" | "angle" | "depth"> & { position: [number, number]; size: number; angle: number; depth: number };
export type ResolvedMeshConvert = R<MeshConvertFeature, "tolerance" | "angle">;
export type ResolvedBend = R<BendFeature, "angle" | "radius" | "gap" | "tolerance">;
export type ResolvedTransform = Omit<TransformFeature, "translate" | "rotate"> & { translate?: [number, number, number]; rotate?: { axis: AxisRef; angle: number } };
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
  | ResolvedLinearPattern
  | ResolvedCircularPattern
  | ResolvedMeshConvert
  | ResolvedBend
  | ResolvedHole
  | ResolvedRib
  | ResolvedDraft
  | ResolvedOffsetFace
  | ResolvedText
  | ResolvedStandardPart
  | ResolvedAlign
  | ResolvedScale
  | Extract<Feature, { op: "mirror" | "boolean" | "delete" | "import" | "loft" | "sweep" | "split" }>;

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
      return { ...f, pitch: opt("pitch", f.pitch), length: opt("length", f.length), clearance: opt("clearance", f.clearance) };
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
    case "draft":
      return { ...f, angle: ev("angle", f.angle) };
    case "offset_face":
      return { ...f, distance: ev("distance", f.distance) };
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
      };
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
    thread: ["pitch", "length", "clearance"],
    gear: ["module", "teeth", "width", "pressureAngle", "profileShift", "helix", "backlash", "clearance", "rotation", "rim", "chamfer"],
    linear_pattern: ["count", "spacing", "count2", "spacing2"],
    circular_pattern: ["count", "angle"],
    mesh_convert: ["tolerance", "angle"],
    bend: ["angle", "radius", "gap", "tolerance"],
    hole: ["diameter", "depth", "allowance"],
    rib: ["thickness"],
    draft: ["angle"],
    offset_face: ["distance"],
    text: ["size", "angle", "depth"],
    standard_part: ["length", "diameter", "height"],
    align: ["offset", "angle"],
    scale: ["factor"],
  };
  if (f.op === "transform") {
    if (Array.isArray(g["translate"])) g["translate"] = (g["translate"] as Expr[]).map(fn);
    const rot = g["rotate"] as { angle: Expr } | undefined;
    if (rot) rot.angle = fn(rot.angle);
  }
  if (f.op === "text" && Array.isArray(g["position"])) g["position"] = (g["position"] as Expr[]).map(fn);
  if (f.op === "standard_part") g["points"] = (g["points"] as Expr[][]).map((pt) => pt.map(fn));
  if (f.op === "hole") g["points"] = (g["points"] as Expr[][]).map((pt) => pt.map(fn));
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
