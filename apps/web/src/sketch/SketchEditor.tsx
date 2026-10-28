/**
 * In-viewport sketch editor. Geometry lives in the document; this component renders the locally
 * solved sketch on its plane, turns pointer input into entities and constraints, and drags points
 * with PlaneGCS temporary constraints.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { evaluate, resolveFeature } from "@meercad/model";
import type { Expr, SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import { findRegions, intersectionPoints, type ResolvedConstraint, type SketchSolver, type SolvedCurve, type SolvedSketch, type Vec2 } from "@meercad/sketch";
import { frameMatrix, perFrame, THREE, type Viewport } from "@meercad/viewport";
import { parseExpr } from "../components/ExprInput";
import { featureName } from "../lib/features";
import { usePhoneSheets } from "../lib/layout";
import { edgeSelectorForPick } from "../lib/topology";
import { closeSketch, toast, useApp } from "../store";
import { Kbd } from "../components/Kbd";
import { docUnit, fmtLen, inUnit, lengthExpr } from "../lib/units";
import { InlineInput } from "../components/InlineValues";
import { actionFor, SKETCH_ACTIONS, usePrefs } from "../lib/keymap";
import { activeSketch, applyConstraint, CONSTRAINT_TOOLS, deleteSelection, freshId, selectAll, setExternalKinds, toggleConstruction, writeSketch } from "./actions";
import { GLYPH } from "./icons";
import { Press } from "../lib/gestures";
import { ValueInput } from "../components/ValueInput";
import { getSolver } from "./solver";
import { sameSel, setSketchSelection, setTool, useSketchUi, type SketchSel, type SketchTool } from "./state";

type Draft = Pick<SketchFeature, "entities" | "constraints">;
type NewEntity = SketchEntity extends infer E ? (E extends unknown ? Omit<E, "id"> : never) : never;
type NewConstraint = SketchConstraint extends infer C ? (C extends unknown ? Omit<C, "id"> : never) : never;
interface Snap {
  pos: Vec2;
  /** Existing point reference to reuse / constrain to. */
  point?: string;
  /** Curve the point lies on. */
  curve?: string;
  /** Second curve, for a snap onto the crossing of two curves. */
  curve2?: string;
  /** Line whose midpoint this is. */
  mid?: string;
  /** What the cursor locked onto, for the marker. */
  kind?: "point" | "mid" | "cross" | "curve" | "align" | "grid" | "center" | "edge";
  /** Dashed alignment guides, in sketch coordinates. */
  guides?: [Vec2, Vec2][];
}

const COLORS = { under: 0x2266dd, full: 0x16a34a, construction: 0x8aa4c8, external: 0xa35cff, sel: 0xff7a1a, hover: 0x2e7dff, preview: 0x1a5fd6, conflict: 0xd93f3f, snap: 0xf08c00, guide: 0x8a94a6 };

