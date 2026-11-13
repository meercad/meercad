/**
 * Sketch solving with FreeCAD's PlaneGCS. The document stores solved coordinates (as initial
 * guess) plus constraints; every rebuild and every drag re-solves.
 */

import {
  Algorithm,
  GcsWrapper,
  init_planegcs_module,
  SolveStatus,
  type SketchPrimitive,
} from "@salusoft89/planegcs";
import type { SketchConstraint, SketchEntity } from "@meercad/schema";
import {
  splinePoints,
  sweep,
  type SolvedCurve,
  type SolvedSketch,
  type Vec2,
  cross2,
  distance2,
  dot2,
  sub2,
} from "./geometry.js";

/** A sketch constraint whose expression has been evaluated (mm / degrees). */
export type ResolvedConstraint = SketchConstraint extends infer C
  ? C extends { value: unknown }
    ? Omit<C, "value"> & { value: number }
    : C
  : never;

export interface SolveInput {
  entities: readonly SketchEntity[];
  constraints: readonly ResolvedConstraint[];
  /** Fixed reference geometry (projected model edges), already in sketch coordinates. */
  external?: readonly SolvedCurve[];
}

export interface SolveOptions {
  /** Temporary targets for dragged points (weak constraints; other constraints win). */
  drag?: Record<string, Vec2>;
  /** Temporary radius target for a dragged circle/arc. */
  dragRadius?: { curve: string; radius: number };
}

type Prim = SketchPrimitive & { id: string };

export class SketchSolveError extends Error {}

/** Wraps one PlaneGCS instance. Not re-entrant; create one per thread. */
export class SketchSolver {
  private constructor(private readonly wrapper: GcsWrapper) {}

  static async create(wasmUrl?: string): Promise<SketchSolver> {
    const mod = await init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);

    return new SketchSolver(new GcsWrapper(new mod.GcsSystem()));
  }

  solve(input: SolveInput, opts: SolveOptions = {}): SolvedSketch {
    const built = buildPrimitives(input, opts);
    const w = this.wrapper;
    w.clear_data();
    w.push_primitives_and_params(built.prims);

    let status = w.solve(Algorithm.DogLeg);
    if (status === SolveStatus.Failed) status = w.solve(Algorithm.LevenbergMarquardt);

    const ok = status === SolveStatus.Success || status === SolveStatus.Converged;
    if (ok) w.apply_solution();

    const unmap = (ids: string[]) => [
      ...new Set(ids.map((i) => i.split("#")[0]!).filter((i) => built.userConstraints.has(i))),
    ];
    const conflicting = unmap(w.get_gcs_conflicting_constraints());
    const redundant = unmap(w.get_gcs_redundant_constraints());
    const dof = w.gcs.dof();

    const values = new Map<string, Prim>();
    for (const p of w.sketch_index.get_primitives() as Prim[]) values.set(p.id, p);

    const points = new Map<string, Vec2>();
    for (const [id, p] of values) if (p.type === "point") points.set(id, [p.x, p.y]);

    const pt = (id: string): Vec2 => points.get(id) ?? [0, 0];

    const curves: SolvedCurve[] = [];

    for (const entity of input.entities) {
      const construction = !!entity.construction;

      if (entity.type === "line") {
        curves.push({
          id: entity.id,
          kind: "line",
          a: pt(entity.p1),
          b: pt(entity.p2),
          p1: entity.p1,
          p2: entity.p2,
          construction,
          external: false,
        });
      } else if (entity.type === "circle") {
        const c = values.get(entity.id) as { radius: number } | undefined;
        curves.push({
          id: entity.id,
          kind: "circle",
          center: pt(entity.center),
          radius: c?.radius ?? entity.radius,
          c: entity.center,
          construction,
          external: false,
        });
      } else if (entity.type === "arc") {
        const a = values.get(entity.id) as
          { radius: number; start_angle: number; end_angle: number } | undefined;

        if (a) {
          curves.push({
            id: entity.id,
            kind: "arc",
            center: pt(entity.center),
            radius: a.radius,
            a0: a.start_angle,
            a1: a.end_angle,
            c: entity.center,
            start: entity.start,
            end: entity.end,
            construction,
            external: false,
          });
        }
      } else if (entity.type === "spline") {
        const through = entity.points.map(pt);
        curves.push({
          id: entity.id,
          kind: "spline",
          pts: splinePoints(through, !!entity.closed),
          through,
          points: entity.points,
          closed: !!entity.closed,
          construction,
          external: false,
        });
      }
    }

    for (const x of input.external ?? []) curves.push(x);

    // Expose curve characteristic points under their reference names too ("l1.p1", "c1.center").
    for (const curve of curves) {
      if (curve.kind === "spline") continue;

      if (curve.kind === "line") {
        points.set(`${curve.id}.p1`, curve.a);
        points.set(`${curve.id}.p2`, curve.b);
      } else {
        points.set(`${curve.id}.center`, curve.center);

        if (curve.kind === "arc") {
          points.set(`${curve.id}.start`, [
            curve.center[0] + curve.radius * Math.cos(curve.a0),
            curve.center[1] + curve.radius * Math.sin(curve.a0),
          ]);
          points.set(`${curve.id}.end`, [
            curve.center[0] + curve.radius * Math.cos(curve.a1),
            curve.center[1] + curve.radius * Math.sin(curve.a1),
          ]);
        }
      }
    }

    points.set("origin", [0, 0]);

    const message = !ok
      ? conflicting.length
        ? `conflicting constraints: ${conflicting.join(", ")}`
        : "sketch could not be solved"
      : conflicting.length
        ? `conflicting constraints: ${conflicting.join(", ")}`
        : undefined;

    return {
      points,
      curves,
      diagnostics: {
        dof: Math.max(0, dof),
        ok: ok && !conflicting.length,
        conflicting,
        redundant,
        ...(message ? { message } : {}),
      },
    };
  }
}

