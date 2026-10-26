import type {
  ChamferFeature,
  CircularPatternFeature,
  Expr,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  LinearPatternFeature,
  PlaneFeature,
  RevolveFeature,
  ShellFeature,
  SketchConstraint,
  SketchFeature,
} from "@opencad/schema";
import { evaluate, ExprError } from "./expr.js";

/** `T` with the expression fields `K` evaluated to numbers. */
type R<T, K extends keyof T> = Omit<T, K> & { [P in K]: undefined extends T[P] ? number | undefined : number };

export type ResolvedSketchConstraint = SketchConstraint extends infer C ? (C extends { value: Expr } ? R<C, "value"> : C) : never;
export type ResolvedSketch = Omit<SketchFeature, "constraints"> & { constraints: ResolvedSketchConstraint[] };
export type ResolvedPlane = R<PlaneFeature, "offset" | "angle">;
export type ResolvedExtrude = R<ExtrudeFeature, "distance" | "distance2">;
export type ResolvedRevolve = R<RevolveFeature, "angle">;
export type ResolvedFillet = R<FilletFeature, "radius">;
export type ResolvedChamfer = R<ChamferFeature, "distance">;
export type ResolvedShell = R<ShellFeature, "thickness">;
export type ResolvedLinearPattern = R<LinearPatternFeature, "count" | "spacing" | "count2" | "spacing2">;
export type ResolvedCircularPattern = R<CircularPatternFeature, "count" | "angle">;
export type ResolvedFeature =
  | ResolvedSketch
  | ResolvedPlane
  | ResolvedExtrude
  | ResolvedRevolve
  | ResolvedFillet
  | ResolvedChamfer
  | ResolvedShell
  | ResolvedLinearPattern
  | ResolvedCircularPattern
  | Extract<Feature, { op: "mirror" | "boolean" | "import" }>;

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
      return { ...f, radius: ev("radius", f.radius) };
    case "chamfer":
      return { ...f, distance: ev("distance", f.distance) };
    case "shell":
      return { ...f, thickness: ev("thickness", f.thickness) };
    case "linear_pattern":
      return { ...f, count: count("count", f.count)!, spacing: ev("spacing", f.spacing), count2: count("count2", f.count2), spacing2: opt("spacing2", f.spacing2) };
    case "circular_pattern":
      return { ...f, count: count("count", f.count)!, angle: opt("angle", f.angle) };
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
    fillet: ["radius"],
    chamfer: ["distance"],
    shell: ["thickness"],
    linear_pattern: ["count", "spacing", "count2", "spacing2"],
    circular_pattern: ["count", "angle"],
  };
  for (const k of keys[f.op] ?? []) if (g[k] !== undefined) g[k] = fn(g[k] as Expr);
  if (f.op === "sketch") {
    for (const c of g["constraints"] as { value?: Expr }[]) if (c.value !== undefined) c.value = fn(c.value);
  }
  return g as unknown as Feature;
}