export function SketchEditor({ viewport, sketchId }: { viewport: Viewport; sketchId: string }) {
  const doc = useApp((s) => s.doc);
  const output = useApp((s) => s.output);
  const ui = useSketchUi();
  const sketch = doc.features.find((f) => f.id === sketchId) as SketchFeature | undefined;
  const view = output?.report.sketches.find((s) => s.id === sketchId);
  const frame = view?.frame;
  const params = output?.report.params;
  const [solver, setSolver] = useState<SketchSolver | null>(null);
  const [drag, setDrag] = useState<SolvedSketch | null>(null);
  const [hover, setHover] = useState<SketchSel | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const toolState = useRef<{ points: Snap[]; cursor: Vec2 | null; snap: Snap | null; sweep: number; dimFirst: SketchSel | null }>({ points: [], cursor: null, snap: null, sweep: 0, dimFirst: null });
  usePrefs(); // re-render when snapping settings change
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  useEffect(() => {
    void getSolver().then(setSolver);
  }, []);

  // Align to the sketch plane once it is known.
  const aligned = useRef(false);
  useEffect(() => {
    if (frame && !aligned.current) {
      aligned.current = true;
      viewport.alignToFrame(frame);
      if (!sketch?.entities.length) setTool("line");
      else setTool("select");
    }
  }, [frame]);
  useEffect(() => () => setSketchSelection([]), []);

  const external = useMemo(() => (view?.curves ?? []).filter((c) => c.external), [view]);
  useEffect(() => {
    setExternalKinds(new Map(external.map((c) => [c.id, c.kind])));
  }, [external]);

  const resolvedConstraints = useMemo((): { list: ResolvedConstraint[]; bad: Set<string> } => {
    if (!sketch) return { list: [], bad: new Set() };
    const scope = new Map(Object.entries(params ?? {}));
    const bad = new Set<string>();
    const list = sketch.constraints.flatMap((c) => {
      try {
        return (resolveFeature({ ...sketch, constraints: [c] }, scope) as { constraints: ResolvedConstraint[] }).constraints;
      } catch {
        bad.add(c.id);
        return [];
      }
    });
    return { list, bad };
  }, [sketch, params]);

  const solved = useMemo((): SolvedSketch | null => {
    if (!solver || !sketch) return null;
    try {
      return solver.solve({ entities: sketch.entities, constraints: resolvedConstraints.list, external });
    } catch (e) {
      return { points: new Map(), curves: [], diagnostics: { dof: 0, ok: false, conflicting: [], redundant: [], message: e instanceof Error ? e.message : String(e) } };
    }
  }, [solver, sketch, resolvedConstraints, external]);
  const shown = drag ?? solved;
  const regions = useMemo(() => (shown ? findRegions(shown.curves) : []), [shown]);

  /** Solves `next` and stores the solved coordinates so the document stays a good initial guess. */
  const commit = (next: Draft, merge = false) => {
    if (!solver) return writeSketch(next, merge);
    const scope = new Map(Object.entries(params ?? {}));
    let cons: ResolvedConstraint[] = [];
    try {
      cons = (resolveFeature({ ...sketch!, ...next }, scope) as { constraints: ResolvedConstraint[] }).constraints;
    } catch {
      return writeSketch(next, merge);
    }
    const s = solver.solve({ entities: next.entities, constraints: cons, external });
    const entities = s.diagnostics.ok ? applySolution(next.entities, s) : next.entities;
    if (!s.diagnostics.ok && s.diagnostics.conflicting.length) toast(`Over-constrained: ${s.diagnostics.conflicting.join(", ")}`, "error");
    return writeSketch({ entities, constraints: next.constraints }, merge);
  };

  // ---------------------------------------------------------------- THREE rendering
  const group = useMemo(() => new THREE.Group(), []);
  useEffect(() => {
    viewport.overlay.add(group);
    return () => {
      viewport.overlay.remove(group);
      disposeGroup(group);
    };
  }, [viewport, group]);

  // Grid on the sketch plane (the world grid only lies on XY), rebuilt as the camera moves.
  // The viewport draws the grid in the sketch plane (endless, following the zoom); the sketch adds its axes.
  const axesGroup = useMemo(() => new THREE.Group(), []);
  useEffect(() => {
    if (!frame) return;
    viewport.setGridFrame(frame);
    viewport.overlay.add(axesGroup);
    axesGroup.matrixAutoUpdate = false;
    axesGroup.matrix.copy(frameMatrix(frame));
    const dark = document.documentElement.dataset["theme"] === "dark" || (!document.documentElement.dataset["theme"] && matchMedia("(prefers-color-scheme: dark)").matches);
    const far = 1e5;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-far, 0, 0, far, 0, 0, 0, -far, 0, 0, far, 0], 3));
    const axes = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: dark ? 0xa8b3c8 : 0x5d6878, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }));
    axes.renderOrder = 3;
    axesGroup.add(axes);
    return () => {
      viewport.setGridFrame(null);
      viewport.overlay.remove(axesGroup);
      disposeGroup(axesGroup);
    };
  }, [viewport, frame, axesGroup]);

  const ts = toolState.current;
  useEffect(() => {
    disposeGroup(group);
    if (!frame || !shown) return;
    group.matrixAutoUpdate = false;
    group.matrix.copy(frameMatrix(frame));
    const full = shown.diagnostics.dof === 0 && shown.diagnostics.ok;
    const isSel = (s: SketchSel) => ui.selection.some((x) => sameSel(x, s));
    const conflictCurves = new Set<string>();
    for (const cid of shown.diagnostics.conflicting) {
      const c = sketch?.constraints.find((x) => x.id === cid);
      if (c) for (const v of refsOf(c)) conflictCurves.add(v);
    }
    // Regions (closed profiles) as a light fill.
    for (const r of regions) {
      if (r.depth % 2 === 0) continue;
      const shape = new THREE.Shape(r.polygons[0]!.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of r.polygons.slice(1)) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: COLORS.under, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      m.renderOrder = 20;
      group.add(m);
    }
    for (const c of shown.curves) {
      const sel = isSel({ kind: "curve", id: c.id });
      const hov = hover?.kind === "curve" && hover.id === c.id;
      const color = sel ? COLORS.sel : hov ? COLORS.hover : conflictCurves.has(c.id) ? COLORS.conflict : c.external ? COLORS.external : c.construction ? COLORS.construction : full ? COLORS.full : COLORS.under;
      group.add(curveObject(c, color, c.construction));
    }
    // Points
    const pts: number[] = [];
    const ptCols: number[] = [];
    const col = new THREE.Color();
    for (const [id, [x, y]] of pointEntries(sketch, shown)) {
      pts.push(x, y, 0);
      const sel = isSel({ kind: "point", id });
      const hov = hover?.kind === "point" && hover.id === id;
      col.setHex(sel ? COLORS.sel : hov ? COLORS.hover : id === "origin" ? 0x8a93a3 : full ? COLORS.full : COLORS.under);
      ptCols.push(col.r, col.g, col.b);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    pg.setAttribute("color", new THREE.Float32BufferAttribute(ptCols, 3));
    const points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false, map: dotTexture(), transparent: true, alphaTest: 0.5 }));
    points.renderOrder = 30;
    group.add(points);
    // Tool preview
    for (const obj of previewObjects(ui.tool, { ...ts, cursor: entryTarget() ?? ts.cursor }, shown)) group.add(obj);
    if (ts.snap) for (const obj of snapObjects(ts.snap, viewport.pixelSize(frame.origin))) group.add(obj);
    // Dimension lines
    for (const c of sketch?.constraints ?? []) {
      const geo = dimensionGeometry(c, shown);
      if (geo) {
        const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(geo.map(([x, y]) => new THREE.Vector3(x, y, 0))), new THREE.LineBasicMaterial({ color: 0x6b7280, depthTest: false }));
        l.renderOrder = 25;
        group.add(l);
      }
    }
  });

  // ---------------------------------------------------------------- hit testing
  const px = () => viewport.pixelSize(frame?.origin);
  const toSketch = (e: { clientX: number; clientY: number }) => (frame ? viewport.rayToPlane(e.clientX, e.clientY, frame) : null);

  const hitPoint = (p: Vec2, tol: number, exclude?: Set<string>): string | null => {
    if (!shown) return null;
    let best: string | null = null;
    let bd = tol;
    for (const [id, q] of pointEntries(sketch, shown)) {
      if (exclude?.has(id)) continue;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  };
  const hitCurve = (p: Vec2, tol: number, exclude?: Set<string>): SolvedCurve | null => {
    if (!shown) return null;
    let best: SolvedCurve | null = null;
    let bd = tol;
    for (const c of shown.curves) {
      if (exclude?.has(c.id)) continue;
      const d = curveDistance(c, p);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  // Midpoints and crossings of the solved curves, for snapping.
  const snapTargets = useMemo(() => {
    const curves = shown?.curves ?? [];
    const mids = curves.flatMap((c) => (c.kind === "line" ? [{ id: c.id, pt: [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2] as Vec2 }] : []));
    const crosses: { pt: Vec2; a: string; b: string }[] = [];
    for (let i = 0; i < curves.length; i++)
      for (let j = i + 1; j < curves.length; j++) for (const pt of intersectionPoints(curves[i]!, curves[j]!)) crosses.push({ pt, a: curves[i]!.id, b: curves[j]!.id });
    return { mids, crosses };
  }, [shown]);
  // Model edges in the sketch plane (outline and holes of the face sketched on).
  const modelEdges = useMemo(() => {
    if (!frame || !output) return [];
    const size = Math.max(1, ...output.report.bodies.map((b) => Math.hypot(...b.bbox.max.map((v, i) => v - b.bbox.min[i]!))));
    return planeEdges(output.meshes, frame, size * 1e-5 + 1e-4);
  }, [output, frame]);

  /**
   * Where the cursor lands: existing points, then (with smart snaps) midpoints, crossings, curves and
   * alignments with other points, then the grid. `from` is the point being drawn from, so lines lock
   * horizontal/vertical to it. Alt turns snapping off.
   */
  const snap = (p: Vec2, exclude?: Set<string>, from?: Vec2, free = false): Snap => {
    if (free || !shown) return { pos: p };
    const { snapGrid, snapGeometry } = usePrefs.getState();
    const unit = px();
    const tol = unit * 10;
    const near = (q: Vec2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    const pt = hitPoint(p, tol, exclude);
    if (pt) return { pos: shown.points.get(pt)!, point: pt, kind: "point" };
    if (snapGeometry) {
      const mid = snapTargets.mids.filter((m) => !exclude?.has(m.id) && near(m.pt) < tol).sort((a, b) => near(a.pt) - near(b.pt))[0];
      if (mid) return { pos: mid.pt, mid: mid.id, kind: "mid" };
      const cross = snapTargets.crosses.filter((c) => !exclude?.has(c.a) && !exclude?.has(c.b) && near(c.pt) < tol).sort((a, b) => near(a.pt) - near(b.pt))[0];
      if (cross) return { pos: cross.pt, curve: cross.a, curve2: cross.b, kind: "cross" };
      const c = hitCurve(p, unit * 7, exclude);
      if (c) return { pos: projectOnCurve(c, p), curve: c.id, kind: "curve" };
      // The model's own edges in this plane: corners and circle centres, then anywhere on an edge.
      let corner: { pos: Vec2; d: number; kind: "point" | "center" } | null = null;
      for (const e of modelEdges) {
        const ends = e.center ? [] : [e.pts[0]!, e.pts[e.pts.length - 1]!];
        for (const q of ends) if (near(q) < tol && (!corner || near(q) < corner.d)) corner = { pos: q, d: near(q), kind: "point" };
        if (e.center && near(e.center) < tol && (!corner || near(e.center) < corner.d)) corner = { pos: e.center, d: near(e.center), kind: "center" };
      }
      if (corner) return { pos: corner.pos, kind: corner.kind };
      let onEdge: { pos: Vec2; dist: number } | null = null;
      for (const e of modelEdges) {
        const h = nearestOnPolyline(e.pts, p);
        if (h.dist < unit * 7 && (!onEdge || h.dist < onEdge.dist)) onEdge = h;
      }
      if (onEdge) return { pos: onEdge.pos, kind: "edge" };
    }
    // The same step the grid shows (the viewport lays it out in this sketch's plane).
    const step = viewport.gridSpacing;
    const toGrid = (v: number) => (snapGrid ? Math.round(v / step) * step : v);
    // The origin axes are real references: a point placed on them gets constrained there.
    const axisTol = unit * 6;
    if (Math.abs(p[1]) < axisTol) return { pos: [toGrid(p[0]), 0], curve: "origin.x", kind: snapGrid ? "grid" : "curve" };
    if (Math.abs(p[0]) < axisTol) return { pos: [0, toGrid(p[1])], curve: "origin.y", kind: snapGrid ? "grid" : "curve" };
    let ax: { v: number; from: Vec2 } | null = null;
    let ay: { v: number; from: Vec2 } | null = null;
    if (snapGeometry) {
      const alignTol = unit * 8;
      const modelPoints = modelEdges.flatMap((e) => (e.center ? [e.center] : [e.pts[0]!, e.pts[e.pts.length - 1]!]));
      const candidates: Vec2[] = [...(from ? [from] : []), ...pointEntries(sketch, shown).filter(([id]) => !exclude?.has(id) && id !== "origin").map(([, q]) => q), ...modelPoints];
      for (const q of candidates) {
        const dx = Math.abs(q[0] - p[0]);
        const dy = Math.abs(q[1] - p[1]);
        if (dx < alignTol && (!ax || dx < Math.abs(ax.v - p[0]))) ax = { v: q[0], from: q };
        if (dy < alignTol && (!ay || dy < Math.abs(ay.v - p[1]))) ay = { v: q[1], from: q };
      }
    }
    const pos: Vec2 = [ax ? ax.v : toGrid(p[0]), ay ? ay.v : toGrid(p[1])];
    if (ax || ay) {
      const guides: [Vec2, Vec2][] = [];
      if (ax) guides.push([ax.from, pos]);
      if (ay) guides.push([ay.from, pos]);
      return { pos, kind: "align", guides };
    }
    return snapGrid ? { pos, kind: "grid" } : { pos };
  };

  // ---------------------------------------------------------------- building geometry
  const builder = (base: Draft) => {
    const d: Draft = { entities: [...base.entities], constraints: [...base.constraints] };
    const taken = new Set<string>();
    const isEntityPoint = (id: string) => d.entities.some((e) => e.id === id && e.type === "point");
    return {
      d,
      point(s: Snap, construction = false): string {
        if (s.point && isEntityPoint(s.point)) return s.point;
        const id = freshId(d, "p", taken);
        d.entities.push({ id, type: "point", x: s.pos[0], y: s.pos[1], ...(construction ? { construction } : {}) });
        if (s.point) d.constraints.push({ id: freshId(d, "c", taken), type: "coincident", a: id, b: s.point });
        else if (s.mid) d.constraints.push({ id: freshId(d, "c", taken), type: "midpoint", point: id, line: s.mid });
        else if (s.curve) {
          d.constraints.push({ id: freshId(d, "c", taken), type: "point_on", point: id, curve: s.curve });
          if (s.curve2) d.constraints.push({ id: freshId(d, "c", taken), type: "point_on", point: id, curve: s.curve2 });
        }
        return id;
      },
      entity(e: NewEntity, prefix: string): string {
        const id = freshId(d, prefix, taken);
        d.entities.push({ ...e, id } as SketchEntity);
        return id;
      },
      constraint(c: NewConstraint): string {
        const id = freshId(d, "c", taken);
        d.constraints.push({ ...c, id } as SketchConstraint);
        return id;
      },
    };
  };
  const construction = ui.construction;
  const cons = construction ? { construction: true } : {};

  const addLine = (a: Snap, b: Snap, length?: Expr): [string, string] | null => {
    if (!sketch || Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]) < px() * 2) return null;
    const bl = builder(sketch);
    const p1 = bl.point(a);
    const p2 = bl.point(b);
    const l = bl.entity({ type: "line", p1, p2, ...cons }, "l");
    setLastShape({ kind: "line", id: l });
    if (length !== undefined) bl.constraint({ type: "length", line: l, value: length });
    const ang = Math.abs(Math.atan2(b.pos[1] - a.pos[1], b.pos[0] - a.pos[0]));
    const tolA = (3 * Math.PI) / 180;
    if (ang < tolA || Math.abs(ang - Math.PI) < tolA) bl.constraint({ type: "horizontal", line: l });
    else if (Math.abs(ang - Math.PI / 2) < tolA) bl.constraint({ type: "vertical", line: l });
    commit(bl.d);
    return [p1, p2];
  };

  const addRect = (a: Snap, b: Snap, centered: boolean, size?: { w?: Expr; h?: Expr }) => {
    if (!sketch) return;
    const [cx, cy] = a.pos;
    const [x0, y0, x1, y1] = centered ? [2 * cx - b.pos[0], 2 * cy - b.pos[1], b.pos[0], b.pos[1]] : [a.pos[0], a.pos[1], b.pos[0], b.pos[1]];
    if (Math.abs(x1 - x0) < px() * 2 || Math.abs(y1 - y0) < px() * 2) return;
    const bl = builder(sketch);
    const corners: Snap[] = [{ pos: [x0, y0] }, { pos: [x1, y0] }, { pos: [x1, y1] }, { pos: [x0, y1] }];
    if (!centered) corners[0] = a;
    corners[2] = b;
    const ids = corners.map((c) => bl.point(c));
    const lines = ids.map((p, i) => bl.entity({ type: "line", p1: p, p2: ids[(i + 1) % 4]!, ...cons }, "l"));
    bl.constraint({ type: "horizontal", line: lines[0]! });
    bl.constraint({ type: "horizontal", line: lines[2]! });
    bl.constraint({ type: "vertical", line: lines[1]! });
    bl.constraint({ type: "vertical", line: lines[3]! });
    if (size?.w !== undefined) bl.constraint({ type: "length", line: lines[0]!, value: size.w });
    if (size?.h !== undefined) bl.constraint({ type: "length", line: lines[1]!, value: size.h });
    if (centered) {
      const center = bl.point(a, true);
      const diag = bl.entity({ type: "line", p1: ids[0]!, p2: ids[2]!, construction: true }, "l");
      bl.constraint({ type: "midpoint", point: center, line: diag });
    }
    commit(bl.d);
  };

  const addCircle = (c: Snap, r: number, diameter?: Expr) => {
    if (!sketch || r < px() * 2) return;
    const bl = builder(sketch);
    const center = bl.point(c);
    const id = bl.entity({ type: "circle", center, radius: r, ...cons }, "c");
    setLastShape({ kind: "circle", id });
    if (diameter !== undefined) bl.constraint({ type: "diameter", curve: id, value: diameter });
    commit(bl.d);
  };

  const addArc = (c: Snap, s: Snap, e: Snap, ccw: boolean, angle?: Expr) => {
    if (!sketch) return;
    const r = Math.hypot(s.pos[0] - c.pos[0], s.pos[1] - c.pos[1]);
    if (r < px() * 2) return;
    const bl = builder(sketch);
    const center = bl.point(c);
    const a = Math.atan2(e.pos[1] - c.pos[1], e.pos[0] - c.pos[0]);
    const endOnCircle: Snap = { ...e, pos: [c.pos[0] + r * Math.cos(a), c.pos[1] + r * Math.sin(a)] };
    const start = bl.point(ccw ? s : endOnCircle);
    const end = bl.point(ccw ? endOnCircle : s);
    const id = bl.entity({ type: "arc", center, start, end, ...cons }, "a");
    if (angle !== undefined) bl.constraint({ type: "arc_angle", curve: id, value: angle });
    commit(bl.d);
    setLastShape({ kind: "arc", id });
  };

  /** Arc through its two ends and a third point that sets bulge and radius; typed values become dimensions. */
  const add3PointArc = (a: Snap, b: Snap, m: Vec2, dims: { radius?: Expr | undefined; angle?: Expr | undefined } = {}) => {
    if (!sketch) return;
    const g = arcThrough(a.pos, b.pos, m);
    if (!g || g.radius < px() * 2) return;
    const bl = builder(sketch);
    const center = bl.point({ pos: g.center });
    const [sa, sb] = g.swapped ? [b, a] : [a, b];
    const start = bl.point(sa);
    const end = bl.point(sb);
    const id = bl.entity({ type: "arc", center, start, end, ...cons }, "a");
    if (dims.radius !== undefined) bl.constraint({ type: "radius", curve: id, value: dims.radius });
    if (dims.angle !== undefined) bl.constraint({ type: "arc_angle", curve: id, value: dims.angle });
    commit(bl.d);
    setLastShape({ kind: "arc", id });
  };

  /** Regular polygon inscribed in a construction circle; equal sides keep it regular. */
  const addPolygon = (c: Snap, v: Vec2, sides = 6) => {
    if (!sketch) return;
    const r = Math.hypot(v[0] - c.pos[0], v[1] - c.pos[1]);
    if (r < px() * 2) return;
    const bl = builder(sketch);
    const center = bl.point(c);
    const circle = bl.entity({ type: "circle", center, radius: r, construction: true }, "c");
    const a0 = Math.atan2(v[1] - c.pos[1], v[0] - c.pos[0]);
    const pts = Array.from({ length: sides }, (_, i) => {
      const a = a0 + (i * 2 * Math.PI) / sides;
      const id = bl.point({ pos: [c.pos[0] + r * Math.cos(a), c.pos[1] + r * Math.sin(a)] });
      bl.constraint({ type: "point_on", point: id, curve: circle });
      return id;
    });
    const lines = pts.map((p, i) => bl.entity({ type: "line", p1: p, p2: pts[(i + 1) % sides]!, ...cons }, "l"));
    for (let i = 1; i < lines.length; i++) bl.constraint({ type: "equal", a: lines[0]!, b: lines[i]! });
    commit(bl.d);
  };

  /** Removes the piece of a curve between the nearest intersections around the click. */
  const trimAt = (p: Vec2) => {
    if (!sketch || !shown) return;
    const target = hitCurve(p, px() * 8);
    if (!target || target.external) return;
    const others = shown.curves.filter((c) => c.id !== target.id && !c.construction);
    const hits = others.flatMap((o) => intersectionPoints(target, o).map((pt) => ({ pt, curve: o.id })));
    const bl = builder({ entities: sketch.entities, constraints: sketch.constraints });
    const d = bl.d;
    const drop = (id: string) => {
      d.entities = d.entities.filter((e) => e.id !== id);
      d.constraints = d.constraints.filter((c) => !refsOf(c).includes(id));
    };
    const endpoint = (h: { pt: Vec2; curve: string }) => {
      const existing = hitPoint(h.pt, px() * 2);
      if (existing && existing !== "origin" && d.entities.some((e) => e.id === existing && e.type === "point")) return existing;
      return bl.point({ pos: h.pt, curve: h.curve });
    };
    if (target.kind === "line") {
      const len2 = (target.b[0] - target.a[0]) ** 2 + (target.b[1] - target.a[1]) ** 2 || 1;
      const t = (q: Vec2) => ((q[0] - target.a[0]) * (target.b[0] - target.a[0]) + (q[1] - target.a[1]) * (target.b[1] - target.a[1])) / len2;
      const tc = t(p);
      const inner = hits.map((h) => ({ ...h, t: t(h.pt) })).filter((h) => h.t > 1e-6 && h.t < 1 - 1e-6);
      const before = inner.filter((h) => h.t < tc).sort((a, b) => b.t - a.t)[0];
      const after = inner.filter((h) => h.t > tc).sort((a, b) => a.t - b.t)[0];
      const e = d.entities.find((x) => x.id === target.id);
      if (e?.type !== "line") return;
      if (!before && !after) drop(target.id);
      else if (!before) d.entities = d.entities.map((x) => (x.id === e.id ? { ...e, p1: endpoint(after!) } : x));
      else if (!after) d.entities = d.entities.map((x) => (x.id === e.id ? { ...e, p2: endpoint(before) } : x));
      else {
        const [m1, m2] = [endpoint(before), endpoint(after)];
        d.entities = d.entities.map((x) => (x.id === e.id ? { ...e, p2: m1 } : x));
        bl.entity({ type: "line", p1: m2, p2: e.p2, ...(e.construction ? { construction: true } : {}) }, "l");
      }
      // Length dimensions on a trimmed line no longer describe it.
      d.constraints = d.constraints.filter((c) => !(c.type === "length" && c.line === target.id));
    } else {
      const ang = (q: Vec2) => Math.atan2(q[1] - target.center[1], q[0] - target.center[0]);
      const norm = (a: number, from: number) => ((a - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const start = target.kind === "arc" ? target.a0 : ang(p);
      const span = target.kind === "arc" ? norm(target.a1, target.a0) || 2 * Math.PI : 2 * Math.PI;
      const ac = norm(ang(p), start);
      const inner = hits.map((h) => ({ ...h, a: norm(ang(h.pt), start) })).filter((h) => h.a > 1e-6 && h.a < span - 1e-6);
      const before = inner.filter((h) => h.a < ac).sort((x, y) => y.a - x.a)[0] ?? (target.kind === "circle" ? inner.sort((x, y) => y.a - x.a)[0] : undefined);
      const after = inner.filter((h) => h.a > ac).sort((x, y) => x.a - y.a)[0] ?? (target.kind === "circle" ? inner.sort((x, y) => x.a - y.a)[0] : undefined);
      const e = d.entities.find((x) => x.id === target.id);
      if (!e || (e.type !== "circle" && e.type !== "arc")) return;
      if (target.kind === "circle") {
        if (!before || !after || before === after) drop(target.id);
        // Keep the rest of the circle as an arc from the next intersection around to the previous one.
        else {
          drop(target.id);
          bl.entity({ type: "arc", center: e.center, start: endpoint(after), end: endpoint(before), ...(e.construction ? { construction: true } : {}) }, "a");
        }
      } else if (e.type === "arc") {
        if (!before && !after) drop(target.id);
        else if (!before) d.entities = d.entities.map((x) => (x.id === e.id ? { ...e, start: endpoint(after!) } : x));
        else if (!after) d.entities = d.entities.map((x) => (x.id === e.id ? { ...e, end: endpoint(before) } : x));
        else {
          const [m1, m2] = [endpoint(before), endpoint(after)];
          d.entities = d.entities.map((x) => (x.id === e.id ? { ...e, end: m1 } : x));
          bl.entity({ type: "arc", center: e.center, start: m2, end: e.end, ...(e.construction ? { construction: true } : {}) }, "a");
        }
      }
    }
    // Drop points that no curve uses any more.
    const used = new Set(d.entities.flatMap((x) => (x.type === "line" ? [x.p1, x.p2] : x.type === "circle" ? [x.center] : x.type === "arc" ? [x.center, x.start, x.end] : [])));
    const orphan = sketch.entities.filter((x) => x.type === "point" && !used.has(x.id) && sketch.entities.some((c) => c.type !== "point" && refsOfEntity(c).includes(x.id)));
    for (const o of orphan) drop(o.id);
    commit(d);
  };

  const addPoint = (s: Snap) => {
    if (!sketch) return;
    const bl = builder(sketch);
    if (s.point) return;
    bl.point(s, construction);
    commit(bl.d);
  };

  /** Creates a dimension constraint between selections, with its label at `at`. */
  const addDimension = (a: SketchSel, b: SketchSel | null, at: Vec2) => {
    if (!sketch || !shown) return;
    const label: [number, number] = [round(at[0]), round(at[1])];
    const kindOf = (id: string) => shown.curves.find((c) => c.id === id)?.kind;
    const P = (id: string) => shown.points.get(id)!;
    let c: NewConstraint | null = null;
    if (a.kind === "curve" && !b) {
      const k = kindOf(a.id);
      const curve = shown.curves.find((x) => x.id === a.id)!;
      if (k === "line" && curve.kind === "line") c = { type: "length", line: a.id, value: round(Math.hypot(curve.b[0] - curve.a[0], curve.b[1] - curve.a[1])), label };
      else if (curve.kind === "circle") c = { type: "diameter", curve: a.id, value: round(curve.radius * 2), label };
      else if (curve.kind === "arc") {
        // Placed inside the arc, near its centre: the angle it sweeps; further out: its radius.
        const inside = Math.hypot(at[0] - curve.center[0], at[1] - curve.center[1]) < curve.radius * 0.6;
        c = inside ? { type: "arc_angle", curve: a.id, value: round((sweepOf(curve.a0, curve.a1) * 180) / Math.PI), label } : { type: "radius", curve: a.id, value: round(curve.radius), label };
      }
    } else if (a.kind === "point" && b?.kind === "point") {
      const pa = P(a.id);
      const pb = P(b.id);
      const [minX, maxX] = [Math.min(pa[0], pb[0]), Math.max(pa[0], pb[0])];
      const [minY, maxY] = [Math.min(pa[1], pb[1]), Math.max(pa[1], pb[1])];
      const outX = at[0] < minX || at[0] > maxX;
      const outY = at[1] < minY || at[1] > maxY;
      if (outX && !outY) c = { type: "distance", a: a.id, b: b.id, axis: "y", value: round(Math.abs(pb[1] - pa[1])), label };
      else if (outY && !outX) c = { type: "distance", a: a.id, b: b.id, axis: "x", value: round(Math.abs(pb[0] - pa[0])), label };
      else c = { type: "distance", a: a.id, b: b.id, value: round(Math.hypot(pb[0] - pa[0], pb[1] - pa[1])), label };
    } else if (b && ((a.kind === "point" && b.kind === "curve") || (a.kind === "curve" && b.kind === "point"))) {
      const [pt, cv] = a.kind === "point" ? [a.id, b.id] : [b.id, a.id];
      const curve = shown.curves.find((x) => x.id === cv);
      if (curve?.kind === "line") c = { type: "distance", a: pt, b: cv, value: round(curveDistance(curve, P(pt), true)), label };
    } else if (a.kind === "curve" && b?.kind === "curve") {
      const ca = shown.curves.find((x) => x.id === a.id);
      const cb = shown.curves.find((x) => x.id === b.id);
      if (ca?.kind === "line" && cb?.kind === "line") {
        const d1: Vec2 = [ca.b[0] - ca.a[0], ca.b[1] - ca.a[1]];
        const d2: Vec2 = [cb.b[0] - cb.a[0], cb.b[1] - cb.a[1]];
        const cross = d1[0] * d2[1] - d1[1] * d2[0];
        const dotp = d1[0] * d2[0] + d1[1] * d2[1];
        const ang = (Math.abs(Math.atan2(cross, dotp)) * 180) / Math.PI;
        if (Math.abs(cross) / (Math.hypot(...d1) * Math.hypot(...d2)) < 1e-3) c = { type: "distance", a: `${b.id}.p1`, b: a.id, value: round(curveDistance(ca, cb.a, true)), label };
        else c = { type: "angle", a: a.id, b: b.id, value: round(Math.min(ang, 180 - ang) === ang ? ang : ang), label };
      }
    }
    if (!c) return toast("Dimension: pick a line, circle, arc, two points, a point and a line, or two lines", "error");
    const bl = builder(sketch);
    const id = bl.constraint(c);
    if (commit(bl.d)) setEditing(id);
  };

  /** Draws a line from the pending point to `s` and continues the chain (or closes it on its first point). */
  const lineTo = (s: Snap, length?: Expr) => {
    const start = ts.points[0];
    if (!start) return;
    const made = addLine(start, s, length);
    if (!made) return;
    const chainStart = ts.points[1] ?? { pos: start.pos, point: made[0] };
    ts.points = s.point && s.point === chainStart.point ? [] : [{ pos: s.pos, point: made[1] }, chainStart];
    if (!ts.points.length) setTip(null);
  };

  // ---------------------------------------------------------------- typed values while drawing
  const [entry, setEntry] = useState<{ fields: string[]; active: number } | null>(null);
  // On a phone the constraint list is a sheet opened from the tool bar.
  const phoneConstraints = usePhoneSheets((s) => s.constraints);
  useEffect(() => () => usePhoneSheets.setState({ constraints: false }), []);
  /** The shape just drawn: its size and angle show as chips that can be tapped to fix them. */
  const [lastShape, setLastShape] = useState<{ kind: "line" | "arc" | "circle"; id: string } | null>(null);
  const [typingQuick, setTypingQuick] = useState<string | null>(null);
  const entryInputs = useRef<(HTMLInputElement | null)[]>([]);
  const cursorScreen = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    if (entry) entryInputs.current[entry.active]?.focus();
  }, [entry?.active, !!entry]);
  const scope = () => new Map(Object.entries(params ?? {}));
  /** Typed lengths are in the design's unit; angles in degrees. */
  const entryExpr = (text: string, angle = false): Expr => (angle ? parseExpr(text) : lengthExpr(text));
  const valueOf = (text: string | undefined, angle = false): number | null => {
    if (!text?.trim()) return null;
    try {
      const v = evaluate(entryExpr(text, angle), scope());
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  /** Where the typed values put the shape's free end or corner; null while nothing usable is typed. */
  const entryTarget = (): Vec2 | null => {
    if (!entry || !ts.points.length) return null;
    const a = ts.points[0]!.pos;
    const cur = ts.cursor && Math.hypot(ts.cursor[0] - a[0], ts.cursor[1] - a[1]) > 1e-9 ? ts.cursor : ([a[0] + 1, a[1]] as Vec2);
    const toward = Math.atan2(cur[1] - a[1], cur[0] - a[0]);
    const [f0, f1] = [valueOf(entry.fields[0], isAngleField(ui.tool, 0)), valueOf(entry.fields[1], isAngleField(ui.tool, 1))];
    switch (ui.tool) {
      case "line": {
        if (f0 === null || f0 <= 0) return null;
        const ang = entry.fields[1]?.trim() ? (f1 === null ? null : (f1 * Math.PI) / 180) : toward;
        return ang === null ? null : [a[0] + f0 * Math.cos(ang), a[1] + f0 * Math.sin(ang)];
      }
      case "rect":
      case "rect_center": {
        if ((f0 === null || f0 <= 0) && (f1 === null || f1 <= 0)) return null;
        const k = ui.tool === "rect_center" ? 0.5 : 1;
        const sx = Math.sign(cur[0] - a[0]) || 1;
        const sy = Math.sign(cur[1] - a[1]) || 1;
        return [f0 && f0 > 0 ? a[0] + sx * f0 * k : cur[0], f1 && f1 > 0 ? a[1] + sy * f1 * k : cur[1]];
      }
      case "circle":
        return f0 === null || f0 <= 0 ? null : [a[0] + (f0 / 2) * Math.cos(toward), a[1] + (f0 / 2) * Math.sin(toward)];
      case "arc": {
        // Two ends placed: radius and/or angle give the arc's middle, on the cursor's side.
        const b = ts.points[1]?.pos;
        if (!b || (f0 === null && f1 === null)) return null;
        return arcMidFor(a, b, ts.cursor ?? b, f0 !== null && f0 > 0 ? f0 : null, f1);
      }
      case "arc_center": {
        const st = ts.points[1]?.pos;
        if (!st || f0 === null || f0 <= 0 || f0 >= 360) return null;
        const r = Math.hypot(st[0] - a[0], st[1] - a[1]);
        const end = Math.atan2(st[1] - a[1], st[0] - a[0]) + (ts.sweep >= 0 ? 1 : -1) * ((f0 * Math.PI) / 180);
        return [a[0] + r * Math.cos(end), a[1] + r * Math.sin(end)];
      }
      default:
        return null;
    }
  };
  const finishEntry = () => {
    const target = entryTarget();
    if (!entry || !target || !ts.points.length) return setEntry(null);
    const expr = (i: number) => (entry.fields[i]?.trim() ? entryExpr(entry.fields[i]!, isAngleField(ui.tool, i)) : undefined);
    const s: Snap = { pos: target };
    if (ui.tool === "line") lineTo(s, expr(0));
    else if (ui.tool === "rect" || ui.tool === "rect_center") {
      addRect(ts.points[0]!, s, ui.tool === "rect_center", { w: expr(0), h: expr(1) });
      ts.points = [];
    } else if (ui.tool === "circle") {
      const c = ts.points[0]!;
      addCircle(c, Math.hypot(target[0] - c.pos[0], target[1] - c.pos[1]), expr(0));
      ts.points = [];
    } else if (ui.tool === "arc") {
      add3PointArc(ts.points[0]!, ts.points[1]!, target, { radius: expr(0), angle: expr(1) });
      ts.points = [];
    } else if (ui.tool === "arc_center") {
      addArc(ts.points[0]!, ts.points[1]!, s, ts.sweep >= 0, expr(0));
      ts.points = [];
    }
    setEntry(null);
    setTip(null);
    rerender();
  };

  // ---------------------------------------------------------------- pointer handling
  const gesture = useRef<{
    down: { x: number; y: number; p: Vec2; target: SketchSel | null; moved: boolean; started: boolean } | null;
    dragState: { ids: string[]; start: Vec2; origin: Map<string, Vec2>; solved: SolvedSketch | null } | null;
    box: { a: Vec2; b: Vec2 } | null;
  }>({ down: null, dragState: null, box: null });
  const pressRef = useRef(new Press(() => {}));
  // Moves are handled once per frame by whichever onMove the latest render installed.
  const moveRef = useRef<(e: PointerEvent) => void>(() => {});
  const moveFrame = useRef(perFrame((e: PointerEvent) => moveRef.current(e))).current;
  useEffect(() => {
    const el = viewport.canvas;
    // Gesture state lives in a ref: this effect re-subscribes on every render, which may happen mid-drag.
    const g = gesture.current;
    // Fingers navigate here. Before any pen was used, a still tap stands in for a click.
    const press = pressRef.current;

    const targetAt = (p: Vec2): SketchSel | null => {
      const pt = hitPoint(p, px() * 9);
      if (pt && pt !== "origin") return { kind: "point", id: pt };
      const c = hitCurve(p, px() * 7);
      if (c) return { kind: "curve", id: c.id };
      if (pt) return { kind: "point", id: pt };
      return null;
    };

    // Without a Pencil (iPhone, or an iPad used by finger) one finger draws and drags like the pen;
    // two fingers pan and zoom. Once a Pencil has been used, fingers only navigate.
    const fingerDraws = () => !viewport.penSeen;
    const touches = new Set<number>();
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") press.move(e);
      if (e.pointerType !== "touch" || (fingerDraws() && touches.size === 1)) moveFrame(e);
    };
    moveRef.current = (e: PointerEvent) => {
      const p = toSketch(e);
      if (!p || !shown) return;
      const tool = useSketchUi.getState().tool;
      const r = el.getBoundingClientRect();
      cursorScreen.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (g.down && e.buttons === 1 && tool === "select") {
        if (!g.down.moved && Math.hypot(e.clientX - g.down.x, e.clientY - g.down.y) < 4) return;
        g.down.moved = true;
        if (g.down.target && !g.dragState && solver && sketch) {
          // Start dragging the target's points.
          const ids = g.down.target.kind === "point" ? [g.down.target.id] : curvePointIds(sketch, g.down.target.id);
          const movable = ids.filter((id) => sketch.entities.some((x) => x.id === id && x.type === "point"));
          if (!movable.length) return;
          g.dragState = { ids: movable, start: g.down.p, origin: new Map(movable.map((id) => [id, shown.points.get(id)!])), solved: null };
        }
        if (g.dragState && solver && sketch) {
          const dx = p[0] - g.dragState.start[0];
          const dy = p[1] - g.dragState.start[1];
          const targets: Record<string, Vec2> = {};
          for (const id of g.dragState.ids) {
            const o = g.dragState.origin.get(id)!;
            targets[id] = [o[0] + dx, o[1] + dy];
          }
          // A single dragged point snaps like a newly drawn one.
          if (g.dragState.ids.length === 1) {
            const id = g.dragState.ids[0]!;
            const exclude = new Set([id, ...sketch.entities.filter((x) => x.type !== "point" && refsOfEntity(x).includes(id)).map((x) => x.id)]);
            const sn = snap(targets[id]!, exclude, undefined, e.altKey);
            targets[id] = sn.pos;
            ts.snap = sn;
            ts.cursor = sn.pos;
          }
          const radiusDrag = g.down.target?.kind === "curve" && sketch.entities.find((x) => x.id === g.down!.target!.id)?.type === "circle" && e.altKey;
          const s = solver.solve(
            { entities: sketch.entities, constraints: resolvedConstraints.list, external },
            radiusDrag ? { dragRadius: { curve: g.down.target!.id, radius: Math.hypot(p[0] - shown.points.get(curvePointIds(sketch, g.down.target!.id)[0]!)![0], p[1] - shown.points.get(curvePointIds(sketch, g.down.target!.id)[0]!)![1]) } } : { drag: targets },
          );
          g.dragState.solved = s;
          setDrag(s);
          return;
        }
        if (!g.down.target) {
          g.box = { a: g.down.p, b: p };
          ts.cursor = p;
          ts.points = [{ pos: g.box.a }, { pos: g.box.b }];
          rerender();
        }
        return;
      }
      if (e.buttons && !g.down?.started) return;
      // Hover + tool previews
      if (tool === "select" || tool === "dimension" || tool === "trim") setHover(targetAt(p));
      else setHover(null);
      if (tool === "project") return;
      const s: Snap = tool === "select" || tool === "dimension" || tool === "trim" ? { pos: p } : snap(p, undefined, tool === "line" ? ts.points[0]?.pos : undefined, e.altKey);
      ts.cursor = s.pos;
      // Tools that place points show where the next one will land.
      ts.snap = POINT_TOOLS.has(tool) ? s : null;
      if (tool === "line" && ts.points.length) {
        const a = ts.points[0]!.pos;
        const len = Math.hypot(s.pos[0] - a[0], s.pos[1] - a[1]);
        const ang = (Math.atan2(s.pos[1] - a[1], s.pos[0] - a[0]) * 180) / Math.PI;
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `${fmtLen(len)}  ${fmt(((ang % 360) + 360) % 360)}°` });
      } else if (tool === "arc" && ts.points.length === 2) {
        const g = arcThrough(ts.points[0]!.pos, ts.points[1]!.pos, s.pos);
        setTip(g ? { x: e.clientX - r.left, y: e.clientY - r.top, text: `R ${fmtLen(g.radius)}  ∠ ${fmt((g.sweep * 180) / Math.PI)}°` } : null);
      } else if (tool === "arc" && ts.points.length === 1) {
        const a = ts.points[0]!.pos;
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: fmtLen(Math.hypot(s.pos[0] - a[0], s.pos[1] - a[1])) });
      } else if ((tool === "circle" || tool === "arc_center") && ts.points.length) {
        const c = ts.points[0]!.pos;
        if (tool === "arc_center" && ts.points.length === 2) {
          const s0 = ts.points[1]!.pos;
          const a0 = Math.atan2(s0[1] - c[1], s0[0] - c[0]);
          const a1 = Math.atan2(s.pos[1] - c[1], s.pos[0] - c[0]);
          let d = a1 - a0;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          const prev = ts.sweep;
          // Unwrap so arcs larger than 180° keep their direction.
          let next = prev + (((d - normalizeAngle(prev) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
          if (Math.abs(next) > 2 * Math.PI) next = prev;
          ts.sweep = next;
        }
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `R ${fmtLen(Math.hypot(s.pos[0] - c[0], s.pos[1] - c[1]))}` });
      } else if (tool === "polygon" && ts.points.length) {
        const c = ts.points[0]!.pos;
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `hexagon R ${fmtLen(Math.hypot(s.pos[0] - c[0], s.pos[1] - c[1]))}` });
      } else if ((tool === "rect" || tool === "rect_center") && ts.points.length) {
        const a = ts.points[0]!.pos;
        const k = tool === "rect_center" ? 2 : 1;
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `${inUnit(Math.abs(s.pos[0] - a[0]) * k)} × ${fmtLen(Math.abs(s.pos[1] - a[1]) * k)}` });
      } else setTip(s.kind && s.kind !== "grid" ? { x: e.clientX - r.left, y: e.clientY - r.top, text: SNAP_LABEL[s.kind] } : null);
      rerender();
    };

    const onDown = (e: PointerEvent) => {
      moveFrame.flush();
      if (e.pointerType !== "mouse") press.down(e);
      if (e.pointerType === "touch") {
        touches.add(e.pointerId);
        if (!fingerDraws()) return;
        // A second finger means navigating: drop what the first one started.
        if (touches.size > 1) return dropGesture();
      }
      start(e);
    };
    const dropGesture = () => {
      g.down = null;
      g.box = null;
      if (g.dragState) {
        g.dragState = null;
        setDrag(null);
      }
      ts.snap = null;
      rerender();
    };

    const start = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const p = toSketch(e);
      if (!p) return;
      const tool = useSketchUi.getState().tool;
      // Drawing tools start on press, so a shape can be dragged out as well as clicked twice.
      const started = DRAG_TOOLS.has(tool) && !ts.points.length;
      if (started) {
        ts.points = [snap(p, undefined, undefined, e.altKey)];
        setEntry(null);
      }
      g.down = { x: e.clientX, y: e.clientY, p, target: targetAt(p), moved: false, started };
      // A finger tap is replayed after it lifted, when its pointer can no longer be captured.
      if ((tool === "select" || started) && (e.pointerType !== "touch" || fingerDraws())) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // the pointer is already gone (a tap replayed after it lifted)
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch") moveFrame.flush();
      const r = e.pointerType === "mouse" ? null : press.up(e);
      if (e.pointerType === "touch") touches.delete(e.pointerId);
      if (e.pointerType !== "touch" || fingerDraws()) {
        finish(e);
        if (r === "double") onDbl(e);
      }
    };

    const finish = (e: PointerEvent) => {
      if (e.button !== 0 || !g.down) return;
      const d = g.down;
      g.down = null;
      const p = toSketch(e);
      if (!p || !sketch) return;
      const tool = useSketchUi.getState().tool;
      if (g.dragState) {
        const s = g.dragState.solved;
        g.dragState = null;
        ts.snap = null;
        setDrag(null);
        if (s?.diagnostics.ok) commit({ entities: applySolution(sketch.entities, s), constraints: sketch.constraints });
        return;
      }
      if (g.box) {
        const [x0, x1] = [Math.min(g.box.a[0], g.box.b[0]), Math.max(g.box.a[0], g.box.b[0])];
        const [y0, y1] = [Math.min(g.box.a[1], g.box.b[1]), Math.max(g.box.a[1], g.box.b[1])];
        const inside = (q: Vec2) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
        const sel: SketchSel[] = [];
        for (const [id, q] of pointEntries(sketch, shown!)) if (id !== "origin" && inside(q)) sel.push({ kind: "point", id });
        for (const c of shown!.curves) if (curveSamples(c).every(inside)) sel.push({ kind: "curve", id: c.id });
        g.box = null;
        ts.points = [];
        setSketchSelection(e.shiftKey ? [...useSketchUi.getState().selection, ...sel] : sel);
        return;
      }
      if (d.moved && tool === "select") return;
      const dragged = d.started && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6;
      // A plain click on a drawing tool only placed the first point (on press).
      if (d.started && !dragged) return rerender();
      const s = snap(p, undefined, tool === "line" ? ts.points[0]?.pos : undefined, e.altKey);
      switch (tool) {
        case "select": {
          const t = d.target;
          const cur = useSketchUi.getState().selection;
          if (!t) return setSketchSelection([]);
          if (e.shiftKey || e.metaKey || e.ctrlKey) setSketchSelection(cur.some((x) => sameSel(x, t)) ? cur.filter((x) => !sameSel(x, t)) : [...cur, t]);
          else setSketchSelection([t]);
          return;
        }
        case "line": {
          if (!ts.points.length) {
            ts.points = [s];
            return rerender();
          }
          lineTo(s);
          // A dragged line stands alone; clicked lines keep chaining.
          if (dragged) {
            ts.points = [];
            setTip(null);
          }
          return rerender();
        }
        case "rect":
        case "rect_center":
          if (!ts.points.length) ts.points = [s];
          else {
            addRect(ts.points[0]!, s, tool === "rect_center");
            ts.points = [];
            setTip(null);
          }
          return rerender();
        case "circle":
          if (!ts.points.length) ts.points = [s];
          else {
            const c = ts.points[0]!;
            addCircle(c, Math.hypot(s.pos[0] - c.pos[0], s.pos[1] - c.pos[1]));
            ts.points = [];
            setTip(null);
          }
          return rerender();
        case "arc_center":
          if (ts.points.length < 2) {
            ts.points = [...ts.points, s];
            ts.sweep = 0;
          } else {
            addArc(ts.points[0]!, ts.points[1]!, s, ts.sweep >= 0);
            ts.points = [];
            setTip(null);
          }
          return rerender();
        case "arc":
          // Start, end (clicked or dragged out), then a third click sets how far it bulges.
          if (ts.points.length < 2) {
            const last = ts.points[ts.points.length - 1];
            if (!last || Math.hypot(s.pos[0] - last.pos[0], s.pos[1] - last.pos[1]) > px() * 2) ts.points = [...ts.points, s];
          } else {
            add3PointArc(ts.points[0]!, ts.points[1]!, s.pos);
            ts.points = [];
            setTip(null);
          }
          return rerender();
        case "point":
          return addPoint(s);
        case "polygon":
          if (!ts.points.length) ts.points = [s];
          else {
            addPolygon(ts.points[0]!, s.pos);
            ts.points = [];
            setTip(null);
          }
          return rerender();
        case "trim":
          return trimAt(p);
        case "dimension": {
          const t = targetAt(p);
          if (!ts.dimFirst) {
            if (!t) return;
            ts.dimFirst = t;
            setSketchSelection([t]);
            // A single line/circle/arc gets its dimension placed on the next click.
            return rerender();
          }
          if (t && !(t.kind === ts.dimFirst.kind && t.id === ts.dimFirst.id) && !ts.points.length) {
            ts.points = [{ pos: p, point: `${t.kind}:${t.id}` }];
            setSketchSelection([ts.dimFirst, t]);
            return rerender();
          }
          const second = ts.points[0]?.point ? parseSel(ts.points[0].point) : null;
          addDimension(ts.dimFirst, second, p);
          ts.dimFirst = null;
          ts.points = [];
          setSketchSelection([]);
          return rerender();
        }
        case "project": {
          const pick = viewport.pick(e.clientX, e.clientY, new Set(["edge"]));
          const sel = pick ? edgeSelectorForPick(pick, useApp.getState().output?.meshes ?? []) : null;
          if (!sel) return toast("Click a model edge to project it into the sketch", "error");
          const bl = builder(sketch);
          bl.entity({ type: "projection", edges: [sel] }, "pr");
          writeSketch(bl.d);
          return;
        }
      }
    };

    const onDbl = (e: MouseEvent) => {
      const tool = useSketchUi.getState().tool;
      if (tool === "line") {
        ts.points = [];
        setTip(null);
        rerender();
      }
      const p = toSketch(e);
      if (tool === "select" && p) {
        const t = targetAt(p);
        if (t?.kind === "curve" && sketch) {
          // Select the whole connected chain.
          setSketchSelection(connectedCurves(sketch, t.id).map((id) => ({ kind: "curve", id })));
        }
      }
    };
    const onCancel = (e: PointerEvent) => {
      press.up(e);
      touches.delete(e.pointerId);
    };
    const onLeave = () => {
      moveFrame.cancel();
      setTip(null);
      setHover(null);
      ts.snap = null;
      rerender();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("dblclick", onDbl);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("dblclick", onDbl);
      el.removeEventListener("pointerleave", onLeave);
    };
  });

  // Crosshair while drawing, so the dot (not the arrow tip) is what you aim with.
  useEffect(() => {
    viewport.canvas.style.cursor = POINT_TOOLS.has(ui.tool) ? "crosshair" : "";
    return () => {
      viewport.canvas.style.cursor = "";
    };
  }, [viewport, ui.tool]);

  // Reset in-progress tool state when switching tools.
  useEffect(() => {
    ts.points = [];
    ts.dimFirst = null;
    setTip(null);
    setEntry(null);
    setLastShape(null);
    rerender();
  }, [ui.tool]);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) {
        if (k === "a") {
          e.preventDefault();
          selectAll();
        }
        return;
      }
      // Typing a number while drawing opens exact-value fields at the cursor.
      const fields = ENTRY_FIELDS[useSketchUi.getState().tool];
      const needed = ENTRY_AFTER_TWO.has(useSketchUi.getState().tool) ? 2 : 1;
      if (fields && ts.points.length >= needed && !e.altKey && (/^[0-9.]$/.test(e.key) || e.key === "Tab")) {
        e.preventDefault();
        // Keys typed quickly can arrive before the fields have focus: they go on into the open fields.
        setEntry((cur) => {
          if (!cur) return { fields: fields.map((_, i) => (i === 0 && e.key !== "Tab" ? e.key : "")), active: 0 };
          if (e.key === "Tab") return { ...cur, active: (cur.active + (e.shiftKey ? fields.length - 1 : 1)) % fields.length };
          return { ...cur, fields: cur.fields.map((f, i) => (i === cur.active ? f + e.key : f)) };
        });
        return;
      }
      // Tools follow the active shortcut preset; constraints use Shift + letter.
      const action = actionFor(e, SKETCH_ACTIONS);
      if (action === "sketch.construction") return toggleConstruction();
      if (action) return setTool(action.slice(7) as SketchTool);
      const cmap: Record<string, string> = { a: "parallel", c: "concentric", e: "equal", v: "hv", n: "coincident", l: "fix", m: "midpoint", p: "perpendicular", s: "symmetric", t: "tangent" };
      if (e.shiftKey && cmap[k]) return applyConstraint(cmap[k]!);
      if (e.key === "Escape") {
        if (ts.points.length || ts.dimFirst) {
          ts.points = [];
          ts.dimFirst = null;
          setEntry(null);
          setTip(null);
          return rerender();
        }
        if (useSketchUi.getState().tool !== "select") return setTool("select");
        if (useSketchUi.getState().selection.length) return setSketchSelection([]);
        return closeSketch();
      }
      if (e.key === "Enter") return closeSketch();
      if (e.key === "Delete" || e.key === "Backspace") return deleteSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------- HTML labels
  const labels = useMemo(() => (sketch && shown ? constraintLabels(sketch, shown) : []), [sketch, shown]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!frame || !layer.current) return;
      const m = frameMatrix(frame);
      for (const el of layer.current.querySelectorAll<HTMLElement>("[data-x]")) {
        const v = new THREE.Vector3(Number(el.dataset["x"]), Number(el.dataset["y"]), 0).applyMatrix4(m);
        const s = viewport.worldToScreen([v.x, v.y, v.z]);
        if (!s) {
          el.style.display = "none";
          continue;
        }
        el.style.display = "";
        el.style.left = `${s[0]}px`;
        el.style.top = `${s[1]}px`;
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [frame, viewport]);

  // Chips with the new shape's size and angle; tapping one fixes that value as a dimension.
  const quick: { key: string; at: Vec2; text: string; value: number; length: boolean; make: (v: Expr) => NewConstraint }[] = [];
  const lastCurve = lastShape && shown?.curves.find((c) => c.id === lastShape.id);
  if (sketch && lastCurve) {
    const has = (t: string[]) => sketch.constraints.some((c) => t.includes(c.type) && ("line" in c ? c.line : "curve" in c ? c.curve : "a" in c ? c.a : "") === lastCurve.id);
    const id = lastCurve.id;
    if (lastCurve.kind === "line") {
      const [a, b] = [lastCurve.a, lastCurve.b];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const deg = ((((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 180) + 180) % 180;
      if (!has(["length"])) quick.push({ key: "len", at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], text: fmtLen(len), value: len, length: true, make: (v) => ({ type: "length", line: id, value: v }) });
      if (!has(["horizontal", "vertical", "angle"])) quick.push({ key: "ang", at: a, text: `∠ ${fmt(deg)}°`, value: +deg.toFixed(2), length: false, make: (v) => ({ type: "angle", a: id, b: "origin.x", value: v }) });
    } else if (lastCurve.kind === "circle") {
      if (!has(["radius", "diameter"])) quick.push({ key: "dia", at: [lastCurve.center[0], lastCurve.center[1] + lastCurve.radius], text: `⌀ ${fmtLen(lastCurve.radius * 2)}`, value: lastCurve.radius * 2, length: true, make: (v) => ({ type: "diameter", curve: id, value: v }) });
    } else {
      const mid = lastCurve.a0 + sweepOf(lastCurve.a0, lastCurve.a1) / 2;
      const sw = (sweepOf(lastCurve.a0, lastCurve.a1) * 180) / Math.PI;
      if (!has(["radius", "diameter"])) quick.push({ key: "rad", at: [lastCurve.center[0] + lastCurve.radius * Math.cos(mid), lastCurve.center[1] + lastCurve.radius * Math.sin(mid)], text: `R ${fmtLen(lastCurve.radius)}`, value: lastCurve.radius, length: true, make: (v) => ({ type: "radius", curve: id, value: v }) });
      if (!has(["arc_angle"])) quick.push({ key: "sweep", at: lastCurve.center, text: `∠ ${fmt(sw)}°`, value: +sw.toFixed(2), length: false, make: (v) => ({ type: "arc_angle", curve: id, value: v }) });
    }
  }
  const addQuickDim = (make: (v: Expr) => NewConstraint, v: Expr) => {
    if (!sketch) return;
    const bl = builder(sketch);
    bl.constraint(make(v));
    commit(bl.d);
  };

  if (!sketch) return null;
  const diag = shown?.diagnostics;
  const conflicting = new Set([...(diag?.conflicting ?? []), ...resolvedConstraints.bad]);

  return (
    <>
      <div className="overlay-layer" ref={layer}>
        {quick.map((q) => (
          <div key={`${lastShape?.id}.${q.key}`} className={`value-chip quick-dim ${q.key}`} data-x={q.at[0]} data-y={q.at[1]} onPointerDown={(e) => e.stopPropagation()}>
            {typingQuick === q.key ? (
              <InlineInput
                value={q.value}
                length={q.length}
                onDone={(v) => {
                  setTypingQuick(null);
                  if (v !== null) addQuickDim(q.make, v);
                }}
              />
            ) : (
              <button onClick={() => setTypingQuick(q.key)} title="Tap to set this value exactly">
                {q.text}
              </button>
            )}
          </div>
        ))}
        {labels.map((l) =>
          l.id === editing ? (
            <div key={l.id} className="sketch-label sel" data-x={l.at[0]} data-y={l.at[1]}>
              <ValueInput
                value={(sketch.constraints.find((c) => c.id === l.id) as { value: Expr }).value}
                unit={["angle", "arc_angle"].includes(sketch.constraints.find((c) => c.id === l.id)?.type ?? "") ? "deg" : "mm"}
                suggest={sketch.constraints.find((c) => c.id === l.id)?.type ?? "dimension"}
                onDone={(v) => {
                  setEditing(null);
                  if (v === null) return;
                  const constraints = sketch.constraints.map((c) => (c.id === l.id ? ({ ...c, value: v } as SketchConstraint) : c));
                  commit({ entities: sketch.entities, constraints }, true);
                }}
              />
            </div>
          ) : (
            <div
              key={l.id}
              data-x={l.at[0]}
              data-y={l.at[1]}
              className={`${l.dimension ? "sketch-label" : "glyph"} ${ui.selection.some((s) => s.kind === "constraint" && s.id === l.id) ? "sel" : ""} ${conflicting.has(l.id) ? "conflict" : ""}`}
              title={l.title}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                const t: SketchSel = { kind: "constraint", id: l.id };
                const cur = useSketchUi.getState().selection;
                setSketchSelection(e.shiftKey ? [...cur, t] : [t]);
              }}
              onDoubleClick={() => l.dimension && setEditing(l.id)}
            >
              {l.text}
            </div>
          ),
        )}
        {tip && !entry ? (
          <div className="cursor-tip" style={{ left: tip.x, top: tip.y }}>
            {tip.text}
          </div>
        ) : null}
        {entry && ENTRY_FIELDS[ui.tool] ? (
          <div className="draw-entry" style={{ left: cursorScreen.current.x, top: cursorScreen.current.y }} onPointerDown={(e) => e.stopPropagation()}>
            {ENTRY_FIELDS[ui.tool]!.map((label, i) => (
              <label key={label} className={valueOf(entry.fields[i], isAngleField(ui.tool, i)) === null && entry.fields[i]?.trim() ? "bad" : ""}>
                <span>{label}</span>
                <input
                  ref={(el) => {
                    entryInputs.current[i] = el;
                  }}
                  value={entry.fields[i] ?? ""}
                  placeholder={i === 0 ? "" : "auto"}
                  onFocus={(e) => entry.active !== i && setEntry({ ...entry, active: i })}
                  onChange={(e) => setEntry({ ...entry, fields: entry.fields.map((f, j) => (j === i ? e.target.value : f)) })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") finishEntry();
                    else if (e.key === "Escape") setEntry(null);
                    else if (e.key === "Tab") {
                      e.preventDefault();
                      const n = ENTRY_FIELDS[ui.tool]!.length;
                      setEntry({ ...entry, active: (i + (e.shiftKey ? n - 1 : 1)) % n });
                    }
                  }}
                />
                {label === "Angle °" ? null : <em>{docUnit()}</em>}
              </label>
            ))}
            <small>Enter to place · Tab next · Esc back to the mouse</small>
          </div>
        ) : null}
      </div>
      <div className={`constraint-palette ${phoneConstraints ? "open" : ""}`}>
        <div className="palette-title">Constraints</div>
        {CONSTRAINT_TOOLS.map((c) => (
          <button key={c.type} onClick={() => applyConstraint(c.type)} title={`${c.label} — ${c.hint}`}>
            <c.icon />
            <span>{c.label}</span>
            {c.key ? <Kbd k={c.key} /> : null}
          </button>
        ))}
      </div>
      <div className="sketch-hud">
        <div className="card2">
          <div className="row" style={{ gap: 10 }}>
            <b>{featureName(sketch)}</b>
            <span className={`dof ${diag && !diag.ok ? "bad" : diag?.dof === 0 ? "full" : ""}`}>
              <i />
              {!diag ? "Solving…" : !diag.ok ? "Over-constrained" : diag.dof === 0 ? "Fully defined" : `${diag.dof} DOF left`}
            </span>
            {/* Phone: finishing sits up here, where iOS puts "Done", not at the end of the scrolling bar. */}
            <button className="btn primary phone-only sketch-done" onClick={closeSketch}>
              Done
            </button>
          </div>
          {diag?.message ? <div className="muted" style={{ marginTop: 4, color: "var(--err)" }}>{diag.message}</div> : null}
          <div className="muted" style={{ marginTop: 4, maxWidth: 280 }}>{toolHint(ui.tool, ts.points.length, !!ts.dimFirst)}</div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- helpers