type CurveKind = "line" | "circle" | "arc";
type TypedConstraint<T extends ResolvedConstraint["type"]> = Extract<ResolvedConstraint, { type: T }>;

function buildPrimitives(
  input: SolveInput,
  opts: SolveOptions,
): { prims: Prim[]; userConstraints: Set<string> } {
  const builder = new PrimitiveBuilder();

  builder.addPoints(input.entities);
  builder.addCurves(input.entities);
  builder.addExternalCurves(input.external ?? []);
  builder.recordPointCoordinates();

  const userConstraints = new Set<string>();

  for (const constraint of input.constraints) {
    userConstraints.add(constraint.id);
    builder.addConstraint(constraint);
  }

  builder.addDragTargets(opts);

  return { prims: builder.primitives(), userConstraints };
}

/**
 * Translates a sketch into the solver's primitives: points, then curves, then constraints. The
 * origin and its two axes are fixed geometry every sketch has.
 */
class PrimitiveBuilder {
  private readonly points: Prim[] = [
    { id: "origin", type: "point", x: 0, y: 0, fixed: true },
    { id: "origin.xp", type: "point", x: 1, y: 0, fixed: true },
    { id: "origin.yp", type: "point", x: 0, y: 1, fixed: true },
  ];

  private readonly curves: Prim[] = [
    { id: "origin.x", type: "line", p1_id: "origin", p2_id: "origin.xp" },
    { id: "origin.y", type: "line", p1_id: "origin", p2_id: "origin.yp" },
  ];

  private readonly constraints: Prim[] = [];
  private readonly kinds = new Map<string, CurveKind>([
    ["origin.x", "line"],
    ["origin.y", "line"],
  ]);

  /** Per curve: the point ids behind its named points ("p1", "center", "start" …). */
  private readonly curvePoints = new Map<string, Record<string, string>>();
  /** Open splines' point ids; the solver only sees their points, and their ends for tangency. */
  private readonly splines = new Map<string, readonly string[]>();
  private readonly coordinates = new Map<string, Vec2>([["origin", [0, 0]]]);

