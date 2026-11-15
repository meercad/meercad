/** Hit testing and snapping: what lies under the cursor, and where a new point lands. */
import type { SketchFeature } from "@meercad/schema";
import {
  distance2,
  intersectionPoints,
  type SolvedCurve,
  type SolvedSketch,
  type Vec2,
} from "@meercad/sketch";
import type { SectionChain } from "@meercad/kernel/fit";
import { curveDistance, nearestOnPolyline, pointEntries, projectOnCurve, type ModelEdge } from "./geometry";
import type { Snap } from "./types";

/** The sketch point nearest `p` within `tol`, the origin included. */
export function hitPoint(
  sketch: SketchFeature | undefined,
  shown: SolvedSketch | null,
  p: Vec2,
  tol: number,
  exclude?: Set<string>,
): string | null {
  if (!shown) return null;

  let best: string | null = null;
  let bd = tol;

  for (const [id, q] of pointEntries(sketch, shown)) {
    if (exclude?.has(id)) continue;

    const d = distance2(p, q);

    // A sketch point sitting on the origin wins over the origin itself: a chain started there
    // closes on its own first point instead of getting a second one tied to the origin.
    if (d < bd || (best === "origin" && d <= bd + 1e-9)) {
      bd = d;
      best = id;
    }
  }

  return best;
}

/** The curve nearest `p` within `tol`. */
export function hitCurve(
  shown: SolvedSketch | null,
  p: Vec2,
  tol: number,
  exclude?: Set<string>,
): SolvedCurve | null {
  if (!shown) return null;

  let best: SolvedCurve | null = null;
  let bd = tol;

  for (const curve of shown.curves) {
    if (exclude?.has(curve.id)) continue;

    const d = curveDistance(curve, p);

    if (d < bd) {
      bd = d;
      best = curve;
    }
  }

  return best;
}

/** Midpoints of lines and crossings of curves, worked out once per solve. */
export interface SnapTargets {
  mids: { id: string; pt: Vec2 }[];
  crosses: { pt: Vec2; a: string; b: string }[];
}

/** Midpoints and crossings of the solved curves, for snapping. */
export function snapTargetsOf(curves: SolvedCurve[]): SnapTargets {
  const mids = curves.flatMap((curve) =>
    curve.kind === "line"
      ? [{ id: curve.id, pt: [(curve.a[0] + curve.b[0]) / 2, (curve.a[1] + curve.b[1]) / 2] as Vec2 }]
      : [],
  );
  const crosses: { pt: Vec2; a: string; b: string }[] = [];

  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      for (const pt of intersectionPoints(curves[i]!, curves[j]!)) {
        crosses.push({ pt, a: curves[i]!.id, b: curves[j]!.id });
      }
    }
  }

  return { mids, crosses };
}

/** Everything a snap looks at. */
export interface SnapScene {
  sketch: SketchFeature | undefined;
  shown: SolvedSketch;
  /** One screen pixel in sketch units: the snap distances are in pixels. */
  unit: number;
  snapGrid: boolean;
  snapGeometry: boolean;
  targets: SnapTargets;
  modelEdges: ModelEdge[];
  sections: SectionChain[];
  /** The grid's step, as the viewport lays it out in the sketch plane. */
  gridStep: () => number;
}

/** Snap distances, in screen pixels. */
const SNAP_PIXELS = { point: 10, curve: 7, axis: 6, align: 8 };

/**
 * Where the cursor at `p` lands: existing points, then (with smart snaps) midpoints, crossings,
 * curves and the model's edges, then the origin axes, alignments with other points and the grid.
 * `from` is the point being drawn from, so lines line up with it.
 */
export function snapPoint(scene: SnapScene, p: Vec2, exclude?: Set<string>, from?: Vec2): Snap {
  const tol = scene.unit * SNAP_PIXELS.point;
  const pt = hitPoint(scene.sketch, scene.shown, p, tol, exclude);
  if (pt) return { pos: scene.shown.points.get(pt)!, point: pt, kind: "point" };

  if (scene.snapGeometry) {
    const onGeometry = snapToGeometry(scene, p, exclude) ?? snapToModel(scene, p);
    if (onGeometry) return onGeometry;
  }

  return snapToAxis(scene, p) ?? alignOrGrid(scene, p, exclude, from);
}

/** A line's midpoint, a crossing or a point on a curve of the sketch. */
function snapToGeometry(scene: SnapScene, p: Vec2, exclude?: Set<string>): Snap | null {
  const tol = scene.unit * SNAP_PIXELS.point;
  const near = (q: Vec2) => distance2(p, q);
  const mid = scene.targets.mids
    .filter((m) => !exclude?.has(m.id) && near(m.pt) < tol)
    .sort((a, b) => near(a.pt) - near(b.pt))[0];
  if (mid) return { pos: mid.pt, mid: mid.id, kind: "mid" };

  const cross = scene.targets.crosses
    .filter((c) => !exclude?.has(c.a) && !exclude?.has(c.b) && near(c.pt) < tol)
    .sort((a, b) => near(a.pt) - near(b.pt))[0];
  if (cross) return { pos: cross.pt, curve: cross.a, curve2: cross.b, kind: "cross" };

  const curve = hitCurve(scene.shown, p, scene.unit * SNAP_PIXELS.curve, exclude);
  if (curve) return { pos: projectOnCurve(curve, p), curve: curve.id, kind: "curve" };

  return null;
}