/** Tools whose clicks place points (they show a dot where the next point lands). */
const POINT_TOOLS = new Set<SketchTool>(["line", "rect", "rect_center", "circle", "arc", "arc_center", "polygon", "point"]);
/** Tools that draw on press-drag-release as well as on two clicks. */
const DRAG_TOOLS = new Set<SketchTool>(["line", "rect", "rect_center", "circle", "arc", "polygon"]);
/** Values that can be typed while drawing (start typing a number, Tab moves to the next field). */
const ENTRY_FIELDS: Partial<Record<SketchTool, string[]>> = { line: ["Length", "Angle °"], rect: ["Width", "Height"], rect_center: ["Width", "Height"], circle: ["Diameter"], arc: ["Radius", "Angle °"], arc_center: ["Angle °"] };
/** Counter-clockwise sweep from a0 to a1, in (0, 2π]. */
const sweepOf = (a0: number, a1: number) => (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
/** Tools whose typed values only apply once two points are placed (an arc's ends, or centre and start). */
const ENTRY_AFTER_TWO = new Set<SketchTool>(["arc", "arc_center"]);
const isAngleField = (tool: SketchTool, i: number) => ENTRY_FIELDS[tool]?.[i] === "Angle °";

/** The circle through an arc's two ends and a third point on it; start→end runs counter-clockwise through `m`. */
function arcThrough(a: Vec2, b: Vec2, m: Vec2): { center: Vec2; radius: number; start: Vec2; end: Vec2; sweep: number; swapped: boolean } | null {
  const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 2)) return null;
  const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
  const center: Vec2 = [(sq(a) * (b[1] - m[1]) + sq(b) * (m[1] - a[1]) + sq(m) * (a[1] - b[1])) / d, (sq(a) * (m[0] - b[0]) + sq(b) * (a[0] - m[0]) + sq(m) * (b[0] - a[0])) / d];
  const ang = (p: Vec2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const ccw = (from: number, to: number) => (((to - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // m between a and b going counter-clockwise: the arc runs a→b, otherwise b→a.
  const swapped = ccw(ang(a), ang(m)) > ccw(ang(a), ang(b));
  const [start, end] = swapped ? [b, a] : [a, b];
  return { center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]), start, end, sweep: ccw(ang(start), ang(end)), swapped };
}

/** The point on the arc's middle for a chord a→b, a radius and/or sweep angle (degrees), bulging to `side`'s side. */
function arcMidFor(a: Vec2, b: Vec2, side: Vec2, radius: number | null, angleDeg: number | null): Vec2 | null {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1e-9) return null;
  let theta = angleDeg !== null ? (angleDeg * Math.PI) / 180 : null;
  let r = radius;
  if (theta !== null && (theta <= 0 || theta >= 2 * Math.PI)) return null;
  if (r === null && theta !== null) r = L / (2 * Math.sin(theta / 2));
  if (r === null || r < L / 2 - 1e-9) return null;
  theta ??= 2 * Math.asin(Math.min(1, L / (2 * r)));
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let n: Vec2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  if ((side[0] - mid[0]) * n[0] + (side[1] - mid[1]) * n[1] < 0) n = [-n[0], -n[1]];
  // Sagitta: how far the arc's middle stands off the chord (more than r for a major arc).
  const h = r - r * Math.cos(theta / 2);
  return [mid[0] + n[0] * h, mid[1] + n[1] * h];
}

