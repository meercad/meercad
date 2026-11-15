/** The trim tool: removes the piece of a curve between the nearest intersections around the click. */
import type { SketchFeature } from "@meercad/schema";
import {
  intersectionPoints,
  trimSpline,
  type SolvedCurve,
  type SolvedSketch,
  type Vec2,
} from "@meercad/sketch";
import { refsOf, refsOfEntity } from "./geometry";
import { draftBuilder, type DraftBuilder } from "./shapes";
import type { Draft } from "./types";

/** Where another curve crosses the one being trimmed. */
interface Hit {
  pt: Vec2;
  curve: string;
}

/** Intersections this close to a curve's end (as a fraction of it, or in radians) do not cut it. */
const END_MARGIN = 1e-6;

/** The draft with the edits of one trim, shared by its steps. */
class TrimEdit {
  readonly builder: DraftBuilder;

  constructor(
    sketch: SketchFeature,
    /** The existing sketch point at a spot, if one is there. */
    private readonly pointAt: (pt: Vec2) => string | null,
  ) {
    this.builder = draftBuilder({ entities: sketch.entities, constraints: sketch.constraints });
  }

  get draft(): Draft {
    return this.builder.draft;
  }

  /** Removes an entity and every constraint that refers to it. */
  drop(id: string) {
    this.draft.entities = this.draft.entities.filter((entity) => entity.id !== id);
    this.draft.constraints = this.draft.constraints.filter((constraint) => !refsOf(constraint).includes(id));
  }

  /** The point a cut ends on: an existing sketch point there, or a new one on the crossing curve. */
  endpoint(h: Hit): string {
    const existing = this.pointAt(h.pt);

    if (
      existing &&
      existing !== "origin" &&
      this.draft.entities.some((entity) => entity.id === existing && entity.type === "point")
    ) {
      return existing;
    }

    return this.builder.point({ pos: h.pt, curve: h.curve });
  }
}

/**
 * The sketch after trimming `target` at the click `p`, or null when there is nothing to trim.
 * `pointAt` finds an existing point at a crossing, so cuts end on points that are already there.
 */
export function trimDraft(
  sketch: SketchFeature,
  shown: SolvedSketch,
  target: SolvedCurve,
  p: Vec2,
  pointAt: (pt: Vec2) => string | null,
): Draft | null {
  const others = shown.curves.filter((curve) => curve.id !== target.id && !curve.construction);
  const hits = others.flatMap((curve) =>
    intersectionPoints(target, curve).map((pt) => ({ pt, curve: curve.id })),
  );
  const edit = new TrimEdit(sketch, pointAt);

  const trimmed =
    target.kind === "line"
      ? trimLine(edit, target, p, hits)
      : target.kind === "spline"
        ? trimSplineAt(edit, target, p, hits)
        : trimRound(edit, target, p, hits);
  if (!trimmed) return null;

  dropUnusedPoints(edit, sketch);

  return edit.draft;
}

/** Cuts a line back to the crossings before and after the click; false if it is not a line any more. */
function trimLine(
  edit: TrimEdit,
  target: Extract<SolvedCurve, { kind: "line" }>,
  p: Vec2,
  hits: Hit[],
): boolean {
  const draft = edit.draft;
  const len2 = (target.b[0] - target.a[0]) ** 2 + (target.b[1] - target.a[1]) ** 2 || 1;
  const along = (q: Vec2) =>
    ((q[0] - target.a[0]) * (target.b[0] - target.a[0]) +
      (q[1] - target.a[1]) * (target.b[1] - target.a[1])) /
    len2;
  const tc = along(p);
  const inner = hits
    .map((h) => ({ ...h, t: along(h.pt) }))
    .filter((h) => h.t > END_MARGIN && h.t < 1 - END_MARGIN);
  const before = inner.filter((h) => h.t < tc).sort((a, b) => b.t - a.t)[0];
  const after = inner.filter((h) => h.t > tc).sort((a, b) => a.t - b.t)[0];
  const entity = draft.entities.find((x) => x.id === target.id);
  if (entity?.type !== "line") return false;

  if (!before && !after) {
    edit.drop(target.id);
  }
  // The new end point first: making it adds a point, which a map over the old list would lose
  // (the line then ended on a point that did not exist, and nothing was trimmed).
  else if (!before) {
    const p1 = edit.endpoint(after!);
    draft.entities = draft.entities.map((x) => (x.id === entity.id ? { ...entity, p1 } : x));
  } else if (!after) {
    const p2 = edit.endpoint(before);
    draft.entities = draft.entities.map((x) => (x.id === entity.id ? { ...entity, p2 } : x));
  } else {
    const [m1, m2] = [edit.endpoint(before), edit.endpoint(after)];
    draft.entities = draft.entities.map((x) => (x.id === entity.id ? { ...entity, p2: m1 } : x));
    edit.builder.entity(
      { type: "line", p1: m2, p2: entity.p2, ...(entity.construction ? { construction: true } : {}) },
      "l",
    );
  }

  // Length dimensions on a trimmed line no longer describe it.
  draft.constraints = draft.constraints.filter(
    (constraint) => !(constraint.type === "length" && constraint.line === target.id),
  );

  return true;
}

