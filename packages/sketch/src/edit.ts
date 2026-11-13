/**
 * Sketch edits that replace geometry: rounding or bevelling the corner where two lines meet, and
 * offsetting curves (a parallel copy at a distance, with corners of a chain joined). They work on a
 * sketch's entities and constraints and the solved positions of its points, and add constraints so
 * the result stays parametric: a fillet arc is tangent to both lines with its radius dimensioned; a
 * chamfer has its length dimensioned; offset lines are parallel at a dimensioned distance, offset
 * arcs and circles share their originals' centres.
 */

import type { SketchConstraint, SketchEntity } from "@meercad/schema";
import type { Vec2 } from "./geometry.js";

export interface SketchData {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

export class SketchEditError extends Error {}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2, s = 1): Vec2 => [a[0] + b[0] * s, a[1] + b[1] * s];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2): Vec2 => [a[0] / (len(a) || 1), a[1] / (len(a) || 1)];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** A fresh id with this prefix, not used by any entity or constraint. */
function fresh(d: SketchData, prefix: string): string {
  const taken = new Set([
    ...d.entities.map((entity) => entity.id),
    ...d.constraints.map((constraint) => constraint.id),
  ]);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;

  return `${prefix}${n}`;
}

/** Entity ids a constraint refers to ("l1.p2" refers to l1). */
function refs(constraint: SketchConstraint): string[] {
  return Object.entries(constraint)
    .filter(([k, v]) => k !== "id" && k !== "type" && typeof v === "string")
    .map(([, v]) => (v as string).split(".")[0]!);
}

/**
 * Rounds (`fillet`) or bevels (`chamfer`) the corner at point `corner`, where exactly two lines end.
 * `size` is the fillet radius, or the chamfer's distance along each line.
 */
export function cornerEdit(
  sk: SketchData,
  positions: ReadonlyMap<string, Vec2>,
  corner: string,
  size: number,
  kind: "fillet" | "chamfer",
): SketchData {
  if (!(size > 0)) {
    throw new SketchEditError(`the ${kind === "fillet" ? "radius" : "distance"} must be greater than zero`);
  }

  // Points joined to the corner by a coincident constraint count as the corner too.
  const same = new Set([corner]);

  for (const constraint of sk.constraints) {
    if (constraint.type === "coincident") {
      if (same.has(constraint.a)) same.add(constraint.b);
      if (same.has(constraint.b)) same.add(constraint.a);
    }
  }

  const lines = sk.entities.filter(
    (entity): entity is Extract<SketchEntity, { type: "line" }> =>
      entity.type === "line" && !entity.construction && (same.has(entity.p1) || same.has(entity.p2)),
  );
  const others = sk.entities.filter(
    (entity) =>
      (entity.type === "arc" && (same.has(entity.start) || same.has(entity.end))) ||
      (entity.type === "circle" && same.has(entity.center)),
  );

  if (lines.length !== 2 || others.length) {
    throw new SketchEditError("pick a corner where exactly two lines meet");
  }

  const P = positions.get(corner);
  if (!P) throw new SketchEditError("the corner has no position");

  const far = lines.map((l) => (same.has(l.p1) ? l.p2 : l.p1));
  const [A, B] = far.map((id) => positions.get(id));
  if (!A || !B) throw new SketchEditError("the lines have no positions");

  const u1 = unit(sub(A, P)),
    u2 = unit(sub(B, P));
  const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const theta = Math.acos(cos);

  if (theta < 1e-3 || Math.PI - theta < 1e-3) {
    throw new SketchEditError("the lines are in line: there is no corner to round");
  }

  // How far from the corner the new geometry starts on each line.
  const d = kind === "fillet" ? size / Math.tan(theta / 2) : size;

  if (d >= len(sub(A, P)) - 1e-9 || d >= len(sub(B, P)) - 1e-9) {
    throw new SketchEditError(
      `too large for these lines: at most ${round(Math.min(len(sub(A, P)), len(sub(B, P))) * (kind === "fillet" ? Math.tan(theta / 2) : 1))} mm`,
    );
  }

  const T1 = add(P, u1, d),
    T2 = add(P, u2, d);
  const out: SketchData = { entities: [...sk.entities], constraints: [...sk.constraints] };

  const point = (q: Vec2) => {
    const id = fresh(out, "p");
    out.entities.push({ id, type: "point", x: round(q[0]), y: round(q[1]) });

    return id;
  };

  const t1 = point(T1),
    t2 = point(T2);
  // Each line now ends where the new geometry starts.
  out.entities = out.entities.map((entity) => {
    if (entity.id === lines[0]!.id) {
      return same.has(lines[0]!.p1) ? { ...lines[0]!, p1: t1 } : { ...lines[0]!, p2: t1 };
    }

    if (entity.id === lines[1]!.id) {
      return same.has(lines[1]!.p1) ? { ...lines[1]!, p1: t2 } : { ...lines[1]!, p2: t2 };
    }

    return entity;
  });
  // Constraints on the old corner point no longer describe anything; neither do the lines' lengths.
  out.constraints = out.constraints.filter(
    (constraint) =>
      !refs(constraint).some((r) => same.has(r)) &&
      !(constraint.type === "length" && lines.some((l) => l.id === constraint.line)),
  );

  const used = new Set(
    out.entities.flatMap((entity) =>
      entity.type === "line"
        ? [entity.p1, entity.p2]
        : entity.type === "arc"
          ? [entity.center, entity.start, entity.end]
          : entity.type === "circle"
            ? [entity.center]
            : [],
    ),
  );
  out.entities = out.entities.filter(
    (entity) => !(entity.type === "point" && same.has(entity.id) && !used.has(entity.id)),
  );

  if (kind === "fillet") {
    const bis = unit(add(u1, u2));
    const C = add(P, bis, size / Math.sin(theta / 2));
    const c = point(C);
    // Arcs run counter-clockwise from start to end.
    const ccw = cross(sub(T1, C), sub(T2, C)) > 0;
    const arc = fresh(out, "a");
    out.entities.push({ id: arc, type: "arc", center: c, start: ccw ? t1 : t2, end: ccw ? t2 : t1 });
    out.constraints.push({ id: fresh(out, "c"), type: "tangent", a: arc, b: lines[0]!.id });
    out.constraints.push({ id: fresh(out, "c"), type: "tangent", a: arc, b: lines[1]!.id });
    out.constraints.push({ id: fresh(out, "c"), type: "radius", curve: arc, value: round(size) });
  } else {
    const line = fresh(out, "l");
    out.entities.push({ id: line, type: "line", p1: t1, p2: t2 });
    out.constraints.push({ id: fresh(out, "c"), type: "length", line, value: round(len(sub(T2, T1))) });
  }

  return out;
}