const SNAP_LABEL: Record<NonNullable<Snap["kind"]>, string> = { point: "Endpoint", mid: "Midpoint", cross: "Intersection", curve: "On curve", align: "Aligned", grid: "", center: "Center", edge: "On edge" };

const round = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2)).replace(/\.?0+$/, "");
const normalizeAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function parseSel(s: string): SketchSel {
  const [kind, ...id] = s.split(":");
  return { kind: kind as "point" | "curve", id: id.join(":") };
}

function toolHint(tool: SketchTool, n: number, dimFirst: boolean): string {
  switch (tool) {
    case "line":
      return n ? "Click to continue · type a number for an exact length · double-click or Esc ends · click the start point to close" : "Click to start a line, or drag one out. Hold Alt (⌥) to place freely.";
    case "rect":
      return n ? "Click the opposite corner, or type the width (Tab for the height)" : "Click the first corner, or drag the rectangle out";
    case "rect_center":
      return n ? "Click a corner, or type the width (Tab for the height)" : "Click the center, or drag from the center out";
    case "circle":
      return n ? "Click to set the size, or type the diameter" : "Click the center, or drag the circle out";
    case "arc":
      return n === 0 ? "Click where the arc starts, or drag to its end" : n === 1 ? "Click where the arc ends" : "Move to bend the arc and click · type the radius (Tab for the angle)";
    case "arc_center":
      return n === 0 ? "Click the arc center" : n === 1 ? "Click the start point" : "Click the end point (move clockwise to flip) · type the angle";
    case "point":
      return "Click to place a point";
    case "polygon":
      return n ? "Click a corner (hexagon; constraints keep it regular)" : "Click the center";
    case "trim":
      return "Click the piece of a curve to cut away up to its nearest intersections";
    case "dimension":
      return dimFirst ? "Click a second entity, or click empty space to place the dimension (an arc: near its centre for the angle)" : "Click a line, circle, arc or point";
    case "project":
      return "Click model edges to use them as fixed reference geometry";
    default:
      return "Drag to move · Shift-click to multi-select · drag empty space to box-select · Del removes";
  }
}