/** Cuts the piece of a spline around the click out; the rest become one spline per piece. */
function trimSplineAt(
  edit: TrimEdit,
  target: Extract<SolvedCurve, { kind: "spline" }>,
  p: Vec2,
  hits: Hit[],
): boolean {
  const draft = edit.draft;
  const entity = draft.entities.find((x) => x.id === target.id);
  if (entity?.type !== "spline") return false;

  const pieces = trimSpline(
    target,
    p,
    hits.map((h) => h.pt),
  );
  if (!pieces.length) edit.drop(target.id);

  const ids = pieces.map((piece) =>
    piece.map((x) => ("point" in x ? entity.points[x.point]! : edit.endpoint(hits[x.cut]!))),
  );
  // The first piece keeps the spline's id (and what refers to it), the others are new.
  draft.entities = draft.entities.map((x) =>
    x.id === entity.id && ids[0]
      ? {
          id: entity.id,
          type: "spline",
          points: ids[0],
          ...(entity.construction ? { construction: true } : {}),
        }
      : x,
  );

  for (const points of ids.slice(1)) {
    edit.builder.entity(
      { type: "spline", points, ...(entity.construction ? { construction: true } : {}) },
      "s",
    );
  }

  return true;
}

/** Cuts a circle or an arc between the crossings around the click; a cut circle stays as an arc. */
function trimRound(
  edit: TrimEdit,
  target: Extract<SolvedCurve, { kind: "circle" | "arc" }>,
  p: Vec2,
  hits: Hit[],
): boolean {
  const ang = (q: Vec2) => Math.atan2(q[1] - target.center[1], q[0] - target.center[0]);
  const norm = (a: number, from: number) => (((a - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const start = target.kind === "arc" ? target.a0 : ang(p);
  const span = target.kind === "arc" ? norm(target.a1, target.a0) || 2 * Math.PI : 2 * Math.PI;
  const ac = norm(ang(p), start);
  const inner = hits
    .map((h) => ({ ...h, a: norm(ang(h.pt), start) }))
    .filter((h) => h.a > END_MARGIN && h.a < span - END_MARGIN);
  // A circle has no ends: past the last crossing it goes on from the first one.
  const before =
    inner.filter((h) => h.a < ac).sort((x, y) => y.a - x.a)[0] ??
    (target.kind === "circle" ? inner.sort((x, y) => y.a - x.a)[0] : undefined);
  const after =
    inner.filter((h) => h.a > ac).sort((x, y) => x.a - y.a)[0] ??
    (target.kind === "circle" ? inner.sort((x, y) => x.a - y.a)[0] : undefined);
  const entity = edit.draft.entities.find((x) => x.id === target.id);
  if (!entity || (entity.type !== "circle" && entity.type !== "arc")) return false;

  if (target.kind === "circle") {
    trimCircle(edit, entity, before, after);
  } else if (entity.type === "arc") {
    trimArc(edit, entity, before, after);
  }

  return true;
}

/** Keeps the rest of the circle as an arc from the next crossing around to the previous one. */
function trimCircle(
  edit: TrimEdit,
  entity: Extract<SketchFeature["entities"][number], { type: "circle" | "arc" }>,
  before: Hit | undefined,
  after: Hit | undefined,
) {
  if (!before || !after || before === after) {
    edit.drop(entity.id);

    return;
  }

  edit.drop(entity.id);
  edit.builder.entity(
    {
      type: "arc",
      center: entity.center,
      start: edit.endpoint(after),
      end: edit.endpoint(before),
      ...(entity.construction ? { construction: true } : {}),
    },
    "a",
  );
}

/** Cuts an arc back to the crossings before and after the click, or splits it in two. */
function trimArc(
  edit: TrimEdit,
  entity: Extract<SketchFeature["entities"][number], { type: "arc" }>,
  before: Hit | undefined,
  after: Hit | undefined,
) {
  const draft = edit.draft;

  if (!before && !after) {
    edit.drop(entity.id);
  } else if (!before) {
    const start = edit.endpoint(after!);
    draft.entities = draft.entities.map((x) => (x.id === entity.id ? { ...entity, start } : x));
  } else if (!after) {
    const end = edit.endpoint(before);
    draft.entities = draft.entities.map((x) => (x.id === entity.id ? { ...entity, end } : x));
  } else {
    const [m1, m2] = [edit.endpoint(before), edit.endpoint(after)];
    draft.entities = draft.entities.map((x) => (x.id === entity.id ? { ...entity, end: m1 } : x));
    edit.builder.entity(
      {
        type: "arc",
        center: entity.center,
        start: m2,
        end: entity.end,
        ...(entity.construction ? { construction: true } : {}),
      },
      "a",
    );
  }
}

/** Drops the sketch's curve points that no curve uses any more. */
function dropUnusedPoints(edit: TrimEdit, sketch: SketchFeature) {
  const used = new Set(
    edit.draft.entities.flatMap((x) =>
      x.type === "line"
        ? [x.p1, x.p2]
        : x.type === "circle"
          ? [x.center]
          : x.type === "arc"
            ? [x.center, x.start, x.end]
            : x.type === "spline"
              ? x.points
              : [],
    ),
  );
  const orphan = sketch.entities.filter(
    (x) =>
      x.type === "point" &&
      !used.has(x.id) &&
      sketch.entities.some((entity) => entity.type !== "point" && refsOfEntity(entity).includes(x.id)),
  );
  for (const entity of orphan) edit.drop(entity.id);
}