  primitives(): Prim[] {
    return [...this.points, ...this.curves, ...this.constraints];
  }

  addPoints(entities: readonly SketchEntity[]): void {
    for (const entity of entities) {
      if (entity.type === "point") {
        this.points.push({ id: entity.id, type: "point", x: entity.x, y: entity.y, fixed: false });
        this.coordinates.set(entity.id, [entity.x, entity.y]);
      }
    }
  }

  addCurves(entities: readonly SketchEntity[]): void {
    for (const entity of entities) {
      if (entity.type === "line") {
        this.curves.push({ id: entity.id, type: "line", p1_id: entity.p1, p2_id: entity.p2 });
        this.kinds.set(entity.id, "line");
        this.curvePoints.set(entity.id, { p1: entity.p1, p2: entity.p2 });
      } else if (entity.type === "circle") {
        this.curves.push({ id: entity.id, type: "circle", c_id: entity.center, radius: entity.radius });
        this.kinds.set(entity.id, "circle");
        this.curvePoints.set(entity.id, { center: entity.center });
      } else if (entity.type === "arc") {
        this.addArc(entity);
      } else if (entity.type === "spline" && !entity.closed && entity.points.length >= 2) {
        this.splines.set(entity.id, entity.points);
      }
    }
  }

  private addArc(arc: Extract<SketchEntity, { type: "arc" }>): void {
    const center = this.at(arc.center);
    const start = this.at(arc.start);
    const end = this.at(arc.end);
    const radius = distance2(center, start) || 1;
    const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
    const endAngle = startAngle + sweep(startAngle, Math.atan2(end[1] - center[1], end[0] - center[0]));

    this.curves.push({
      id: arc.id,
      type: "arc",
      c_id: arc.center,
      start_id: arc.start,
      end_id: arc.end,
      radius,
      start_angle: startAngle,
      end_angle: endAngle,
    });
    this.constraints.push({ id: `${arc.id}#rules`, type: "arc_rules", a_id: arc.id });
    this.kinds.set(arc.id, "arc");
    this.curvePoints.set(arc.id, { center: arc.center, start: arc.start, end: arc.end });
  }

  /** Projected model edges: fixed points and curves the sketch can refer to. */
  addExternalCurves(external: readonly SolvedCurve[]): void {
    for (const curve of external) {
      // Projected model edges are lines, circles and arcs only.
      if (curve.kind === "spline") continue;

      if (curve.kind === "line") {
        this.addExternalLine(curve);
      } else {
        this.addExternalRound(curve);
      }

      for (const [name, pointId] of Object.entries(this.curvePoints.get(curve.id) ?? {})) {
        this.coordinates.set(`${curve.id}.${name}`, this.at(pointId));
      }

      this.kinds.set(curve.id, curve.kind);
    }
  }

  private addExternalLine(line: Extract<SolvedCurve, { kind: "line" }>): void {
    const p1 = `${line.id}.p1`;
    const p2 = `${line.id}.p2`;

    this.points.push(
      { id: p1, type: "point", x: line.a[0], y: line.a[1], fixed: true },
      { id: p2, type: "point", x: line.b[0], y: line.b[1], fixed: true },
    );
    this.curves.push({ id: line.id, type: "line", p1_id: p1, p2_id: p2 });
    this.curvePoints.set(line.id, { p1, p2 });
  }

  private addExternalRound(round: Extract<SolvedCurve, { kind: "circle" | "arc" }>): void {
    const center = `${round.id}.center`;

    this.points.push({ id: center, type: "point", x: round.center[0], y: round.center[1], fixed: true });

    if (round.kind === "circle") {
      this.curves.push({ id: round.id, type: "circle", c_id: center, radius: round.radius });
      this.curvePoints.set(round.id, { center });
    } else {
      const start = `${round.id}.start`;
      const end = `${round.id}.end`;
      const startAt = pointOnCircle(round.center, round.radius, round.a0);
      const endAt = pointOnCircle(round.center, round.radius, round.a1);

      this.points.push(
        { id: start, type: "point", x: startAt[0], y: startAt[1], fixed: true },
        { id: end, type: "point", x: endAt[0], y: endAt[1], fixed: true },
      );
      this.curves.push({
        id: round.id,
        type: "arc",
        c_id: center,
        start_id: start,
        end_id: end,
        radius: round.radius,
        start_angle: round.a0,
        end_angle: round.a1,
      });
      this.curvePoints.set(round.id, { center, start, end });
    }

    // Fixed radius for external circles/arcs.
    this.constraints.push({
      id: `${round.id}#r`,
      type: round.kind === "circle" ? "circle_radius" : "arc_radius",
      ...(round.kind === "circle" ? { c_id: round.id } : { a_id: round.id }),
      radius: round.radius,
    } as Prim);
  }

