/**
 * Which sketch curve an edge of a part (or a picked sketch line) comes from, so its dimensions can be
 * shown and changed right on the model. Extrude and revolve tag each side face
 * "<step>.side[<sketch>.<curve>]" (":k" when one curve gives several faces, "@<copy>" on a pattern's
 * copies) and their ends "<step>.start_cap" and "<step>.end_cap": an edge between a side face and an
 * end of the same step is the sketch curve itself, one between two side faces is drawn by the sweep.
 */
import type { Feature, SketchConstraint, SketchFeature } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";

/** A sketch curve as the source of a picked edge. */
export interface SketchCurveRef {
  /** The step that made the edge (the sketch itself for a picked sketch curve). */
  featureId: string;
  sketchId: string;
  /** Null for an edge the sweep drew from a point of the sketch (an extrusion's side edge). */
  curveId: string | null;
}

/** What a part's mesh tells about its faces and edges. */
export interface EdgeTopology {
  bodyId: string;
  faceTags: readonly (readonly string[])[];
  edgeFaces: readonly (readonly number[])[];
}

const SIDE_TAG = /^([^.[\]@]+)\.side\[([^.[\]]+)\.([^[\]]+?)(?::\d+)?\](?:@.*)?$/;

/** The step, sketch and curve a side face's tag names; null for any other tag. */
export function sideTag(tag: string): { featureId: string; sketchId: string; curveId: string } | null {
  const match = SIDE_TAG.exec(tag);

  return match ? { featureId: match[1]!, sketchId: match[2]!, curveId: match[3]! } : null;
}

/** The curve of `sketchId` whose sweep by `featureId` made a face with these tags. */
export function curveOfFace(tags: readonly string[], featureId: string, sketchId: string): string | null {
  for (const tag of tags) {
    const side = sideTag(tag);
    if (side?.featureId === featureId && side.sketchId === sketchId) return side.curveId;
  }

  return null;
}

/** A tag without the mark a pattern's copy adds ("@lp1.1"). */
const original = (tag: string) => tag.replace(/@.*$/, "");

/** True when a face with these tags is an end (cap) of the step `featureId`. */
const isCapOf = (tags: readonly string[], featureId: string) =>
  tags.some((tag) => {
    const name = original(tag);

    return name === `${featureId}.start_cap` || name === `${featureId}.end_cap`;
  });

/** The sketch curve the edge `edge` of a part was made from, or null when no sweep of a sketch made it. */
export function curveOfEdge(
  mesh: EdgeTopology,
  edge: number,
  features: readonly Feature[],
): SketchCurveRef | null {
  const faces = (mesh.edgeFaces[edge] ?? []).map((face) => mesh.faceTags[face] ?? []);
  if (faces.length !== 2) return null;

  const [first, second] = faces as [readonly string[], readonly string[]];
  const candidates = [...sweptFrom(first, second), ...sweptFrom(second, first)];

  return latestValid(candidates, features);
}

/** What an edge between a face with tags `side` and one with tags `other` was swept from. */
function sweptFrom(side: readonly string[], other: readonly string[]): SketchCurveRef[] {
  const found: SketchCurveRef[] = [];

  for (const tag of side) {
    const ref = sideTag(tag);
    if (!ref) continue;

    if (isCapOf(other, ref.featureId)) {
      found.push(ref);
    } else if (other.some((x) => sideTag(x)?.featureId === ref.featureId)) {
      found.push({ ...ref, curveId: null });
    }
  }

  return found;
}

/**
 * The candidate of the latest step (it shaped the edge last), a curve before a sweep's side edge;
 * only steps and sketches the design still has.
 */
function latestValid(candidates: SketchCurveRef[], features: readonly Feature[]): SketchCurveRef | null {
  const sketches = new Set(features.filter((x) => x.op === "sketch").map((x) => x.id));

  for (let i = features.length - 1; i >= 0; i--) {
    const own = candidates.filter((x) => x.featureId === features[i]!.id && sketches.has(x.sketchId));
    const best = own.find((x) => x.curveId !== null) ?? own[0];
    if (best) return best;
  }

  return null;
}

/** The sketch curve behind a pick: an edge of a part, or a curve of a sketch shown in the view. */
export function curveOfPick(
  pick: Pick,
  meshes: readonly EdgeTopology[],
  features: readonly Feature[],
): SketchCurveRef | null {
  if (pick.kind === "sketch_curve") {
    return { featureId: pick.sketchId, sketchId: pick.sketchId, curveId: pick.curveId };
  }

  if (pick.kind !== "edge") return null;

  const mesh = meshes.find((x) => x.bodyId === pick.bodyId);

  return mesh ? curveOfEdge(mesh, pick.edge, features) : null;
}

/** The points that bound a sketch entity (none for a point or a spline). */
export function pointsOf(entity: SketchFeature["entities"][number]): string[] {
  if (entity.type === "line") return [entity.p1, entity.p2];
  if (entity.type === "circle") return [entity.center];
  if (entity.type === "arc") return [entity.center, entity.start, entity.end];

  return [];
}

/** Fields of a constraint that hold no entity id. */
const NOT_REFS = new Set(["id", "type", "label", "axis", "value"]);

/** Entity ids a constraint refers to ("l1.p1" counts as "l1"). */
export function constraintRefs(constraint: SketchConstraint): string[] {
  return Object.entries(constraint)
    .filter(([key, value]) => !NOT_REFS.has(key) && typeof value === "string")
    .map(([, value]) => (value as string).split(".")[0]!);
}

/** Constraint types that set a curve's size by a value. */
const SIZES = new Set(["length", "radius", "diameter"]);

/**
 * Ids of the constraints that size the curve `curveId`: those on the curve, those only between its
 * own points (a distance from one end to the other), and sizes set on a curve it is equal to.
 */
export function constraintsOfCurve(sketch: SketchFeature, curveId: string): Set<string> {
  const entity = sketch.entities.find((x) => x.id === curveId);
  const ends = new Set(entity ? pointsOf(entity) : []);
  const partners = new Set(
    sketch.constraints.flatMap((constraint) =>
      constraint.type === "equal" && (constraint.a === curveId || constraint.b === curveId)
        ? [constraint.a, constraint.b]
        : [],
    ),
  );
  const ids = new Set<string>();

  for (const constraint of sketch.constraints) {
    const refs = constraintRefs(constraint).filter((ref) => ref !== "origin");
    const onCurve = refs.includes(curveId);
    const betweenEnds = refs.length > 0 && refs.every((ref) => ends.has(ref));
    const viaEqual = SIZES.has(constraint.type) && partners.has(refs[0]!);
    if (onCurve || betweenEnds || viaEqual) ids.add(constraint.id);
  }

  return ids;
}

/** Constraint types that fix a curve's size. */
const SIZING = new Set(["length", "distance", "radius", "diameter", "equal"]);

/** True when nothing fixes the size of the curve yet, so its measured size may become a dimension. */
export function needsSize(sketch: SketchFeature, curveId: string): boolean {
  const ids = constraintsOfCurve(sketch, curveId);

  return !sketch.constraints.some((constraint) => ids.has(constraint.id) && SIZING.has(constraint.type));
}
