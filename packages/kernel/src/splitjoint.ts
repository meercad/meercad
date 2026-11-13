/**
 * Connectors for a split: pins, dowels or a dovetail where the two pieces meet, so they go back
 * together in one place after printing. Everything is placed on the cut faces of the front piece,
 * read as 2-D outlines in the plane's coordinates.
 *
 * Tags: `sp1.pin` (pins on the front piece), `sp1.hole` (their holes, and the dowel holes),
 * `sp1.dowel` (the loose dowels), `sp1.dovetail` (the tongue) and `sp1.slot` (the slot it slides in).
 */

import { FeatureError, type ResolvedSplit } from "@meercad/model";
import { toWorld, type PlaneFrame, type Vec3, distance2 } from "@meercad/sketch";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { booleanBodies } from "./boolean.js";
import type { OC } from "./occt.js";

type P2 = [number, number];
type Seg = [P2, P2];
type Connectors = NonNullable<ResolvedSplit["connectors"]>;

/** Gap on every side between a connector and its hole when none is given (mm). */
export const DEFAULT_CLEARANCE = 0.2;

/** Material left around a hole at least (mm). */
const WALL = 1.2;
/** Dovetail flank angle from the normal of the cut. */
const DOVETAIL_DEG = 15;
/** Tools start this far inside the piece they grow from, so booleans do not meet face to face. */
const INSIDE = 0.3;

// ---------------------------------------------------------------- 2-D outline of a cut face

/** A cut region: its boundary as segments in any order (parity decides inside, which needs no loops). */
export interface Region {
  segs: Seg[];
  min: P2;
  max: P2;
}

export function region(segs: Seg[]): Region {
  const xs = segs.flatMap((s) => [s[0][0], s[1][0]]);
  const ys = segs.flatMap((s) => [s[0][1], s[1][1]]);

  return { segs, min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

export function inside(region: Region, [x, y]: P2): boolean {
  let n = 0;

  for (const [a, b] of region.segs) {
    if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) n++;
  }

  return n % 2 === 1;
}

/** Distance to the outline (holes included). */
export function edgeDistance(region: Region, p: P2): number {
  let d = Infinity;

  for (const [a, b] of region.segs) {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    d = Math.min(d, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }

  return d;
}

/**
 * Points inside on a grid (two dozen across the narrow side, 20 000 at most), with their distance to the
 * outline.
 */
export function samples(region: Region): { p: P2; d: number }[] {
  const w = region.max[0] - region.min[0],
    h = region.max[1] - region.min[1];
  const step = Math.max(Math.min(w, h) / 24, Math.sqrt((w * h) / 20000)) || 1;
  const out: { p: P2; d: number }[] = [];

  for (let x = region.min[0] + step / 2; x < region.max[0]; x += step) {
    for (let y = region.min[1] + step / 2; y < region.max[1]; y += step) {
      const p: P2 = [x, y];
      if (inside(region, p)) out.push({ p, d: edgeDistance(region, p) });
    }
  }

  return out;
}

const round = (x: number, to: number) => Math.round(x / to) * to;

/** Pin or dowel diameter that suits a cut whose deepest inside point is `deep` from the edge. */
export function pinSize(deep: number): number {
  return Math.max(2, Math.min(8, round(deep * 0.5, 0.5)));
}

/**
 * Centres for `count` pins of radius `reach` (pin, gap and wall) in a region: as far apart as they
 * can be, each at least `reach` from the outline. Fewer when the region has no room.
 */
export function placePins(pts: { p: P2; d: number }[], reach: number, count: number): P2[] {
  // Keep them off the edges by more than the bare minimum where there is room (a thin board gets
  // its pins on the middle line, not in the corners).
  const deep = Math.max(0, ...pts.map((s) => s.d));
  const margin = Math.max(reach, Math.min(0.8 * deep, 1.6 * reach));
  const ok = pts.filter((s) => s.d >= margin);
  if (!ok.length) return [];

  const c: P2 = [
    ok.reduce((a, s) => a + s.p[0], 0) / ok.length,
    ok.reduce((a, s) => a + s.p[1], 0) / ok.length,
  ];
  const dist = (a: P2, b: P2) => distance2(b, a);

  // One pin: the roomiest point nearest the middle. More: spread out, starting far from the middle.
  if (count === 1) {
    const best = Math.max(...ok.map((s) => s.d));

    return [ok.filter((s) => s.d >= best * 0.9).sort((a, b) => dist(a.p, c) - dist(b.p, c))[0]!.p];
  }

  const chosen: P2[] = [ok.reduce((a, s) => (dist(s.p, c) > dist(a.p, c) ? s : a)).p];

  while (chosen.length < count) {
    const next = ok.reduce((a, s) =>
      Math.min(...chosen.map((q) => dist(q, s.p))) > Math.min(...chosen.map((q) => dist(q, a.p))) ? s : a,
    );
    // Pins closer than two of their reaches would cut into each other's holes.
    if (Math.min(...chosen.map((q) => dist(q, next.p))) < 2 * reach) break;

    chosen.push(next.p);
  }

  return chosen;
}

// ---------------------------------------------------------------- solids

interface Ctx {
  oc: OC;
  arena: Arena;
  frame: PlaneFrame;
  id: string;
  warnings: string[];
}

const along = (p: Vec3, d: Vec3, t: number): Vec3 => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];

function volume({ oc, arena }: Ctx, shape: TopoDS_Shape): number {
  const props = arena.track(new oc.GProp_GProps());
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);

  return Math.abs(props.Mass());
}