  /** After all points are known: where each one lies, as the starting guess for the solver. */
  recordPointCoordinates(): void {
    for (const point of this.points) {
      if (point.type === "point") this.coordinates.set(point.id, [point.x, point.y]);
    }
  }

  private at(pointId: string): Vec2 {
    return this.coordinates.get(pointId) ?? [0, 0];
  }

  /** "l1.p1" → underlying point id; plain point ids pass through. */
  private pointId(ref: string): string {
    const dot = ref.lastIndexOf(".");

    if (dot > 0) {
      const mapped = this.curvePoints.get(ref.slice(0, dot))?.[ref.slice(dot + 1)];
      if (mapped) return mapped;
    }

    if (!this.coordinates.has(ref)) throw new SketchSolveError(`unknown point "${ref}"`);

    return ref;
  }

  private kindOf(curveId: string): CurveKind {
    const kind = this.kinds.get(curveId);
    if (!kind) throw new SketchSolveError(`unknown curve "${curveId}"`);

    return kind;
  }

  private lineEnds(lineId: string): [Vec2, Vec2] {
    const named = this.curvePoints.get(lineId);

    if (lineId === "origin.x") {
      return [
        [0, 0],
        [1, 0],
      ];
    }

    if (lineId === "origin.y") {
      return [
        [0, 0],
        [0, 1],
      ];
    }

    return [this.at(named?.["p1"] ?? ""), this.at(named?.["p2"] ?? "")];
  }

  /** Adds a solver constraint for `constraint`; a second one for the same constraint gets `part` 1, 2 … */
  private add(constraint: ResolvedConstraint, primitive: Record<string, unknown>, part = 0): void {
    const id = part ? `${constraint.id}#${part}` : constraint.id;

    this.constraints.push({ ...primitive, id } as Prim);
  }