/**
 * The model's own edges in this plane: corners and circle centres, then anywhere on an edge or on
 * a mesh section.
 */
function snapToModel(scene: SnapScene, p: Vec2): Snap | null {
  const tol = scene.unit * SNAP_PIXELS.point;
  const near = (q: Vec2) => distance2(p, q);
  let corner: { pos: Vec2; d: number; kind: "point" | "center" } | null = null;

  for (const edge of scene.modelEdges) {
    const ends = edge.center ? [] : [edge.pts[0]!, edge.pts[edge.pts.length - 1]!];

    for (const q of ends) {
      if (near(q) < tol && (!corner || near(q) < corner.d)) {
        corner = { pos: q, d: near(q), kind: "point" };
      }
    }

    if (edge.center && near(edge.center) < tol && (!corner || near(edge.center) < corner.d)) {
      corner = { pos: edge.center, d: near(edge.center), kind: "center" };
    }
  }

  if (corner) return { pos: corner.pos, kind: corner.kind };

  const within = scene.unit * SNAP_PIXELS.curve;
  let onEdge: { pos: Vec2; dist: number } | null = null;

  for (const edge of scene.modelEdges) {
    const h = nearestOnPolyline(edge.pts, p);
    if (h.dist < within && (!onEdge || h.dist < onEdge.dist)) onEdge = h;
  }

  for (const c of scene.sections) {
    const h = nearestOnPolyline(c.closed ? [...c.points, c.points[0]!] : c.points, p);
    if (h.dist < within && (!onEdge || h.dist < onEdge.dist)) onEdge = h;
  }

  return onEdge ? { pos: onEdge.pos, kind: "edge" } : null;
}

/** On an origin axis: a real reference, so a point placed there gets constrained to it. */
function snapToAxis(scene: SnapScene, p: Vec2): Snap | null {
  const axisTol = scene.unit * SNAP_PIXELS.axis;
  const kind = scene.snapGrid ? "grid" : "curve";

  if (Math.abs(p[1]) < axisTol) return { pos: [toGrid(scene, p[0]), 0], curve: "origin.x", kind };
  if (Math.abs(p[0]) < axisTol) return { pos: [0, toGrid(scene, p[1])], curve: "origin.y", kind };

  return null;
}

/** A coordinate on the grid, when grid snapping is on. */
function toGrid(scene: SnapScene, v: number): number {
  if (!scene.snapGrid) return v;

  // The same step the grid shows (the viewport lays it out in this sketch's plane).
  const step = scene.gridStep();

  return Math.round(v / step) * step;
}

/**
 * Lined up with another point (or the point drawn from) along x and/or y, with dashed guides to
 * it; otherwise on the grid.
 */
function alignOrGrid(scene: SnapScene, p: Vec2, exclude?: Set<string>, from?: Vec2): Snap {
  let ax: { v: number; from: Vec2 } | null = null;
  let ay: { v: number; from: Vec2 } | null = null;

  if (scene.snapGeometry) {
    const alignTol = scene.unit * SNAP_PIXELS.align;

    for (const q of alignCandidates(scene, exclude, from)) {
      const dx = Math.abs(q[0] - p[0]);
      const dy = Math.abs(q[1] - p[1]);
      if (dx < alignTol && (!ax || dx < Math.abs(ax.v - p[0]))) ax = { v: q[0], from: q };
      if (dy < alignTol && (!ay || dy < Math.abs(ay.v - p[1]))) ay = { v: q[1], from: q };
    }
  }

  const pos: Vec2 = [ax ? ax.v : toGrid(scene, p[0]), ay ? ay.v : toGrid(scene, p[1])];

  if (ax || ay) {
    const guides: [Vec2, Vec2][] = [];
    if (ax) guides.push([ax.from, pos]);
    if (ay) guides.push([ay.from, pos]);

    return { pos, kind: "align", guides };
  }

  return scene.snapGrid ? { pos, kind: "grid" } : { pos };
}

/** The points a new one can line up with: the one drawn from, the sketch's and the model's corners. */
function alignCandidates(scene: SnapScene, exclude?: Set<string>, from?: Vec2): Vec2[] {
  const modelPoints = scene.modelEdges.flatMap((edge) =>
    edge.center ? [edge.center] : [edge.pts[0]!, edge.pts[edge.pts.length - 1]!],
  );

  return [
    ...(from ? [from] : []),
    ...pointEntries(scene.sketch, scene.shown)
      .filter(([id]) => !exclude?.has(id) && id !== "origin")
      .map(([, q]) => q),
    ...modelPoints,
  ];
}
