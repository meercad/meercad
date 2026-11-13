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
import { splinePoints, sweep, type SolvedCurve, type SolvedSketch, type Vec2 } from "./geometry.js";

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

    for (const e of input.entities) {
      const construction = !!e.construction;

      if (e.type === "line") {
        curves.push({
          id: e.id,
          kind: "line",
          a: pt(e.p1),
          b: pt(e.p2),
          p1: e.p1,
          p2: e.p2,
          construction,
          external: false,
        });
      } else if (e.type === "circle") {
        const c = values.get(e.id) as { radius: number } | undefined;
        curves.push({
          id: e.id,
          kind: "circle",
          center: pt(e.center),
          radius: c?.radius ?? e.radius,
          c: e.center,
          construction,
          external: false,
        });
      } else if (e.type === "arc") {
        const a = values.get(e.id) as { radius: number; start_angle: number; end_angle: number } | undefined;

        if (a) {
          curves.push({
            id: e.id,
            kind: "arc",
            center: pt(e.center),
            radius: a.radius,
            a0: a.start_angle,
            a1: a.end_angle,
            c: e.center,
            start: e.start,
            end: e.end,
            construction,
            external: false,
          });
        }
      } else if (e.type === "spline") {
        const through = e.points.map(pt);
        curves.push({
          id: e.id,
          kind: "spline",
          pts: splinePoints(through, !!e.closed),
          through,
          points: e.points,
          closed: !!e.closed,
          construction,
          external: false,
        });
      }
    }

    for (const x of input.external ?? []) curves.push(x);

    // Expose curve characteristic points under their reference names too ("l1.p1", "c1.center").
    for (const c of curves) {
      if (c.kind === "spline") continue;

      if (c.kind === "line") {
        points.set(`${c.id}.p1`, c.a);
        points.set(`${c.id}.p2`, c.b);
      } else {
        points.set(`${c.id}.center`, c.center);

        if (c.kind === "arc") {
          points.set(`${c.id}.start`, [
            c.center[0] + c.radius * Math.cos(c.a0),
            c.center[1] + c.radius * Math.sin(c.a0),
          ]);
          points.set(`${c.id}.end`, [
            c.center[0] + c.radius * Math.cos(c.a1),
            c.center[1] + c.radius * Math.sin(c.a1),
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

function buildPrimitives(
  input: SolveInput,
  opts: SolveOptions,
): { prims: Prim[]; userConstraints: Set<string> } {
  const points: Prim[] = [
    { id: "origin", type: "point", x: 0, y: 0, fixed: true },
    { id: "origin.xp", type: "point", x: 1, y: 0, fixed: true },
    { id: "origin.yp", type: "point", x: 0, y: 1, fixed: true },
  ];
  const curves: Prim[] = [
    { id: "origin.x", type: "line", p1_id: "origin", p2_id: "origin.xp" },
    { id: "origin.y", type: "line", p1_id: "origin", p2_id: "origin.yp" },
  ];
  const cons: Prim[] = [];
  const kinds = new Map<string, "line" | "circle" | "arc">([
    ["origin.x", "line"],
    ["origin.y", "line"],
  ]);
  const curvePoints = new Map<string, Record<string, string>>();
  /** Open splines' point ids; the solver only sees their points, and their ends for tangency. */
  const splines = new Map<string, readonly string[]>();
  const coords = new Map<string, Vec2>([["origin", [0, 0]]]);

  for (const e of input.entities) {
    if (e.type === "point") {
      points.push({ id: e.id, type: "point", x: e.x, y: e.y, fixed: false });
      coords.set(e.id, [e.x, e.y]);
    }
  }

  const at = (id: string): Vec2 => coords.get(id) ?? [0, 0];

  for (const e of input.entities) {
    if (e.type === "line") {
      curves.push({ id: e.id, type: "line", p1_id: e.p1, p2_id: e.p2 });
      kinds.set(e.id, "line");
      curvePoints.set(e.id, { p1: e.p1, p2: e.p2 });
    } else if (e.type === "circle") {
      curves.push({ id: e.id, type: "circle", c_id: e.center, radius: e.radius });
      kinds.set(e.id, "circle");
      curvePoints.set(e.id, { center: e.center });
    } else if (e.type === "arc") {
      const c = at(e.center);
      const s = at(e.start);
      const t = at(e.end);
      const radius = Math.hypot(s[0] - c[0], s[1] - c[1]) || 1;
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      const a1 = a0 + sweep(a0, Math.atan2(t[1] - c[1], t[0] - c[0]));
      curves.push({
        id: e.id,
        type: "arc",
        c_id: e.center,
        start_id: e.start,
        end_id: e.end,
        radius,
        start_angle: a0,
        end_angle: a1,
      });
      cons.push({ id: `${e.id}#rules`, type: "arc_rules", a_id: e.id });
      kinds.set(e.id, "arc");
      curvePoints.set(e.id, { center: e.center, start: e.start, end: e.end });
    } else if (e.type === "spline" && !e.closed && e.points.length >= 2) {
      splines.set(e.id, e.points);
    }
  }

  for (const x of input.external ?? []) {
    // Projected model edges are lines, circles and arcs only.
    if (x.kind === "spline") continue;

    if (x.kind === "line") {
      points.push(
        { id: `${x.id}.p1`, type: "point", x: x.a[0], y: x.a[1], fixed: true },
        { id: `${x.id}.p2`, type: "point", x: x.b[0], y: x.b[1], fixed: true },
      );
      curves.push({ id: x.id, type: "line", p1_id: `${x.id}.p1`, p2_id: `${x.id}.p2` });
      curvePoints.set(x.id, { p1: `${x.id}.p1`, p2: `${x.id}.p2` });
    } else {
      points.push({ id: `${x.id}.center`, type: "point", x: x.center[0], y: x.center[1], fixed: true });

      if (x.kind === "circle") {
        curves.push({ id: x.id, type: "circle", c_id: `${x.id}.center`, radius: x.radius });
        curvePoints.set(x.id, { center: `${x.id}.center` });
      } else {
        const s: Vec2 = [x.center[0] + x.radius * Math.cos(x.a0), x.center[1] + x.radius * Math.sin(x.a0)];
        const t: Vec2 = [x.center[0] + x.radius * Math.cos(x.a1), x.center[1] + x.radius * Math.sin(x.a1)];
        points.push(
          { id: `${x.id}.start`, type: "point", x: s[0], y: s[1], fixed: true },
          { id: `${x.id}.end`, type: "point", x: t[0], y: t[1], fixed: true },
        );
        curves.push({
          id: x.id,
          type: "arc",
          c_id: `${x.id}.center`,
          start_id: `${x.id}.start`,
          end_id: `${x.id}.end`,
          radius: x.radius,
          start_angle: x.a0,
          end_angle: x.a1,
        });
        curvePoints.set(x.id, { center: `${x.id}.center`, start: `${x.id}.start`, end: `${x.id}.end` });
      }

      // Fixed radius for external circles/arcs.
      cons.push({
        id: `${x.id}#r`,
        type: x.kind === "circle" ? "circle_radius" : "arc_radius",
        ...(x.kind === "circle" ? { c_id: x.id } : { a_id: x.id }),
        radius: x.radius,
      } as Prim);
    }

    for (const [k, v] of Object.entries(curvePoints.get(x.id) ?? {})) coords.set(`${x.id}.${k}`, at(v));
    kinds.set(x.id, x.kind);
  }

  for (const p of points) if (p.type === "point") coords.set(p.id, [p.x, p.y]);

  /** "l1.p1" → underlying point id; plain point ids pass through. */
  const point = (ref: string): string => {
    const dot = ref.lastIndexOf(".");

    if (dot > 0) {
      const mapped = curvePoints.get(ref.slice(0, dot))?.[ref.slice(dot + 1)];
      if (mapped) return mapped;
    }

    if (!coords.has(ref)) throw new SketchSolveError(`unknown point "${ref}"`);

    return ref;
  };

  const kind = (ref: string) => {
    const k = kinds.get(ref);
    if (!k) throw new SketchSolveError(`unknown curve "${ref}"`);

    return k;
  };

  const lineEnds = (l: string): [Vec2, Vec2] => {
    const cp = curvePoints.get(l);

    if (l === "origin.x") {
      return [
        [0, 0],
        [1, 0],
      ];
    }

    if (l === "origin.y") {
      return [
        [0, 0],
        [0, 1],
      ];
    }

    return [at(cp?.["p1"] ?? ""), at(cp?.["p2"] ?? "")];
  };

  const userConstraints = new Set<string>();

  for (const c of input.constraints) {
    userConstraints.add(c.id);

    const add = (p: Record<string, unknown>, k = 0) =>
      cons.push({ ...p, id: k ? `${c.id}#${k}` : c.id } as Prim);

    switch (c.type) {
      case "coincident":
        add({ type: "p2p_coincident", p1_id: point(c.a), p2_id: point(c.b) });
        break;
      case "horizontal":
      case "vertical":
        kind(c.line);
        add({ type: c.type === "horizontal" ? "horizontal_l" : "vertical_l", l_id: c.line });
        break;
      case "horizontal_points":
      case "vertical_points":
        add({
          type: c.type === "horizontal_points" ? "horizontal_pp" : "vertical_pp",
          p1_id: point(c.a),
          p2_id: point(c.b),
        });
        break;
      case "parallel":
        add({ type: "parallel", l1_id: c.a, l2_id: c.b });
        break;
      case "perpendicular":
        add({ type: "perpendicular_ll", l1_id: c.a, l2_id: c.b });
        break;
      case "collinear":
        add({ type: "parallel", l1_id: c.a, l2_id: c.b });
        add({ type: "point_on_line_pl", p_id: point(`${c.b}.p1`), l_id: c.a }, 1);
        break;
      case "tangent": {
        // A spline end leaves towards its neighbouring point, so tangency there is that of the
        // line between the two, standing in for the spline.
        const ends = (r: string) => {
          const sp = splines.get(r);
          if (sp) return [sp[0]!, sp[sp.length - 1]!];

          const cp = curvePoints.get(r) ?? {};

          return [cp["p1"] ?? cp["start"], cp["p2"] ?? cp["end"]].filter((q): q is string => !!q);
        };

        const stand = (r: string, other: string) => {
          const sp = splines.get(r);
          if (!sp) return r;

          const shared = ends(r).find((q) => ends(other).includes(q));

          if (!shared) {
            throw new SketchSolveError(`tangent ${c.id}: the spline must end where the other curve ends`);
          }

          const id = `${r}#${shared}`;

          if (!kinds.has(id)) {
            const next = shared === sp[0] ? sp[1]! : sp[sp.length - 2]!;
            curves.push({ id, type: "line", p1_id: shared, p2_id: next });
            kinds.set(id, "line");
            curvePoints.set(id, { p1: shared, p2: next });
          }

          return id;
        };

        const [ta, tb] = [stand(c.a, c.b), stand(c.b, c.a)];
        const [ka, kb] = [kind(ta), kind(tb)];

        if ((ta !== c.a || tb !== c.b) && ka === "line" && kb === "line") {
          // They share the end point: parallel makes them run on in one line.
          add({ type: "parallel", l1_id: ta, l2_id: tb });
          break;
        }

        if (ka === "line" && kb === "line") {
          throw new SketchSolveError(`tangent ${c.id}: needs a circle or arc`);
        }

        if (ka === "line" || kb === "line") {
          const [l, o, ko] = ka === "line" ? [ta, tb, kb] : [tb, ta, ka];
          // A line ending where the arc ends (a rounded corner): tangent at that point. "Tangent to
          // the circle" there would duplicate the point being on both, which the solver reports as
          // redundant.
          const lp = curvePoints.get(l) ?? {};
          const ap = curvePoints.get(o) ?? {};
          const shared =
            ko === "arc"
              ? [lp["p1"], lp["p2"]].find((q) => q && (q === ap["start"] || q === ap["end"]))
              : undefined;

          if (shared) {
            // The angle between the line's direction and the arc's (counter-clockwise) direction there: 0 or
            // π.
            const [a0, a1] = lineEnds(l);
            const ctr = at(ap["center"]!);
            const q = at(shared);
            const along: Vec2 = [a1[0] - a0[0], a1[1] - a0[1]];
            const arcDir: Vec2 = [-(q[1] - ctr[1]), q[0] - ctr[0]];
            add({
              type: "angle_via_point",
              crv1_id: l,
              crv2_id: o,
              p_id: shared,
              angle: along[0] * arcDir[0] + along[1] * arcDir[1] >= 0 ? 0 : Math.PI,
            });
          } else {
            add(
              ko === "circle"
                ? { type: "tangent_lc", l_id: l, c_id: o }
                : { type: "tangent_la", l_id: l, a_id: o },
            );
          }
        } else if (ka === "circle" && kb === "circle") {
          add({ type: "tangent_cc", c1_id: ta, c2_id: tb });
        } else if (ka === "arc" && kb === "arc") {
          add({ type: "tangent_aa", a1_id: ta, a2_id: tb });
        } else {
          add({ type: "tangent_ca", c_id: ka === "circle" ? ta : tb, a_id: ka === "arc" ? ta : tb });
        }

        break;
      }
      case "equal": {
        const [ka, kb] = [kind(c.a), kind(c.b)];

        if (ka === "line" && kb === "line") {
          add({ type: "equal_length", l1_id: c.a, l2_id: c.b });
        } else if (ka === "line" || kb === "line") {
          throw new SketchSolveError(`equal ${c.id}: cannot mix lines and circles`);
        } else if (ka === "circle" && kb === "circle") {
          add({ type: "equal_radius_cc", c1_id: c.a, c2_id: c.b });
        } else if (ka === "arc" && kb === "arc") {
          add({ type: "equal_radius_aa", a1_id: c.a, a2_id: c.b });
        } else {
          add({
            type: "equal_radius_ca",
            c1_id: ka === "circle" ? c.a : c.b,
            a2_id: ka === "arc" ? c.a : c.b,
          });
        }

        break;
      }
      case "point_on": {
        const k = kind(c.curve);
        const p = point(c.point);
        add(
          k === "line"
            ? { type: "point_on_line_pl", p_id: p, l_id: c.curve }
            : k === "circle"
              ? { type: "point_on_circle", p_id: p, c_id: c.curve }
              : { type: "point_on_arc", p_id: p, a_id: c.curve },
        );
        break;
      }
      case "midpoint": {
        const cp = curvePoints.get(c.line);
        if (kind(c.line) !== "line" || !cp) throw new SketchSolveError(`midpoint ${c.id}: needs a line`);

        add({ type: "p2p_symmetric_ppp", p1_id: cp["p1"], p2_id: cp["p2"], p_id: point(c.point) });
        break;
      }
      case "symmetric":
        add({ type: "p2p_symmetric_ppl", p1_id: point(c.a), p2_id: point(c.b), l_id: c.axis });
        break;
      case "fix": {
        const p = point(c.point);
        const [x, y] = at(p);
        add({ type: "coordinate_x", p_id: p, x });
        add({ type: "coordinate_y", p_id: p, y }, 1);
        break;
      }
      case "distance": {
        const a = point(c.a);

        if (kinds.has(c.b)) {
          add({ type: "p2l_distance", p_id: a, l_id: c.b, distance: c.value });
          break;
        }

        const b = point(c.b);

        if (c.axis) {
          const prop = c.axis;
          const d = at(b)[prop === "x" ? 0 : 1] - at(a)[prop === "x" ? 0 : 1];
          add({
            type: "difference",
            param1: { o_id: a, prop },
            param2: { o_id: b, prop },
            difference: d < 0 ? -c.value : c.value,
          });
        } else {
          add({ type: "p2p_distance", p1_id: a, p2_id: b, distance: c.value });
        }

        break;
      }
      case "length": {
        const cp = curvePoints.get(c.line);
        if (kind(c.line) !== "line" || !cp) throw new SketchSolveError(`length ${c.id}: needs a line`);

        add({ type: "p2p_distance", p1_id: cp["p1"], p2_id: cp["p2"], distance: c.value });
        break;
      }
      case "radius":
      case "diameter": {
        const k = kind(c.curve);
        if (k === "line") throw new SketchSolveError(`${c.type} ${c.id}: needs a circle or arc`);

        const r = c.type === "radius" ? c.value : c.value / 2;
        add(
          k === "circle"
            ? { type: "circle_radius", c_id: c.curve, radius: r }
            : { type: "arc_radius", a_id: c.curve, radius: r },
        );
        break;
      }
      case "angle": {
        if (kind(c.a) !== "line" || kind(c.b) !== "line") {
          throw new SketchSolveError(`angle ${c.id}: needs two lines`);
        }

        const [a1, a2] = lineEnds(c.a);
        const [b1, b2] = lineEnds(c.b);
        const d1: Vec2 = [a2[0] - a1[0], a2[1] - a1[1]];
        const d2: Vec2 = [b2[0] - b1[0], b2[1] - b1[1]];
        const current = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
        const v = (c.value * Math.PI) / 180;
        // Keep the solution in the quadrant the user drew it in.
        const best = [v, -v, Math.PI - v, v - Math.PI].reduce((x, y) =>
          angDiff(y, current) < angDiff(x, current) ? y : x,
        );
        add({ type: "l2l_angle_ll", l1_id: c.a, l2_id: c.b, angle: best });
        break;
      }
      case "arc_angle": {
        if (kind(c.curve) !== "arc") throw new SketchSolveError(`arc_angle ${c.id}: needs an arc`);

        add({
          type: "difference",
          param1: { o_id: c.curve, prop: "start_angle" },
          param2: { o_id: c.curve, prop: "end_angle" },
          difference: (c.value * Math.PI) / 180,
        });
        break;
      }
    }
  }

  let t = 0;

  for (const [pid, target] of Object.entries(opts.drag ?? {})) {
    const p = point(pid);
    const tid = `drag#${t++}`;
    points.push({ id: tid, type: "point", x: target[0], y: target[1], fixed: true });
    cons.push({ id: `${tid}c`, type: "p2p_coincident", p1_id: p, p2_id: tid, temporary: true } as Prim);
  }

  if (opts.dragRadius) {
    const k = kind(opts.dragRadius.curve);
    cons.push({
      id: "drag#r",
      ...(k === "circle"
        ? { type: "circle_radius", c_id: opts.dragRadius.curve }
        : { type: "arc_radius", a_id: opts.dragRadius.curve }),
      radius: opts.dragRadius.radius,
      temporary: true,
    } as Prim);
  }

  return { prims: [...points, ...curves, ...cons], userConstraints };
}

function angDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);

  return d > Math.PI ? 2 * Math.PI - d : d;
}