  addConstraint(constraint: ResolvedConstraint): void {
    switch (constraint.type) {
      case "coincident":
        this.add(constraint, {
          type: "p2p_coincident",
          p1_id: this.pointId(constraint.a),
          p2_id: this.pointId(constraint.b),
        });
        break;
      case "horizontal":
      case "vertical":
        this.kindOf(constraint.line);
        this.add(constraint, {
          type: constraint.type === "horizontal" ? "horizontal_l" : "vertical_l",
          l_id: constraint.line,
        });
        break;
      case "horizontal_points":
      case "vertical_points":
        this.add(constraint, {
          type: constraint.type === "horizontal_points" ? "horizontal_pp" : "vertical_pp",
          p1_id: this.pointId(constraint.a),
          p2_id: this.pointId(constraint.b),
        });
        break;
      case "parallel":
        this.add(constraint, { type: "parallel", l1_id: constraint.a, l2_id: constraint.b });
        break;
      case "perpendicular":
        this.add(constraint, { type: "perpendicular_ll", l1_id: constraint.a, l2_id: constraint.b });
        break;
      case "collinear":
        this.add(constraint, { type: "parallel", l1_id: constraint.a, l2_id: constraint.b });
        this.add(
          constraint,
          { type: "point_on_line_pl", p_id: this.pointId(`${constraint.b}.p1`), l_id: constraint.a },
          1,
        );
        break;
      case "tangent":
        this.addTangent(constraint);
        break;
      case "equal":
        this.addEqual(constraint);
        break;
      case "point_on":
        this.addPointOn(constraint);
        break;
      case "midpoint": {
        const ends = this.curvePoints.get(constraint.line);

        if (this.kindOf(constraint.line) !== "line" || !ends) {
          throw new SketchSolveError(`midpoint ${constraint.id}: needs a line`);
        }

        this.add(constraint, {
          type: "p2p_symmetric_ppp",
          p1_id: ends["p1"],
          p2_id: ends["p2"],
          p_id: this.pointId(constraint.point),
        });
        break;
      }
      case "symmetric":
        this.add(constraint, {
          type: "p2p_symmetric_ppl",
          p1_id: this.pointId(constraint.a),
          p2_id: this.pointId(constraint.b),
          l_id: constraint.axis,
        });
        break;
      case "fix": {
        const point = this.pointId(constraint.point);
        const [x, y] = this.at(point);

        this.add(constraint, { type: "coordinate_x", p_id: point, x });
        this.add(constraint, { type: "coordinate_y", p_id: point, y }, 1);
        break;
      }
      case "distance":
        this.addDistance(constraint);
        break;
      case "length": {
        const ends = this.curvePoints.get(constraint.line);

        if (this.kindOf(constraint.line) !== "line" || !ends) {
          throw new SketchSolveError(`length ${constraint.id}: needs a line`);
        }

        this.add(constraint, {
          type: "p2p_distance",
          p1_id: ends["p1"],
          p2_id: ends["p2"],
          distance: constraint.value,
        });
        break;
      }
      case "radius":
      case "diameter": {
        const kind = this.kindOf(constraint.curve);

        if (kind === "line") {
          throw new SketchSolveError(`${constraint.type} ${constraint.id}: needs a circle or arc`);
        }

        const radius = constraint.type === "radius" ? constraint.value : constraint.value / 2;

        this.add(
          constraint,
          kind === "circle"
            ? { type: "circle_radius", c_id: constraint.curve, radius }
            : { type: "arc_radius", a_id: constraint.curve, radius },
        );
        break;
      }
      case "angle":
        this.addAngle(constraint);
        break;
      case "arc_angle": {
        if (this.kindOf(constraint.curve) !== "arc") {
          throw new SketchSolveError(`arc_angle ${constraint.id}: needs an arc`);
        }

        this.add(constraint, {
          type: "difference",
          param1: { o_id: constraint.curve, prop: "start_angle" },
          param2: { o_id: constraint.curve, prop: "end_angle" },
          difference: (constraint.value * Math.PI) / 180,
        });
        break;
      }
    }
  }

  /** The ids of a curve's two end points (a spline's first and last point). */
  private endPoints(curveId: string): string[] {
    const spline = this.splines.get(curveId);
    if (spline) return [spline[0]!, spline[spline.length - 1]!];

    const named = this.curvePoints.get(curveId) ?? {};

    return [named["p1"] ?? named["start"], named["p2"] ?? named["end"]].filter(
      (pointId): pointId is string => !!pointId,
    );
  }

  /**
   * The curve the solver uses for tangency at `curveId`. A spline end leaves towards its
   * neighbouring point, so tangency there is that of the line between the two, standing in for
   * the spline; every other curve stands for itself.
   */
  private tangencyCurve(constraint: ResolvedConstraint, curveId: string, otherId: string): string {
    const spline = this.splines.get(curveId);
    if (!spline) return curveId;

    const shared = this.endPoints(curveId).find((pointId) => this.endPoints(otherId).includes(pointId));

    if (!shared) {
      throw new SketchSolveError(`tangent ${constraint.id}: the spline must end where the other curve ends`);
    }

    const standInId = `${curveId}#${shared}`;

    if (!this.kinds.has(standInId)) {
      const next = shared === spline[0] ? spline[1]! : spline[spline.length - 2]!;

      this.curves.push({ id: standInId, type: "line", p1_id: shared, p2_id: next });
      this.kinds.set(standInId, "line");
      this.curvePoints.set(standInId, { p1: shared, p2: next });
    }

    return standInId;
  }

