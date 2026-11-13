/**
 * Dragging the end face of an extrusion changes that extrusion, not the part as a new step: a
 * plate 5 mm thick made with `thickness` gets thicker through `thickness`, so holes cut through it
 * later still go through. Only when nothing can be changed in place does a drag add a step.
 */
import type { DocOp, Expr, Feature, LengthUnit, MeercadDocument } from "@meercad/schema";
import { lengthValue } from "./units";

export interface CapDrag {
  /** The extrusion whose end face was grabbed. */
  feature: string;
  /** The variable its distance is (when it is one), changed instead of the feature. */
  param: string | null;
  /** Its distance now, in mm. */
  distance: number;
  /** The change that sets the distance to `mm`. */
  write: (mm: number) => DocOp;
}

/**
 * What a drag on a flat face with these tags changes in place, or null when the drag should add a
 * new push/pull step (not an end face, the distance is a formula, or several steps share the face).
 */
export function capDrag(
  doc: MeercadDocument,
  tags: readonly string[],
  value: (expr: Expr) => number,
  unit: LengthUnit = "mm",
): CapDrag | null {
  const caps = new Set<string>();

  for (const tag of tags) {
    // Faces of pattern and mirror copies (`…@lp1.2`) belong to the copy, not to the extrusion itself.
    const match = /^([\w-]+)\.end_cap$/.exec(tag);
    if (match) caps.add(match[1]!);
  }

  if (caps.size !== 1) return null;

  const id = [...caps][0]!;
  const feature = doc.features.find(
    (x): x is Extract<Feature, { op: "extrude" }> => x.id === id && x.op === "extrude",
  );

  if (
    !feature ||
    feature.extent !== "blind" ||
    feature.suppressed ||
    (feature.mode !== "new_body" && feature.mode !== "join")
  ) {
    return null;
  }

  let distance: number;

  try {
    distance = value(feature.distance);
  } catch {
    return null;
  }

  const expr = feature.distance;

  if (typeof expr === "string" && expr.trim() in doc.params) {
    const param = expr.trim();
    const old = doc.params[param];

    return {
      feature: id,
      param,
      distance,
      // An inch design writes inches; a mm design keeps the variable's "mm" (or a bare number).
      write: (mm) => ({
        type: "set_param",
        name: param,
        expr:
          unit === "in"
            ? lengthValue(round(mm), "in")
            : typeof old === "string" && /mm\b/.test(old)
              ? `${round(mm)} mm`
              : round(mm),
      }),
    };
  }

  // A formula ("wall * 2") has no single value to set: that drag adds a step as before.
  if (typeof expr !== "number" && !/^\s*-?\d+(\.\d+)?\s*(mm)?\s*$/.test(expr)) return null;

  return {
    feature: id,
    param: null,
    distance,
    write: (mm) => ({
      type: "edit_feature",
      id,
      patch: { distance: unit === "in" ? lengthValue(round(mm), "in") : round(mm) },
    }),
  };
}

const round = (mm: number) => +mm.toFixed(3);