function applySolution(entities: SketchEntity[], s: SolvedSketch): SketchEntity[] {
  return entities.map((e) => {
    if (e.type === "point") {
      const p = s.points.get(e.id);
      return p ? { ...e, x: round(p[0]), y: round(p[1]) } : e;
    }
    if (e.type === "circle") {
      const c = s.curves.find((x) => x.id === e.id);
      return c?.kind === "circle" ? { ...e, radius: round(c.radius) } : e;
    }
    return e;
  });
}

function pointEntries(sk: SketchFeature | undefined, s: SolvedSketch): [string, Vec2][] {
  const out: [string, Vec2][] = [["origin", [0, 0]]];
  for (const e of sk?.entities ?? []) if (e.type === "point") {
    const p = s.points.get(e.id);
    if (p) out.push([e.id, p]);
  }
  for (const c of s.curves) {
    if (!c.external) continue;
    for (const k of c.kind === "line" ? ["p1", "p2"] : c.kind === "arc" ? ["center", "start", "end"] : ["center"]) {
      const p = s.points.get(`${c.id}.${k}`);
      if (p) out.push([`${c.id}.${k}`, p]);
    }
  }
  return out;
}

function curvePointIds(sk: SketchFeature, id: string): string[] {
  const e = sk.entities.find((x) => x.id === id);
  if (!e) return [];
  if (e.type === "line") return [e.p1, e.p2];
  if (e.type === "circle") return [e.center];
  if (e.type === "arc") return [e.center, e.start, e.end];
  return [];
}

