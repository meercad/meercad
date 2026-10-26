import type { ExtrudeFeature, Expr, Feature, FilletFeature, SketchFeature } from "@opencad/schema";
import { evaluate, ExprError } from "./expr.js";

export interface ResolvedRectangle {
  id: string;
  type: "rectangle";
  corner: [number, number];
  size: [number, number];
}
export type ResolvedSketch = Omit<SketchFeature, "entities"> & { entities: ResolvedRectangle[] };
export type ResolvedExtrude = Omit<ExtrudeFeature, "distance"> & { distance: number };
export type ResolvedFillet = Omit<FilletFeature, "radius"> & { radius: number };
export type ResolvedFeature = ResolvedSketch | ResolvedExtrude | ResolvedFillet;

/** Replaces every expression in a feature by its numeric value (mm). Throws ExprError naming the field. */
export function resolveFeature(f: Feature, scope: ReadonlyMap<string, number>): ResolvedFeature {
  const ev = (field: string, e: Expr) => {
    try {
      return evaluate(e, scope);
    } catch (err) {
      throw new ExprError(`${field}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  switch (f.op) {
    case "sketch":
      return {
        ...f,
        entities: f.entities.map((e) => ({
          ...e,
          corner: [ev(`${e.id}.corner[0]`, e.corner[0]), ev(`${e.id}.corner[1]`, e.corner[1])],
          size: [ev(`${e.id}.size[0]`, e.size[0]), ev(`${e.id}.size[1]`, e.size[1])],
        })),
      };
    case "extrude":
      return { ...f, distance: ev("distance", f.distance) };
    case "fillet":
      return { ...f, radius: ev("radius", f.radius) };
  }
}