/**
 * Parallel copies of curves at `distance`. Lines and arcs that join end to end form chains whose
 * corners stay joined (offset lines meet where they cross); a closed chain grows outwards for a
 * positive distance, an open one moves to the left as it runs from its first curve. Circles grow by
 * the distance. Offset arcs and circles keep their originals' centres.
 */
export function offsetCurves(
  sk: SketchData,
  positions: ReadonlyMap<string, Vec2>,
  curves: readonly string[],
  distance: number,
): SketchData {
  if (!distance) throw new SketchEditError("the offset distance must not be zero");

  const picked = sk.entities.filter(
    (entity) =>
      curves.includes(entity.id) &&
      (entity.type === "line" || entity.type === "arc" || entity.type === "circle"),
  );
  if (!picked.length) throw new SketchEditError("pick lines, arcs or circles to offset");

  const pos = (id: string) => {
    const p = positions.get(id);
    if (!p) throw new SketchEditError(`point ${id} has no position`);

    return p;
  };

  const out: SketchData = { entities: [...sk.entities], constraints: [...sk.constraints] };

  const point = (q: Vec2) => {
    const id = fresh(out, "p");
    out.entities.push({ id, type: "point", x: round(q[0]), y: round(q[1]) });

    return id;
  };

  type Seg = Extract<SketchEntity, { type: "line" | "arc" }>;

  const ends = (e: Seg): [string, string] => (e.type === "line" ? [e.p1, e.p2] : [e.start, e.end]);
  const segs = picked.filter((entity): entity is Seg => entity.type !== "circle");
  const left = new Set(segs);

  while (left.size) {
    // Walk one chain from an open end (or anywhere when it is closed).
    const chain = [...left];
    const degree = (p: string) => chain.filter((e) => ends(e).includes(p)).length;
    const first = chain.find((e) => ends(e).some((p) => degree(p) === 1)) ?? chain[0]!;
    let at = ends(first).find((p) => degree(p) === 1) ?? ends(first)[0];
    const walk: { e: Seg; from: string; to: string }[] = [];

    for (let e: Seg | undefined = first; e;) {
      left.delete(e);

      const [a, b] = ends(e);
      const to = a === at ? b : a;
      walk.push({ e, from: at, to });
      at = to;
      e = [...left].find((x) => ends(x).includes(at));
    }

    const closed = walk.length > 1 && walk[walk.length - 1]!.to === walk[0]!.from;
    // Twice the loop's area, with arcs bulging along their walk: positive when it runs counter-clockwise.
    let area = 0;

    for (const { e, from, to } of walk) {
      const [a, b] = [pos(from), pos(to)];
      area += cross(a, b);

      if (e.type === "arc") {
        const c = pos(e.center);
        const r = len(sub(a, c));
        const [s0, s1] = [pos(e.start), pos(e.end)];
        let sweep = Math.atan2(s1[1] - c[1], s1[0] - c[0]) - Math.atan2(s0[1] - c[1], s0[0] - c[0]);
        if (sweep <= 0) sweep += 2 * Math.PI;

        area += (from === e.start ? 1 : -1) * r * r * (sweep - Math.sin(sweep));
      }
    }

    // Offsets go to the left of the walk; for a counter-clockwise loop that is inwards.
    const side = closed && area > 0 ? -distance : distance;
    const lineOff = new Map<string, { p: Vec2; dir: Vec2 }>();

    for (const { e, from, to } of walk) {
      if (e.type !== "line") continue;

      const dir = unit(sub(pos(to), pos(from)));
      lineOff.set(e.id, { p: add(pos(from), [-dir[1], dir[0]], side), dir });
    }

    const moved = new Map<string, string>();

    const newPoint = (id: string): string => {
      const hit = moved.get(id);
      if (hit) return hit;

      const P = pos(id);
      const at = walk.filter((w) => w.from === id || w.to === id);
      const ls = at.filter((w) => w.e.type === "line").map((w) => lineOff.get(w.e.id)!);
      let Q: Vec2;

      if (ls.length === 2 && Math.abs(cross(ls[0]!.dir, ls[1]!.dir)) > 1e-9) {
        const [l1, l2] = ls as [{ p: Vec2; dir: Vec2 }, { p: Vec2; dir: Vec2 }];
        Q = add(l1.p, l1.dir, cross(sub(l2.p, l1.p), l2.dir) / cross(l1.dir, l2.dir));
      } else if (ls.length) {
        Q = add(P, [-ls[0]!.dir[1], ls[0]!.dir[0]], side);
      } else {
        // Between arcs: along the radius; left of a counter-clockwise walk is towards the centre.
        const w = at[0]!;
        const arc = w.e as Extract<SketchEntity, { type: "arc" }>;
        const toCentre = unit(sub(pos(arc.center), P));
        Q = add(P, toCentre, (w.from === arc.start ? 1 : -1) * side);
      }

      const nid = point(Q);
      moved.set(id, nid);

      return nid;
    };

    // Lines first, so arcs can hold on to the copies of the lines they touch.
    const lineCopy = new Map<string, string>();

    for (const { e } of walk) {
      if (e.type !== "line") continue;

      const id = fresh(out, "l");
      lineCopy.set(e.id, id);
      out.entities.push({ id, type: "line", p1: newPoint(e.p1), p2: newPoint(e.p2) });
      out.constraints.push({ id: fresh(out, "c"), type: "parallel", a: id, b: e.id });
      out.constraints.push({
        id: fresh(out, "c"),
        type: "distance",
        a: `${id}.p1`,
        b: e.id,
        value: round(Math.abs(distance)),
      });
    }

    const tangentTo = (arc: string, line: string) =>
      sk.constraints.some(
        (constraint) =>
          constraint.type === "tangent" &&
          ((constraint.a === arc && constraint.b === line) ||
            (constraint.a === line && constraint.b === arc)),
      );

    for (const { e, from } of walk) {
      if (e.type === "line") continue;

      {
        const c = pos(e.center);
        const r = len(sub(pos(e.start), c));
        const nr = r - (from === e.start ? 1 : -1) * side;

        if (!(nr > 0)) {
          throw new SketchEditError("the offset is larger than a radius: the curve would vanish");
        }

        // A rounded corner between two lines is rounded again between their copies: its own centre,
        // tangent to both, with the new radius (sharing the old centre as well fixes its ends twice).
        // Other arcs keep the centre and get the radius.
        const touching = walk
          .filter(
            (w) =>
              w.e.type === "line" &&
              (ends(w.e).includes(e.start) || ends(w.e).includes(e.end)) &&
              tangentTo(e.id, w.e.id),
          )
          .map((w) => lineCopy.get(w.e.id)!);
        const corner = touching.length === 2;
        const id = fresh(out, "a");
        out.entities.push({
          id,
          type: "arc",
          center: corner ? point(c) : e.center,
          start: newPoint(e.start),
          end: newPoint(e.end),
        });

        if (corner) {
          for (const l of touching) {
            out.constraints.push({ id: fresh(out, "c"), type: "tangent", a: id, b: l });
          }
        }

        out.constraints.push({ id: fresh(out, "c"), type: "radius", curve: id, value: round(nr) });
      }
    }
  }

  for (const entity of picked) {
    if (entity.type !== "circle") continue;

    const nr = entity.radius + distance;
    if (!(nr > 0)) throw new SketchEditError("the offset is larger than a radius: the curve would vanish");

    const id = fresh(out, "c");
    out.entities.push({ id, type: "circle", center: entity.center, radius: round(nr) });
    out.constraints.push({ id: fresh(out, "c"), type: "radius", curve: id, value: round(nr) });
  }

  return out;
}