function connectedCurves(sk: SketchFeature, start: string): string[] {
  const pts = (id: string) => curvePointIds(sk, id).filter((p) => sk.entities.find((e) => e.id === id)?.type !== "circle" || p !== curvePointIds(sk, id)[0]);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const c = queue.shift()!;
    const ends = new Set(pts(c));
    for (const e of sk.entities) {
      if (seen.has(e.id) || (e.type !== "line" && e.type !== "arc")) continue;
      if (pts(e.id).some((p) => ends.has(p))) {
        seen.add(e.id);
        queue.push(e.id);
      }
    }
  }
  return [...seen];
}

function curveSamples(c: SolvedCurve): Vec2[] {
  if (c.kind === "line") return [c.a, c.b];
  const n = 16;
  const [a0, sw] = c.kind === "circle" ? [0, 2 * Math.PI] : [c.a0, ((c.a1 - c.a0 + 4 * Math.PI) % (2 * Math.PI)) || 2 * Math.PI];
  return Array.from({ length: n + 1 }, (_, i) => [c.center[0] + c.radius * Math.cos(a0 + (sw * i) / n), c.center[1] + c.radius * Math.sin(a0 + (sw * i) / n)] as Vec2);
}

function curveDistance(c: SolvedCurve, p: Vec2, infinite = false): number {
  if (c.kind === "line") {
    const d: Vec2 = [c.b[0] - c.a[0], c.b[1] - c.a[1]];
    const l2 = d[0] * d[0] + d[1] * d[1] || 1;
    let t = ((p[0] - c.a[0]) * d[0] + (p[1] - c.a[1]) * d[1]) / l2;
    if (!infinite) t = Math.max(0, Math.min(1, t));
    return Math.hypot(c.a[0] + d[0] * t - p[0], c.a[1] + d[1] * t - p[1]);
  }
  const r = Math.hypot(p[0] - c.center[0], p[1] - c.center[1]);
  if (c.kind === "arc") {
    const a = Math.atan2(p[1] - c.center[1], p[0] - c.center[0]);
    const rel = (a - c.a0 + 4 * Math.PI) % (2 * Math.PI);
    const span = (c.a1 - c.a0 + 4 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
    if (rel > span) {
      const s: Vec2 = [c.center[0] + c.radius * Math.cos(c.a0), c.center[1] + c.radius * Math.sin(c.a0)];
      const e: Vec2 = [c.center[0] + c.radius * Math.cos(c.a1), c.center[1] + c.radius * Math.sin(c.a1)];
      return Math.min(Math.hypot(p[0] - s[0], p[1] - s[1]), Math.hypot(p[0] - e[0], p[1] - e[1]));
    }
  }
  return Math.abs(r - c.radius);
}

function projectOnCurve(c: SolvedCurve, p: Vec2): Vec2 {
  if (c.kind === "line") {
    const d: Vec2 = [c.b[0] - c.a[0], c.b[1] - c.a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - c.a[0]) * d[0] + (p[1] - c.a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1)));
    return [c.a[0] + d[0] * t, c.a[1] + d[1] * t];
  }
  const a = Math.atan2(p[1] - c.center[1], p[0] - c.center[0]);
  return [c.center[0] + c.radius * Math.cos(a), c.center[1] + c.radius * Math.sin(a)];
}