/** How much of `tool` lies inside `body` (0…1). */
function within(ctx: Ctx, body: Body, tool: TopoDS_Shape): number {
  const v = volume(ctx, tool);
  if (!(v > 0)) return 0;

  const common = ctx.arena.track(new ctx.oc.BRepAlgoAPI_Common(body.shape, tool));
  if (!common.IsDone() || common.HasErrors()) return 0;

  return volume(ctx, ctx.arena.track(common.Shape())) / v;
}

/** A cylinder of radius `r` on the plane point `at`, from `from` to `to` along the plane's normal. */
function cylinder(ctx: Ctx, at: P2, r: number, from: number, to: number): TopoDS_Shape {
  const { oc, arena, frame } = ctx;
  const base = along(toWorld(ctx.frame, at), frame.normal, from);
  const ax = arena.track(
    new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...base)), arena.track(new oc.gp_Dir(...frame.normal))),
  );

  return arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(ax, r, to - from)).Shape());
}

function compound(ctx: Ctx, shapes: TopoDS_Shape[]): TopoDS_Shape {
  const builder = ctx.arena.track(new ctx.oc.TopoDS_Builder());
  const c = ctx.arena.track(new ctx.oc.TopoDS_Compound());
  builder.MakeCompound(c);
  for (const shape of shapes) builder.Add(c, shape);

  return c;
}

function tool(ctx: Ctx, shape: TopoDS_Shape, tag: string): Body {
  const b = new Body(ctx.oc, ctx.arena, ctx.id, shape);
  b.faceTags = b.faces.map(() => [`${ctx.id}.${tag}`]);

  return b;
}

/** A straight prism over a closed polygon of world points, moved along `dir` by `length`. */
function prism(ctx: Ctx, pts: Vec3[], dir: Vec3, length: number): TopoDS_Shape {
  const { oc, arena } = ctx;
  const wireBuilder = arena.track(new oc.BRepBuilderAPI_MakeWire());
  const vs = pts.map((p) =>
    arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(arena.track(new oc.gp_Pnt(...p)))).Vertex()),
  );
  vs.forEach((vertex, i) =>
    wireBuilder.Add(
      arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(vertex, vs[(i + 1) % vs.length]!)).Edge()),
    ),
  );

  const face = arena.track(
    arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(wireBuilder.Wire()), true)).Face(),
  );

  return arena.track(
    arena
      .track(
        new oc.BRepPrimAPI_MakePrism(
          face,
          arena.track(new oc.gp_Vec(dir[0] * length, dir[1] * length, dir[2] * length)),
          false,
          true,
        ),
      )
      .Shape(),
  );
}

// ---------------------------------------------------------------- the connectors

/** The cut faces of the front piece as regions in the plane's coordinates. */
function cutRegions(ctx: Ctx, front: Body): Region[] {
  const { oc, arena, frame } = ctx;
  const n = frame.normal;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const out: Region[] = [];
  front.faces.forEach((face, i) => {
    const info = front.faceInfo[i]!;
    const p = front.facePoints[i]!;
    if (!info.planar || !info.normal || dot(info.normal, n) > -1 + 1e-6) return;

    if (Math.abs(dot([p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]], n)) > 1e-5) {
      return;
    }

    const segs: Seg[] = [];

    const to2 = (q: Vec3): P2 => {
      const d: Vec3 = [q[0] - frame.origin[0], q[1] - frame.origin[1], q[2] - frame.origin[2]];

      return [dot(d, frame.u), dot(d, frame.v)];
    };

    for (
      const explorer = arena.track(new oc.TopExp_Explorer(face, "TopAbs_EDGE"));
      explorer.More();
      explorer.Next()
    ) {
      const curveAdaptor = arena.track(
        new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(arena.track(explorer.Current()))),
      );
      const [t0, t1] = [curveAdaptor.FirstParameter(), curveAdaptor.LastParameter()];

      const at = (t: number) => {
        const q = arena.track(curveAdaptor.Value(t));

        return to2([q.X(), q.Y(), q.Z()]);
      };

      const k = curveAdaptor.GetType() === "GeomAbs_Line" ? 1 : 48;
      let prev = at(t0);

      for (let j = 1; j <= k; j++) {
        const next = at(t0 + ((t1 - t0) * j) / k);
        segs.push([prev, next]);
        prev = next;
      }
    }

    if (segs.length) out.push(region(segs));
  });

  return out;
}