/**
 * Copies of curves in a row (`dx`, `dy` apart) or round a centre (`angle` apart, degrees), `count`
 * in all including the originals. Each copy gets its own points; copied circles and arcs keep their
 * radius (an equal constraint to the original), copied lines their length (equal).
 */
export function patternCurves(
  sk: SketchData,
  positions: ReadonlyMap<string, Vec2>,
  curves: readonly string[],
  o:
    | { kind: "linear"; count: number; dx: number; dy: number }
    | { kind: "circular"; count: number; angle: number; center: Vec2 },
): SketchData {
  const picked = sk.entities.filter(
    (entity) =>
      curves.includes(entity.id) &&
      (entity.type === "line" ||
        entity.type === "arc" ||
        entity.type === "circle" ||
        entity.type === "spline"),
  );
  if (!picked.length) throw new SketchEditError("pick the curves to repeat");
  if (!(o.count >= 2) || o.count > 200) throw new SketchEditError("the count must be between 2 and 200");

  const out: SketchData = { entities: [...sk.entities], constraints: [...sk.constraints] };

  const move = (p: Vec2, k: number): Vec2 => {
    if (o.kind === "linear") return [p[0] + o.dx * k, p[1] + o.dy * k];

    const a = (o.angle * k * Math.PI) / 180;
    const [x, y] = [p[0] - o.center[0], p[1] - o.center[1]];

    return [o.center[0] + x * Math.cos(a) - y * Math.sin(a), o.center[1] + x * Math.sin(a) + y * Math.cos(a)];
  };

  const pointsOf = (entity: SketchEntity) =>
    entity.type === "line"
      ? [entity.p1, entity.p2]
      : entity.type === "circle"
        ? [entity.center]
        : entity.type === "arc"
          ? [entity.center, entity.start, entity.end]
          : entity.type === "spline"
            ? entity.points
            : [];

  for (let k = 1; k < o.count; k++) {
    // Points shared by the picked curves stay shared in each copy.
    const map = new Map<string, string>();

    const copyPoint = (id: string) => {
      const hit = map.get(id);
      if (hit) return hit;

      const p = positions.get(id);
      if (!p) throw new SketchEditError(`point ${id} has no position`);

      const nid = fresh(out, "p");
      const q = move(p, k);
      out.entities.push({ id: nid, type: "point", x: round(q[0]), y: round(q[1]) });
      map.set(id, nid);

      return nid;
    };

    for (const entity of picked) {
      const pts = pointsOf(entity).map(copyPoint);
      const id = fresh(
        out,
        entity.type === "line" ? "l" : entity.type === "circle" ? "c" : entity.type === "arc" ? "a" : "s",
      );
      const construction = entity.construction ? { construction: true } : {};

      if (entity.type === "line") {
        out.entities.push({ id, type: "line", p1: pts[0]!, p2: pts[1]!, ...construction });
      } else if (entity.type === "circle") {
        out.entities.push({ id, type: "circle", center: pts[0]!, radius: entity.radius, ...construction });
      } else if (entity.type === "arc") {
        out.entities.push({
          id,
          type: "arc",
          center: pts[0]!,
          start: pts[1]!,
          end: pts[2]!,
          ...construction,
        });
      } else if (entity.type === "spline") {
        out.entities.push({
          id,
          type: "spline",
          points: pts,
          ...(entity.closed ? { closed: true } : {}),
          ...construction,
        });
      }

      if (entity.type !== "spline") {
        out.constraints.push({ id: fresh(out, "k"), type: "equal", a: id, b: entity.id });
      }
    }
  }

  return out;
}