function refsOfEntity(e: SketchEntity): string[] {
  return e.type === "line" ? [e.p1, e.p2] : e.type === "circle" ? [e.center] : e.type === "arc" ? [e.center, e.start, e.end] : [];
}

function refsOf(c: SketchConstraint): string[] {
  return Object.entries(c)
    .filter(([k, v]) => k !== "id" && k !== "type" && typeof v === "string")
    .map(([, v]) => (v as string).split(".")[0]!);
}

let dotTex: THREE.Texture | null = null;
function dotTexture(): THREE.Texture {
  if (dotTex) return dotTex;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(16, 16, 14, 0, Math.PI * 2);
  g.fill();
  dotTex = new THREE.CanvasTexture(c);
  return dotTex;
}

function curveObject(c: SolvedCurve, color: number, dashed: boolean): THREE.Object3D {
  const pts = curveSamples(c.kind === "line" ? c : { ...c }).map(([x, y]) => new THREE.Vector3(x, y, 0));
  if (c.kind !== "line") {
    const n = 96;
    const [a0, sw] = c.kind === "circle" ? [0, 2 * Math.PI] : [c.a0, ((c.a1 - c.a0 + 4 * Math.PI) % (2 * Math.PI)) || 2 * Math.PI];
    pts.length = 0;
    for (let i = 0; i <= n; i++) pts.push(new THREE.Vector3(c.center[0] + c.radius * Math.cos(a0 + (sw * i) / n), c.center[1] + c.radius * Math.sin(a0 + (sw * i) / n), 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.2, depthTest: false }) : new THREE.LineBasicMaterial({ color, depthTest: false });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 28;
  return line;
}

function previewObjects(tool: SketchTool, ts: { points: Snap[]; cursor: Vec2 | null; sweep: number }, _s: SolvedSketch): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const cur = ts.cursor;
  if (!cur) return out;
  const line = (pts: Vec2[], loop = false) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)));
    const o = loop ? new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: COLORS.preview, depthTest: false })) : new THREE.Line(g, new THREE.LineBasicMaterial({ color: COLORS.preview, depthTest: false }));
    o.renderOrder = 40;
    out.push(o);
  };
  const p0 = ts.points[0]?.pos;
  if (!p0) return out;
  if (tool === "line") line([p0, cur]);
  if (tool === "rect") line([p0, [cur[0], p0[1]], cur, [p0[0], cur[1]]], true);
  if (tool === "rect_center") line([[2 * p0[0] - cur[0], 2 * p0[1] - cur[1]], [cur[0], 2 * p0[1] - cur[1]], cur, [2 * p0[0] - cur[0], cur[1]]], true);
  if (tool === "select") line([p0, [cur[0], p0[1]], cur, [p0[0], cur[1]]], true);
  if (tool === "polygon") {
    const r = Math.hypot(cur[0] - p0[0], cur[1] - p0[1]);
    const a0 = Math.atan2(cur[1] - p0[1], cur[0] - p0[0]);
    line(Array.from({ length: 6 }, (_, i) => [p0[0] + r * Math.cos(a0 + (i * Math.PI) / 3), p0[1] + r * Math.sin(a0 + (i * Math.PI) / 3)] as Vec2), true);
  }
  if (tool === "arc" && ts.points.length === 1) line([p0, cur]);
  if (tool === "arc" && ts.points.length === 2) {
    const g = arcThrough(p0, ts.points[1]!.pos, cur);
    if (!g) line([p0, ts.points[1]!.pos]);
    else {
      const a0 = Math.atan2(g.start[1] - g.center[1], g.start[0] - g.center[0]);
      line(Array.from({ length: 65 }, (_, i) => [g.center[0] + g.radius * Math.cos(a0 + (g.sweep * i) / 64), g.center[1] + g.radius * Math.sin(a0 + (g.sweep * i) / 64)] as Vec2));
    }
  }
  if (tool === "circle" || (tool === "arc_center" && ts.points.length === 1)) {
    const r = Math.hypot(cur[0] - p0[0], cur[1] - p0[1]);
    line(Array.from({ length: 65 }, (_, i) => [p0[0] + r * Math.cos((i / 64) * 2 * Math.PI), p0[1] + r * Math.sin((i / 64) * 2 * Math.PI)] as Vec2));
  }
  if (tool === "arc_center" && ts.points.length === 2) {
    const s = ts.points[1]!.pos;
    const r = Math.hypot(s[0] - p0[0], s[1] - p0[1]);
    const a0 = Math.atan2(s[1] - p0[1], s[0] - p0[0]);
    line(Array.from({ length: 65 }, (_, i) => [p0[0] + r * Math.cos(a0 + (ts.sweep * i) / 64), p0[1] + r * Math.sin(a0 + (ts.sweep * i) / 64)] as Vec2));
  }
  return out;
}