  private addTangent(constraint: TypedConstraint<"tangent">): void {
    const curveA = this.tangencyCurve(constraint, constraint.a, constraint.b);
    const curveB = this.tangencyCurve(constraint, constraint.b, constraint.a);
    const kindA = this.kindOf(curveA);
    const kindB = this.kindOf(curveB);
    const usesStandIn = curveA !== constraint.a || curveB !== constraint.b;

    if (usesStandIn && kindA === "line" && kindB === "line") {
      // They share the end point: parallel makes them run on in one line.
      this.add(constraint, { type: "parallel", l1_id: curveA, l2_id: curveB });

      return;
    }

    if (kindA === "line" && kindB === "line") {
      throw new SketchSolveError(`tangent ${constraint.id}: needs a circle or arc`);
    }

    if (kindA === "line") {
      this.addLineTangent(constraint, curveA, curveB, kindB);
    } else if (kindB === "line") {
      this.addLineTangent(constraint, curveB, curveA, kindA);
    } else if (kindA === "circle" && kindB === "circle") {
      this.add(constraint, { type: "tangent_cc", c1_id: curveA, c2_id: curveB });
    } else if (kindA === "arc" && kindB === "arc") {
      this.add(constraint, { type: "tangent_aa", a1_id: curveA, a2_id: curveB });
    } else {
      this.add(constraint, {
        type: "tangent_ca",
        c_id: kindA === "circle" ? curveA : curveB,
        a_id: kindA === "arc" ? curveA : curveB,
      });
    }
  }

  private addLineTangent(
    constraint: ResolvedConstraint,
    lineId: string,
    roundId: string,
    roundKind: CurveKind,
  ): void {
    // A line ending where the arc ends (a rounded corner): tangent at that point. "Tangent to
    // the circle" there would duplicate the point being on both, which the solver reports as
    // redundant.
    const linePoints = this.curvePoints.get(lineId) ?? {};
    const arcPoints = this.curvePoints.get(roundId) ?? {};
    const shared =
      roundKind === "arc"
        ? [linePoints["p1"], linePoints["p2"]].find(
            (pointId) => pointId && (pointId === arcPoints["start"] || pointId === arcPoints["end"]),
          )
        : undefined;

    if (!shared) {
      this.add(
        constraint,
        roundKind === "circle"
          ? { type: "tangent_lc", l_id: lineId, c_id: roundId }
          : { type: "tangent_la", l_id: lineId, a_id: roundId },
      );

      return;
    }

    // The angle between the line's direction and the arc's (counter-clockwise) direction there:
    // 0 or π.
    const [lineStart, lineEnd] = this.lineEnds(lineId);
    const center = this.at(arcPoints["center"]!);
    const touch = this.at(shared);
    const along = sub2(lineEnd, lineStart);
    const arcDirection: Vec2 = [-(touch[1] - center[1]), touch[0] - center[0]];

    this.add(constraint, {
      type: "angle_via_point",
      crv1_id: lineId,
      crv2_id: roundId,
      p_id: shared,
      angle: dot2(along, arcDirection) >= 0 ? 0 : Math.PI,
    });
  }

  private addEqual(constraint: TypedConstraint<"equal">): void {
    const kindA = this.kindOf(constraint.a);
    const kindB = this.kindOf(constraint.b);

    if (kindA === "line" && kindB === "line") {
      this.add(constraint, { type: "equal_length", l1_id: constraint.a, l2_id: constraint.b });
    } else if (kindA === "line" || kindB === "line") {
      throw new SketchSolveError(`equal ${constraint.id}: cannot mix lines and circles`);
    } else if (kindA === "circle" && kindB === "circle") {
      this.add(constraint, { type: "equal_radius_cc", c1_id: constraint.a, c2_id: constraint.b });
    } else if (kindA === "arc" && kindB === "arc") {
      this.add(constraint, { type: "equal_radius_aa", a1_id: constraint.a, a2_id: constraint.b });
    } else {
      this.add(constraint, {
        type: "equal_radius_ca",
        c1_id: kindA === "circle" ? constraint.a : constraint.b,
        a2_id: kindA === "arc" ? constraint.a : constraint.b,
      });
    }
  }

