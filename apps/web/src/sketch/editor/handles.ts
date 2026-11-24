/**
 * Tangent handles of splines: for each point of a selected spline a short line along the curve
 * with a knob at each end. Dragging a knob gives the point its own tangent (the knob is where the
 * curve heads); double-clicking it makes the tangent automatic again.
 */
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { splineArms, tangentEnds, type SolvedSketch, type Vec2 } from "@meercad/sketch";
import type { SketchSel } from "../state";

type SplineEntity = Extract<SketchEntity, { type: "spline" }>;

/** One knob of a spline point's handle. */
export interface TangentHandle {
  spline: string;
  /** The point's index in the spline. */
  index: number;
  /** The arm the knob ends: towards the next point (`ahead`) or the previous one (`back`). */
  side: "ahead" | "back";
  /** The spline point. */
  at: Vec2;
  /** Where the knob is drawn: the arm's end, or further out along it when the arm is very short. */
  knob: Vec2;
  /** Whether the point has its own tangent (drawn stronger). */
  own: boolean;
}

/** Shortest arm drawn, in screen pixels: shorter ones are drawn this long, so the knob can be grabbed. */
export const MIN_ARM_PIXELS = 24;

/** The splines whose handles show: those selected, or one of whose points is selected. */
export function activeSplines(sketch: SketchFeature | undefined, selection: readonly SketchSel[]): string[] {
  if (!sketch) return [];

  const curves = new Set(selection.filter((s) => s.kind === "curve").map((s) => s.id));
  const points = new Set(selection.filter((s) => s.kind === "point").map((s) => s.id));

  return sketch.entities
    .filter(
      (entity): entity is SplineEntity =>
        entity.type === "spline" && (curves.has(entity.id) || entity.points.some((p) => points.has(p))),
    )
    .map((entity) => entity.id);
}

/**
 * The knobs of the given splines as `shown` solves them; `px` is one screen pixel in sketch units.
 * Ends that are tangent to another curve have none (the tangency sets their direction), open ends
 * only the arm into the curve.
 */
export function splineHandles(
  sketch: SketchFeature | undefined,
  shown: SolvedSketch,
  splines: readonly string[],
  px: number,
): TangentHandle[] {
  if (!sketch) return [];

  const out: TangentHandle[] = [];

  for (const id of splines) {
    const entity = sketch.entities.find((x) => x.id === id);
    const curve = shown.curves.find((c) => c.id === id);
    if (entity?.type !== "spline" || curve?.kind !== "spline") continue;

    const locked = tangentEnds(entity, sketch.entities, sketch.constraints);
    const arms = splineArms(curve.through, curve.closed, curve.tangents);
    const last = curve.through.length - 1;

    curve.through.forEach((at, index) => {
      if (locked.has(index)) return;

      const own = !!curve.tangents?.[index];

      for (const side of ["back", "ahead"] as const) {
        if (!curve.closed && ((side === "back" && index === 0) || (side === "ahead" && index === last))) {
          continue;
        }

        const arm = arms[index]![side];
        const len = Math.hypot(arm[0], arm[1]);
        if (!(len > 1e-12)) continue;

        const k = Math.max(1, (MIN_ARM_PIXELS * px) / len);
        out.push({ spline: id, index, side, at, knob: [at[0] + arm[0] * k, at[1] + arm[1] * k], own });
      }
    });
  }

  return out;
}

/**
 * The knob under `p` (within `tol`), unless a sketch point is nearer: a knob over its own point
 * leaves the point to be dragged.
 */
export function hitHandle(
  handles: readonly TangentHandle[],
  p: Vec2,
  tol: number,
  pointDistance = Infinity,
): TangentHandle | null {
  let best: TangentHandle | null = null;
  let bestD = Math.min(tol, pointDistance);

  for (const h of handles) {
    const d = Math.hypot(h.knob[0] - p[0], h.knob[1] - p[1]);

    if (d < bestD) {
      best = h;
      bestD = d;
    }
  }

  return best;
}

/** The tangent a knob dragged to `p` gives its point (the forward arm; a backward knob mirrors). */
export function tangentFor(h: Pick<TangentHandle, "at" | "side">, p: Vec2): [number, number] | null {
  const v: Vec2 = h.side === "ahead" ? [p[0] - h.at[0], p[1] - h.at[1]] : [h.at[0] - p[0], h.at[1] - p[1]];
  if (!(Math.hypot(v[0], v[1]) > 1e-9)) return null;

  return [round(v[0]), round(v[1])];
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The entities with the spline's point `index` given `tangent` (null: automatic). A spline left
 * with no own tangent loses the field, so it is stored as before tangents existed.
 */
export function withTangent(
  entities: readonly SketchEntity[],
  spline: string,
  index: number,
  tangent: [number, number] | null,
): SketchEntity[] {
  return entities.map((entity) => {
    if (entity.id !== spline || entity.type !== "spline") return entity;

    const tangents = entity.points.map((_, i) => (i === index ? tangent : (entity.tangents?.[i] ?? null)));
    const { tangents: _old, ...rest } = entity;

    return tangents.some((v) => !!v) ? { ...rest, tangents } : rest;
  });
}