/** Marker for what the cursor snapped to (square = endpoint, triangle = midpoint, X = crossing), plus alignment guides. */
function snapObjects(sn: Snap, unit: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const [x, y] = sn.pos;
  const r = unit * 5;
  const add = (pts: Vec2[], kind: "loop" | "segments" | "line", color: number, dashed = false) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(([a, b]) => new THREE.Vector3(a, b, 0)));
    const mat = dashed ? new THREE.LineDashedMaterial({ color, dashSize: unit * 5, gapSize: unit * 4, depthTest: false }) : new THREE.LineBasicMaterial({ color, depthTest: false });
    const o = kind === "loop" ? new THREE.LineLoop(g, mat) : kind === "segments" ? new THREE.LineSegments(g, mat) : new THREE.Line(g, mat);
    if (dashed) o.computeLineDistances();
    o.renderOrder = 45;
    out.push(o);
  };
  for (const [a, b] of sn.guides ?? []) add([a, b], "line", COLORS.guide, true);
  // The landing point itself: a dot with a light halo so it reads on the grid, the model and lines.
  const onGeometry = sn.kind && sn.kind !== "grid";
  for (const [size, color] of [[13, 0xffffff], [8, onGeometry ? COLORS.snap : COLORS.preview]] as const) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([x, y, 0], 3));
    const dot = new THREE.Points(g, new THREE.PointsMaterial({ size, color, sizeAttenuation: false, depthTest: false, map: dotTexture(), transparent: true, alphaTest: 0.5 }));
    dot.renderOrder = size === 13 ? 46 : 47;
    out.push(dot);
  }
  switch (sn.kind) {
    case "point":
      add([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]], "loop", COLORS.snap);
      break;
    case "mid":
      add([[x, y + r * 1.2], [x - r * 1.1, y - r * 0.7], [x + r * 1.1, y - r * 0.7]], "loop", COLORS.snap);
      break;
    case "cross":
      add([[x - r, y - r], [x + r, y + r], [x - r, y + r], [x + r, y - r]], "segments", COLORS.snap);
      break;
    case "curve":
    case "edge":
    case "align":
      add([[x, y - r], [x + r, y], [x, y + r], [x - r, y]], "loop", COLORS.snap);
      break;
    case "center": {
      const ring: Vec2[] = Array.from({ length: 20 }, (_, i) => [x + r * Math.cos((i / 20) * 2 * Math.PI), y + r * Math.sin((i / 20) * 2 * Math.PI)]);
      add(ring, "loop", COLORS.snap);
      add([[x - r * 1.6, y], [x + r * 1.6, y], [x, y - r * 1.6], [x, y + r * 1.6]], "segments", COLORS.snap);
      break;
    }
  }
  return out;
}

/** A model edge lying in the sketch plane, as a polyline in sketch coordinates. */
interface ModelEdge {
  pts: Vec2[];
  /** Centre of a round edge (circle or arc), for snapping to it. */
  center?: Vec2;
}

/**
 * Edges of the model that lie in the sketch plane (a face's outline and holes when sketching on it),
 * so the magnet can snap to them like to sketch lines. Round ones get their centre.
 */
function planeEdges(meshes: readonly { edgeLines: Float32Array; edgeRanges: Int32Array }[], frame: { origin: number[]; u: number[]; v: number[]; normal: number[] }, tol: number): ModelEdge[] {
  const out: ModelEdge[] = [];
  const [o, u, v, n] = [frame.origin, frame.u, frame.v, frame.normal];
  for (const m of meshes) {
    for (let g = 0; g < m.edgeRanges.length; g += 3) {
      const [start, count] = [m.edgeRanges[g]!, m.edgeRanges[g + 1]!];
      const pts: Vec2[] = [];
      let flat = true;
      for (let k = start; k < start + count && flat; k++) {
        const d = [0, 1, 2].map((i) => m.edgeLines[k * 3 + i]! - o[i]!);
        if (Math.abs(d[0]! * n[0]! + d[1]! * n[1]! + d[2]! * n[2]!) > tol) flat = false;
        pts.push([d[0]! * u[0]! + d[1]! * u[1]! + d[2]! * u[2]!, d[0]! * v[0]! + d[1]! * v[1]! + d[2]! * v[2]!]);
      }
      if (!flat || pts.length < 2) continue;
      out.push({ pts, ...(roundCenter(pts) ? { center: roundCenter(pts)! } : {}) });
    }
  }
  return out;
}

/** Centre of a polyline that follows a circle or arc (every point equally far from it), or null. */
function roundCenter(pts: Vec2[]): Vec2 | null {
  if (pts.length < 6) return null;
  const [a, b, c] = [pts[0]!, pts[Math.floor(pts.length / 3)]!, pts[Math.floor((2 * pts.length) / 3)]!];
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
  const center: Vec2 = [(sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d, (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d];
  const r = Math.hypot(a[0] - center[0], a[1] - center[1]);
  return pts.every((p) => Math.abs(Math.hypot(p[0] - center[0], p[1] - center[1]) - r) < r * 0.01 + 1e-4) ? center : null;
}

/** Closest point on a polyline and how far it is. */
function nearestOnPolyline(pts: Vec2[], p: Vec2): { pos: Vec2; dist: number } {
  let best = { pos: pts[0]!, dist: Infinity };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i]!, pts[i + 1]!];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const q: Vec2 = [a[0] + dx * t, a[1] + dy * t];
    const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (dist < best.dist) best = { pos: q, dist };
  }
  return best;
}

interface Label {
  id: string;
  at: Vec2;
  text: string;
  title: string;
  dimension: boolean;
}

/** Positions for dimension values and constraint glyphs (sketch coordinates). */
function constraintLabels(sk: SketchFeature, s: SolvedSketch): Label[] {
  const out: Label[] = [];
  const P = (r: string) => s.points.get(r);
  const curve = (id: string) => s.curves.find((c) => c.id === id);
  const mid = (id: string): Vec2 | null => {
    const c = curve(id);
    if (!c) return null;
    if (c.kind === "line") return [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
    if (c.kind === "circle") return [c.center[0], c.center[1] + c.radius];
    const m = (c.a0 + c.a1) / 2 + (c.a1 < c.a0 ? Math.PI : 0);
    return [c.center[0] + c.radius * Math.cos(m), c.center[1] + c.radius * Math.sin(m)];
  };
  // Glyphs sharing a spot are fanned out along x (in sketch units, scaled by the sketch size).
  const size = Math.max(10, ...s.curves.map((c) => (c.kind === "line" ? Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]) : c.radius * 2)));
  const used = new Map<string, number>();
  const offset = (p: Vec2, key: string): Vec2 => {
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    return [p[0] + n * size * 0.04, p[1] - size * 0.03];
  };
  // Lengths in an inch design are converted and say so; mm designs keep the bare number.
  const valueText = (v: Expr, unit: string) => (typeof v !== "number" ? `${v}` : unit === "" && docUnit() === "in" ? fmtLen(v) : `${fmt(v)}${unit}`);
  for (const c of sk.constraints) {
    if ("value" in c) {
      let at: Vec2 | null = c.label ?? null;
      if (!at) {
        if (c.type === "length") at = mid(c.line);
        else if (c.type === "radius" || c.type === "diameter") at = mid(c.curve);
        else if (c.type === "angle") at = mid(c.a);
        else if (c.type === "arc_angle") {
          // Inside the arc, halfway between its centre and its middle.
          const cv = curve(c.curve);
          const m = mid(c.curve);
          at = cv && cv.kind !== "line" && m ? [(cv.center[0] + m[0]) / 2, (cv.center[1] + m[1]) / 2] : m;
        }
        else if (c.type === "distance") {
          const a = P(c.a);
          const b = P(c.b) ?? mid(c.b);
          at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
        }
      }
      if (!at) continue;
      const unit = c.type === "angle" || c.type === "arc_angle" ? "°" : "";
      const prefix = c.type === "diameter" ? "⌀" : c.type === "radius" ? "R" : c.type === "arc_angle" ? "∠" : "";
      out.push({ id: c.id, at, text: `${prefix}${valueText(c.value, unit)}`, title: `${c.type} ${c.id} — double-click to edit, Del to remove`, dimension: true });
      continue;
    }
    const g = GLYPH[c.type] ?? "?";
    let at: Vec2 | null = null;
    if (c.type === "horizontal" || c.type === "vertical") at = mid(c.line);
    else if (c.type === "parallel" || c.type === "perpendicular" || c.type === "tangent" || c.type === "equal" || c.type === "collinear") at = mid(c.a);
    else if (c.type === "midpoint") at = P(c.point) ?? null;
    else if (c.type === "point_on" || c.type === "fix") at = P(c.type === "fix" ? c.point : c.point) ?? null;
    else if (c.type === "symmetric") at = mid(c.axis);
    else if (c.type === "horizontal_points" || c.type === "vertical_points") {
      const a = P(c.a);
      const b = P(c.b);
      at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
    } else if (c.type === "coincident") continue;
    if (!at) continue;
    const key = `${at[0].toFixed(3)},${at[1].toFixed(3)}`;
    out.push({ id: c.id, at: offset(at, key), text: g, title: `${c.type} (${c.id}) — click to select, Del to remove`, dimension: false });
  }
  return out;
}

function dimensionGeometry(c: SketchConstraint, s: SolvedSketch): Vec2[] | null {
  if (!("value" in c) || !c.label) return null;
  const L = c.label;
  const seg = (a: Vec2, b: Vec2): Vec2[] => [a, b];
  if (c.type === "length" || c.type === "distance") {
    let a: Vec2 | undefined;
    let b: Vec2 | undefined;
    if (c.type === "length") {
      const line = s.curves.find((x) => x.id === c.line);
      if (line?.kind !== "line") return null;
      [a, b] = [line.a, line.b];
    } else {
      a = s.points.get(c.a);
      b = s.points.get(c.b);
      if (!b) {
        const line = s.curves.find((x) => x.id === c.b);
        if (line?.kind === "line" && a) b = projectOnCurve(line, a);
      }
    }
    if (!a || !b) return null;
    if (c.type === "distance" && c.axis) {
      const ax = c.axis === "x";
      const a2: Vec2 = ax ? [a[0], L[1]] : [L[0], a[1]];
      const b2: Vec2 = ax ? [b[0], L[1]] : [L[0], b[1]];
      return [...seg(a, a2), ...seg(b, b2), ...seg(a2, b2)];
    }
    const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const len = Math.hypot(...d) || 1;
    const n: Vec2 = [-d[1] / len, d[0] / len];
    const off = (L[0] - a[0]) * n[0] + (L[1] - a[1]) * n[1];
    const a2: Vec2 = [a[0] + n[0] * off, a[1] + n[1] * off];
    const b2: Vec2 = [b[0] + n[0] * off, b[1] + n[1] * off];
    return [...seg(a, a2), ...seg(b, b2), ...seg(a2, b2)];
  }
  if (c.type === "radius" || c.type === "diameter") {
    const cv = s.curves.find((x) => x.id === c.curve);
    if (!cv || cv.kind === "line") return null;
    const ang = Math.atan2(L[1] - cv.center[1], L[0] - cv.center[0]);
    const onCurve: Vec2 = [cv.center[0] + cv.radius * Math.cos(ang), cv.center[1] + cv.radius * Math.sin(ang)];
    return c.type === "diameter" ? [[cv.center[0] - cv.radius * Math.cos(ang), cv.center[1] - cv.radius * Math.sin(ang)], L] : [cv.center, L].concat([onCurve, L]) as Vec2[];
  }
  if (c.type === "arc_angle") {
    // Spokes from the centre to both ends show what the angle measures.
    const cv = s.curves.find((x) => x.id === c.curve);
    if (!cv || cv.kind !== "arc") return null;
    const end = (a: number): Vec2 => [cv.center[0] + cv.radius * Math.cos(a), cv.center[1] + cv.radius * Math.sin(a)];
    return [cv.center, end(cv.a0), cv.center, end(cv.a1)];
  }
  return null;
}

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | undefined;
    if (mat && !Array.isArray(mat)) mat.dispose();
  });
  g.clear();
}

export { activeSketch };