export interface Joined {
  front: Body;
  back: Body;
  /** Loose dowels, each its own part. */
  dowels: Body[];
}

/**
 * Adds the connectors to a part split into `front` (keeps the part's id) and `back`. `whole` is the
 * part before the split, to check that pins and holes stay inside it. `dowelIds` names the dowels.
 */
export function joinPieces(
  oc: OC,
  arena: Arena,
  frame: PlaneFrame,
  f: ResolvedSplit & { connectors: Connectors },
  whole: Body,
  front: Body,
  back: Body,
  dowelId: (n: number) => string,
  warnings: string[],
): Joined {
  const ctx: Ctx = { oc, arena, frame, id: f.id, warnings };
  const c = f.connectors;
  const clearance = c.clearance ?? DEFAULT_CLEARANCE;
  if (clearance < 0 || clearance > 5) throw new FeatureError("the clearance must be between 0 and 5 mm");

  if (c.size !== undefined && !(c.size > 0)) {
    throw new FeatureError("the connector size must be greater than zero");
  }

  if (c.depth !== undefined && !(c.depth > 0)) {
    throw new FeatureError("the connector depth must be greater than zero");
  }

  const regions = cutRegions(ctx, front);
  if (!regions.length) throw new FeatureError("found no cut face for the connectors");

  return c.kind === "dovetail"
    ? dovetail(ctx, c, clearance, regions, whole, front, back)
    : pins(ctx, c, clearance, regions, whole, front, back, dowelId);
}

function pins(
  ctx: Ctx,
  c: Connectors,
  clearance: number,
  regions: Region[],
  whole: Body,
  front: Body,
  back: Body,
  dowelId: (n: number) => string,
): Joined {
  const dowels = c.kind === "dowels";
  // Where: the given points, or per cut face the roomiest spots.
  const spots: { at: P2; size: number }[] = [];

  if (c.points?.length) {
    const deep = Math.max(...regions.map((region) => Math.max(0, ...samples(region).map((s) => s.d))));
    for (const at of c.points) spots.push({ at, size: c.size ?? pinSize(deep) });
  } else {
    let tooThin = 0;

    for (const region of regions) {
      const pts = samples(region);
      const deep = Math.max(0, ...pts.map((s) => s.d));
      const size = c.size ?? pinSize(deep);
      const reach = size / 2 + clearance + WALL;
      // Two pins hold a piece from turning; a small cut only has room for one.
      const count =
        c.count ??
        (region.max[0] - region.min[0] > 6 * reach || region.max[1] - region.min[1] > 6 * reach ? 2 : 1);
      const at = placePins(pts, reach, count);
      if (!at.length) tooThin++;

      for (const p of at) spots.push({ at: p, size });
    }

    if (tooThin && !spots.length) {
      throw new FeatureError(`the cut is too thin for ${c.kind}`, "make them smaller, or use a dovetail");
    }

    if (tooThin) {
      ctx.warnings.push(`${tooThin} of the cut faces ${tooThin === 1 ? "is" : "are"} too thin for ${c.kind}`);
    }
  }

  const pinTools: TopoDS_Shape[] = [];
  const holeTools: TopoDS_Shape[] = [];
  const loose: Body[] = [];
  spots.forEach(({ at, size }, i) => {
    const r = size / 2;
    const length = c.depth ?? (dowels ? 3 * size : round(1.5 * size, 0.5));

    if (dowels) {
      // Each half of the dowel in its own piece; the holes a little deeper than half.
      const half = length / 2 + clearance;
      const hole = cylinder(ctx, at, r + clearance, -half, half);

      if (within(ctx, whole, hole) < 0.995) {
        ctx.warnings.push(
          `dowel ${i + 1} would come out of the part; make the dowels shorter or thinner, or place them`,
        );

        return;
      }

      holeTools.push(hole);

      const body = new Body(
        ctx.oc,
        ctx.arena,
        dowelId(loose.length + 1),
        cylinder(ctx, at, r, -length / 2, length / 2),
      );
      body.faceTags = body.faces.map(() => [`${ctx.id}.dowel`]);
      loose.push(body);
    } else {
      const pin = cylinder(ctx, at, r, -length, INSIDE);
      const hole = cylinder(ctx, at, r + clearance, -(length + clearance), INSIDE);

      if (within(ctx, whole, hole) < 0.995) {
        ctx.warnings.push(
          `pin ${i + 1} would come out of the part; make the pins shorter or thinner, or place them`,
        );

        return;
      }

      pinTools.push(pin);
      holeTools.push(hole);
    }
  });

  if (!holeTools.length) {
    throw new FeatureError(`no room for ${c.kind} inside the part`, "make them shorter or thinner");
  }

  const holes = tool(ctx, compound(ctx, holeTools), "hole");
  const back2 = booleanBodies(ctx.oc, ctx.arena, back, holes, "cut", back.bodyId);
  const front2 = dowels
    ? booleanBodies(ctx.oc, ctx.arena, front, holes, "cut", front.bodyId)
    : booleanBodies(
        ctx.oc,
        ctx.arena,
        front,
        tool(ctx, compound(ctx, pinTools), "pin"),
        "fuse",
        front.bodyId,
      );

  return { front: front2, back: back2, dowels: loose };
}