  private addPointOn(constraint: TypedConstraint<"point_on">): void {
    const kind = this.kindOf(constraint.curve);
    const point = this.pointId(constraint.point);

    this.add(
      constraint,
      kind === "line"
        ? { type: "point_on_line_pl", p_id: point, l_id: constraint.curve }
        : kind === "circle"
          ? { type: "point_on_circle", p_id: point, c_id: constraint.curve }
          : { type: "point_on_arc", p_id: point, a_id: constraint.curve },
    );
  }

  private addDistance(constraint: TypedConstraint<"distance">): void {
    const from = this.pointId(constraint.a);

    if (this.kinds.has(constraint.b)) {
      this.add(constraint, {
        type: "p2l_distance",
        p_id: from,
        l_id: constraint.b,
        distance: constraint.value,
      });

      return;
    }

    const to = this.pointId(constraint.b);

    if (!constraint.axis) {
      this.add(constraint, { type: "p2p_distance", p1_id: from, p2_id: to, distance: constraint.value });

      return;
    }

    // Along one axis the distance has a sign: it keeps the side the points were drawn on.
    const prop = constraint.axis;
    const axis = prop === "x" ? 0 : 1;
    const drawn = this.at(to)[axis] - this.at(from)[axis];

    this.add(constraint, {
      type: "difference",
      param1: { o_id: from, prop },
      param2: { o_id: to, prop },
      difference: drawn < 0 ? -constraint.value : constraint.value,
    });
  }

  private addAngle(constraint: TypedConstraint<"angle">): void {
    if (this.kindOf(constraint.a) !== "line" || this.kindOf(constraint.b) !== "line") {
      throw new SketchSolveError(`angle ${constraint.id}: needs two lines`);
    }

    const [startA, endA] = this.lineEnds(constraint.a);
    const [startB, endB] = this.lineEnds(constraint.b);
    const directionA = sub2(endA, startA);
    const directionB = sub2(endB, startB);
    const current = Math.atan2(cross2(directionA, directionB), dot2(directionA, directionB));
    const wanted = (constraint.value * Math.PI) / 180;
    // Keep the solution in the quadrant the user drew it in.
    const candidates = [wanted, -wanted, Math.PI - wanted, wanted - Math.PI];
    const closest = candidates.reduce((best, candidate) =>
      angDiff(candidate, current) < angDiff(best, current) ? candidate : best,
    );

    this.add(constraint, { type: "l2l_angle_ll", l1_id: constraint.a, l2_id: constraint.b, angle: closest });
  }

  /** While dragging: weak targets that pull a point or a radius towards the pointer. */
  addDragTargets(opts: SolveOptions): void {
    let count = 0;

    for (const [ref, target] of Object.entries(opts.drag ?? {})) {
      const dragged = this.pointId(ref);
      const targetId = `drag#${count++}`;

      this.points.push({ id: targetId, type: "point", x: target[0], y: target[1], fixed: true });
      this.constraints.push({
        id: `${targetId}c`,
        type: "p2p_coincident",
        p1_id: dragged,
        p2_id: targetId,
        temporary: true,
      } as Prim);
    }

    if (opts.dragRadius) {
      const kind = this.kindOf(opts.dragRadius.curve);

      this.constraints.push({
        id: "drag#r",
        ...(kind === "circle"
          ? { type: "circle_radius", c_id: opts.dragRadius.curve }
          : { type: "arc_radius", a_id: opts.dragRadius.curve }),
        radius: opts.dragRadius.radius,
        temporary: true,
      } as Prim);
    }
  }
}

const pointOnCircle = (center: Vec2, radius: number, angle: number): Vec2 => [
  center[0] + radius * Math.cos(angle),
  center[1] + radius * Math.sin(angle),
];

function angDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);

  return d > Math.PI ? 2 * Math.PI - d : d;
}