function dovetail(
  ctx: Ctx,
  c: Connectors,
  clearance: number,
  regions: Region[],
  whole: Body,
  front: Body,
  back: Body,
): Joined {
  const { frame } = ctx;
  const n = frame.normal;
  const tan = Math.tan((DOVETAIL_DEG * Math.PI) / 180);
  const tongues: TopoDS_Shape[] = [];
  const slots: TopoDS_Shape[] = [];

  for (const region of regions) {
    const pts = samples(region);
    if (!pts.length) continue;

    // Slides along the longer side of the cut unless told otherwise; sits across the roomiest point.
    const alongU = region.max[0] - region.min[0] >= region.max[1] - region.min[1];
    const a =
      c.angle !== undefined ? (c.angle * Math.PI) / 180 : alongU !== (c.slide === "short") ? 0 : Math.PI / 2;
    const s2: P2 = [Math.cos(a), Math.sin(a)];
    const w2: P2 = [-s2[1], s2[0]];
    const deepest = pts.reduce((x, y) => (y.d > x.d ? y : x));
    const size = c.size ?? Math.max(3, Math.min(20, round(deepest.d * 0.8, 0.5)));
    const depth = c.depth ?? Math.max(2, Math.min(10, round(size * 0.6, 0.5)));
    const wide = size / 2 + depth * tan;

    if (wide + clearance + WALL > deepest.d * 1.05 && c.size === undefined) {
      ctx.warnings.push("a cut face is too narrow for a dovetail");
      continue;
    }

    // Along the slide direction: the whole cut face and a little more, so the slot is open at both ends.
    const proj = region.segs.flatMap((sg) => sg.map((p) => p[0] * s2[0] + p[1] * s2[1]));
    const s0 = Math.min(...proj) - 1,
      s1 = Math.max(...proj) + 1;
    const across = deepest.p[0] * w2[0] + deepest.p[1] * w2[1];
    const world = (s: number, w: number, h: number): Vec3 =>
      along(toWorld(frame, [s * s2[0] + w * w2[0], s * s2[1] + w * w2[1]]), n, h);
    const sDir: Vec3 = [
      frame.u[0] * s2[0] + frame.v[0] * s2[1],
      frame.u[1] * s2[0] + frame.v[1] * s2[1],
      frame.u[2] * s2[0] + frame.v[2] * s2[1],
    ];
    // Profile across: narrow at the cut, wider at the tip (h = -depth), so the pieces cannot be pulled apart.
    const half = (h: number) => size / 2 - h * tan;

    const tongue = (grow: number, tip: number, top: number) => {
      const g = grow / Math.cos((DOVETAIL_DEG * Math.PI) / 180);

      return prism(
        ctx,
        [
          world(s0, across - half(top) - g, top),
          world(s0, across + half(top) + g, top),
          world(s0, across + half(tip) + g, tip),
          world(s0, across - half(tip) - g, tip),
        ],
        sDir,
        s1 - s0,
      );
    };

    const shape = tongue(0, -depth, INSIDE);

    if (within(ctx, whole, shape) < 0.3) {
      ctx.warnings.push("a dovetail would mostly lie outside the part");
      continue;
    }

    const common = ctx.arena.track(new ctx.oc.BRepAlgoAPI_Common(whole.shape, shape));
    if (!common.IsDone() || common.HasErrors()) continue;

    tongues.push(ctx.arena.track(common.Shape()));
    slots.push(tongue(clearance, -(depth + clearance), INSIDE));
  }

  if (!tongues.length) {
    throw new FeatureError("no room for a dovetail at the cut", "make it smaller, or use pins");
  }

  const front2 = booleanBodies(
    ctx.oc,
    ctx.arena,
    front,
    tool(ctx, compound(ctx, tongues), "dovetail"),
    "fuse",
    front.bodyId,
  );
  const back2 = booleanBodies(
    ctx.oc,
    ctx.arena,
    back,
    tool(ctx, compound(ctx, slots), "slot"),
    "cut",
    back.bodyId,
  );

  return { front: front2, back: back2, dowels: [] };
}
