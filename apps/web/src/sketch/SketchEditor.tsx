/**
 * In-viewport sketch editor. Geometry lives in the document; this component renders the locally
 * solved sketch on its plane, turns pointer input into entities and constraints, and drags points
 * with PlaneGCS temporary constraints.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveFeature } from "@leocad/model";
import type { Expr, SketchConstraint, SketchEntity, SketchFeature } from "@leocad/schema";
import { findRegions, intersectionPoints, type ResolvedConstraint, type SketchSolver, type SolvedCurve, type SolvedSketch, type Vec2 } from "@leocad/sketch";
import { frameMatrix, THREE, type Viewport } from "@leocad/viewport";
import { parseExpr } from "../components/ExprInput";
import { edgeSelectorForPick } from "../lib/topology";
import { closeSketch, toast, useApp } from "../store";
import { activeSketch, applyConstraint, deleteSelection, freshId, selectAll, setExternalKinds, toggleConstruction, writeSketch } from "./actions";
import { GLYPH } from "./icons";
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
}

const COLORS = { under: 0x2266dd, full: 0x16a34a, construction: 0x8aa4c8, external: 0xa35cff, sel: 0xff7a1a, hover: 0x2e7dff, preview: 0x2e7dff, conflict: 0xd93f3f };

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
  const toolState = useRef<{ points: Snap[]; cursor: Vec2 | null; sweep: number; dimFirst: SketchSel | null }>({ points: [], cursor: null, sweep: 0, dimFirst: null });
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
    for (const obj of previewObjects(ui.tool, ts, shown)) group.add(obj);
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
  /** Snap with inference: existing points, then curves, then origin axes. */
  const snap = (p: Vec2, exclude?: Set<string>): Snap => {
    const tol = px() * 10;
    const pt = hitPoint(p, tol, exclude);
    if (pt) return { pos: shown!.points.get(pt)!, point: pt };
    const c = hitCurve(p, px() * 7, exclude);
    if (c) return { pos: projectOnCurve(c, p), curve: c.id };
    if (Math.abs(p[1]) < px() * 6) return { pos: [p[0], 0], curve: "origin.x" };
    if (Math.abs(p[0]) < px() * 6) return { pos: [0, p[1]], curve: "origin.y" };
    return { pos: p };
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
        else if (s.curve) d.constraints.push({ id: freshId(d, "c", taken), type: "point_on", point: id, curve: s.curve });
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

  const addLine = (a: Snap, b: Snap): [string, string] | null => {
    if (!sketch || Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]) < px() * 2) return null;
    const bl = builder(sketch);
    const p1 = bl.point(a);
    const p2 = bl.point(b);
    const l = bl.entity({ type: "line", p1, p2, ...cons }, "l");
    const ang = Math.abs(Math.atan2(b.pos[1] - a.pos[1], b.pos[0] - a.pos[0]));
    const tolA = (3 * Math.PI) / 180;
    if (ang < tolA || Math.abs(ang - Math.PI) < tolA) bl.constraint({ type: "horizontal", line: l });
    else if (Math.abs(ang - Math.PI / 2) < tolA) bl.constraint({ type: "vertical", line: l });
    commit(bl.d);
    return [p1, p2];
  };

  const addRect = (a: Snap, b: Snap, centered: boolean) => {
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
    if (centered) {
      const center = bl.point(a, true);
      const diag = bl.entity({ type: "line", p1: ids[0]!, p2: ids[2]!, construction: true }, "l");
      bl.constraint({ type: "midpoint", point: center, line: diag });
    }
    commit(bl.d);
  };

  const addCircle = (c: Snap, r: number) => {
    if (!sketch || r < px() * 2) return;
    const bl = builder(sketch);
    const center = bl.point(c);
    bl.entity({ type: "circle", center, radius: r, ...cons }, "c");
    commit(bl.d);
  };

  const addArc = (c: Snap, s: Snap, e: Snap, ccw: boolean) => {
    if (!sketch) return;
    const r = Math.hypot(s.pos[0] - c.pos[0], s.pos[1] - c.pos[1]);
    if (r < px() * 2) return;
    const bl = builder(sketch);
    const center = bl.point(c);
    const a = Math.atan2(e.pos[1] - c.pos[1], e.pos[0] - c.pos[0]);
    const endOnCircle: Snap = { ...e, pos: [c.pos[0] + r * Math.cos(a), c.pos[1] + r * Math.sin(a)] };
    const start = bl.point(ccw ? s : endOnCircle);
    const end = bl.point(ccw ? endOnCircle : s);
    bl.entity({ type: "arc", center, start, end, ...cons }, "a");
    commit(bl.d);
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
      else if (curve.kind === "arc") c = { type: "radius", curve: a.id, value: round(curve.radius), label };
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

  // ---------------------------------------------------------------- pointer handling
  useEffect(() => {
    const el = viewport.canvas;
    let down: { x: number; y: number; p: Vec2; target: SketchSel | null; moved: boolean } | null = null;
    let dragState: { ids: string[]; start: Vec2; origin: Map<string, Vec2>; solved: SolvedSketch | null } | null = null;
    let box: { a: Vec2; b: Vec2 } | null = null;

    const targetAt = (p: Vec2): SketchSel | null => {
      const pt = hitPoint(p, px() * 9);
      if (pt && pt !== "origin") return { kind: "point", id: pt };
      const c = hitCurve(p, px() * 7);
      if (c) return { kind: "curve", id: c.id };
      if (pt) return { kind: "point", id: pt };
      return null;
    };

    const onMove = (e: PointerEvent) => {
      const p = toSketch(e);
      if (!p || !shown) return;
      const tool = useSketchUi.getState().tool;
      const r = el.getBoundingClientRect();
      if (down && e.buttons === 1 && tool === "select") {
        if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
        down.moved = true;
        if (down.target && !dragState && solver && sketch) {
          // Start dragging the target's points.
          const ids = down.target.kind === "point" ? [down.target.id] : curvePointIds(sketch, down.target.id);
          const movable = ids.filter((id) => sketch.entities.some((x) => x.id === id && x.type === "point"));
          if (!movable.length) return;
          dragState = { ids: movable, start: down.p, origin: new Map(movable.map((id) => [id, shown.points.get(id)!])), solved: null };
        }
        if (dragState && solver && sketch) {
          const dx = p[0] - dragState.start[0];
          const dy = p[1] - dragState.start[1];
          const targets: Record<string, Vec2> = {};
          for (const id of dragState.ids) {
            const o = dragState.origin.get(id)!;
            targets[id] = [o[0] + dx, o[1] + dy];
          }
          const radiusDrag = down.target?.kind === "curve" && sketch.entities.find((x) => x.id === down!.target!.id)?.type === "circle" && e.altKey;
          const s = solver.solve(
            { entities: sketch.entities, constraints: resolvedConstraints.list, external },
            radiusDrag ? { dragRadius: { curve: down.target!.id, radius: Math.hypot(p[0] - shown.points.get(curvePointIds(sketch, down.target!.id)[0]!)![0], p[1] - shown.points.get(curvePointIds(sketch, down.target!.id)[0]!)![1]) } } : { drag: targets },
          );
          dragState.solved = s;
          setDrag(s);
          return;
        }
        if (!down.target) {
          box = { a: down.p, b: p };
          ts.cursor = p;
          ts.points = [{ pos: box.a }, { pos: box.b }];
          rerender();
        }
        return;
      }
      if (e.buttons) return;
      // Hover + tool previews
      if (tool === "select" || tool === "dimension" || tool === "trim") setHover(targetAt(p));
      else setHover(null);
      if (tool === "project") return;
      const s = tool === "select" || tool === "dimension" ? { pos: p } : snap(p);
      ts.cursor = s.pos;
      if (tool === "line" && ts.points.length) {
        const a = ts.points[0]!.pos;
        const len = Math.hypot(s.pos[0] - a[0], s.pos[1] - a[1]);
        const ang = (Math.atan2(s.pos[1] - a[1], s.pos[0] - a[0]) * 180) / Math.PI;
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `${fmt(len)} mm  ${fmt(((ang % 360) + 360) % 360)}°` });
      } else if ((tool === "circle" || tool === "arc") && ts.points.length) {
        const c = ts.points[0]!.pos;
        if (tool === "arc" && ts.points.length === 2) {
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
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `R ${fmt(Math.hypot(s.pos[0] - c[0], s.pos[1] - c[1]))} mm` });
      } else if (tool === "polygon" && ts.points.length) {
        const c = ts.points[0]!.pos;
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `hexagon R ${fmt(Math.hypot(s.pos[0] - c[0], s.pos[1] - c[1]))} mm` });
      } else if ((tool === "rect" || tool === "rect_center") && ts.points.length) {
        const a = ts.points[0]!.pos;
        const k = tool === "rect_center" ? 2 : 1;
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `${fmt(Math.abs(s.pos[0] - a[0]) * k)} × ${fmt(Math.abs(s.pos[1] - a[1]) * k)} mm` });
      } else setTip(s.point || s.curve ? { x: e.clientX - r.left, y: e.clientY - r.top, text: s.point ? "●" : "on curve" } : null);
      rerender();
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const p = toSketch(e);
      if (!p) return;
      down = { x: e.clientX, y: e.clientY, p, target: targetAt(p), moved: false };
      if (useSketchUi.getState().tool === "select") el.setPointerCapture(e.pointerId);
    };

    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const d = down;
      down = null;
      const p = toSketch(e);
      if (!p || !sketch) return;
      const tool = useSketchUi.getState().tool;
      if (dragState) {
        const s = dragState.solved;
        dragState = null;
        setDrag(null);
        if (s?.diagnostics.ok) commit({ entities: applySolution(sketch.entities, s), constraints: sketch.constraints });
        return;
      }
      if (box) {
        const [x0, x1] = [Math.min(box.a[0], box.b[0]), Math.max(box.a[0], box.b[0])];
        const [y0, y1] = [Math.min(box.a[1], box.b[1]), Math.max(box.a[1], box.b[1])];
        const inside = (q: Vec2) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
        const sel: SketchSel[] = [];
        for (const [id, q] of pointEntries(sketch, shown!)) if (id !== "origin" && inside(q)) sel.push({ kind: "point", id });
        for (const c of shown!.curves) if (curveSamples(c).every(inside)) sel.push({ kind: "curve", id: c.id });
        box = null;
        ts.points = [];
        setSketchSelection(e.shiftKey ? [...useSketchUi.getState().selection, ...sel] : sel);
        return;
      }
      if (d.moved && tool === "select") return;
      const s = snap(p);
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
          const start = ts.points[0]!;
          const made = addLine(start, s);
          if (!made) return;
          const chainStart = ts.points[1] ?? { pos: start.pos, point: made[0] };
          // Clicking the chain's first point closes the loop and ends the chain.
          ts.points = s.point && s.point === chainStart.point ? [] : [{ pos: s.pos, point: made[1] }, chainStart];
          if (!ts.points.length) setTip(null);
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
        case "arc":
          if (ts.points.length < 2) {
            ts.points = [...ts.points, s];
            ts.sweep = 0;
          } else {
            addArc(ts.points[0]!, ts.points[1]!, s, ts.sweep >= 0);
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
    const onLeave = () => {
      setTip(null);
      setHover(null);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDbl);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDbl);
      el.removeEventListener("pointerleave", onLeave);
    };
  });

  // Reset in-progress tool state when switching tools.
  useEffect(() => {
    ts.points = [];
    ts.dimFirst = null;
    setTip(null);
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
      // Constraints use Shift + letter (Shapr3D layout); plain letters pick tools.
      const cmap: Record<string, string> = { a: "parallel", c: "concentric", e: "equal", v: "hv", n: "coincident", l: "fix", m: "midpoint", p: "perpendicular", s: "symmetric", t: "tangent" };
      if (e.shiftKey && cmap[k]) return applyConstraint(cmap[k]!);
      const tools: Record<string, SketchTool> = { l: "line", r: e.shiftKey ? "rect_center" : "rect", c: "circle", a: "arc", p: "point", d: "dimension", u: "project", g: "polygon", t: "trim" };
      if (tools[k]) return setTool(tools[k]!);
      if (k === "x") return toggleConstruction();
      if (e.key === "Escape") {
        if (ts.points.length || ts.dimFirst) {
          ts.points = [];
          ts.dimFirst = null;
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

  if (!sketch) return null;
  const diag = shown?.diagnostics;
  const conflicting = new Set([...(diag?.conflicting ?? []), ...resolvedConstraints.bad]);

  return (
    <>
      <div className="overlay-layer" ref={layer}>
        {labels.map((l) =>
          l.id === editing ? (
            <div key={l.id} className="sketch-label sel" data-x={l.at[0]} data-y={l.at[1]}>
              <DimInput
                value={(sketch.constraints.find((c) => c.id === l.id) as { value: Expr }).value}
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
        {tip ? (
          <div className="cursor-tip" style={{ left: tip.x, top: tip.y }}>
            {tip.text}
          </div>
        ) : null}
      </div>
      <div className="sketch-hud">
        <div className="card2">
          <div className="row" style={{ gap: 10 }}>
            <b>{sketch.name ?? sketch.id}</b>
            <span className={`dof ${diag && !diag.ok ? "bad" : diag?.dof === 0 ? "full" : ""}`}>
              <i />
              {!diag ? "Solving…" : !diag.ok ? "Over-constrained" : diag.dof === 0 ? "Fully defined" : `${diag.dof} DOF left`}
            </span>
          </div>
          {diag?.message ? <div className="muted" style={{ marginTop: 4, color: "var(--err)" }}>{diag.message}</div> : null}
          <div className="muted" style={{ marginTop: 4, maxWidth: 280 }}>{toolHint(ui.tool, ts.points.length, !!ts.dimFirst)}</div>
        </div>
      </div>
    </>
  );
}

function DimInput({ value, onDone }: { value: Expr; onDone: (v: Expr | null) => void }) {
  const [text, setText] = useState(String(value));
  return (
    <input
      autoFocus
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text.trim() ? parseExpr(text) : null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(text.trim() ? parseExpr(text) : null);
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

// ---------------------------------------------------------------- helpers

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
      return n ? "Click to continue the chain · double-click or Esc to end · click the start point to close" : "Click to start a line. Near-horizontal/vertical lines snap.";
    case "rect":
      return n ? "Click the opposite corner" : "Click the first corner";
    case "rect_center":
      return n ? "Click a corner" : "Click the center";
    case "circle":
      return n ? "Click to set the radius" : "Click the center";
    case "arc":
      return n === 0 ? "Click the arc center" : n === 1 ? "Click the start point" : "Click the end point (move clockwise to flip)";
    case "point":
      return "Click to place a point";
    case "polygon":
      return n ? "Click a corner (hexagon; constraints keep it regular)" : "Click the center";
    case "trim":
      return "Click the piece of a curve to cut away up to its nearest intersections";
    case "dimension":
      return dimFirst ? "Click a second entity, or click empty space to place the dimension" : "Click a line, circle, arc or point";
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
  if (tool === "circle" || (tool === "arc" && ts.points.length === 1)) {
    const r = Math.hypot(cur[0] - p0[0], cur[1] - p0[1]);
    line(Array.from({ length: 65 }, (_, i) => [p0[0] + r * Math.cos((i / 64) * 2 * Math.PI), p0[1] + r * Math.sin((i / 64) * 2 * Math.PI)] as Vec2));
  }
  if (tool === "arc" && ts.points.length === 2) {
    const s = ts.points[1]!.pos;
    const r = Math.hypot(s[0] - p0[0], s[1] - p0[1]);
    const a0 = Math.atan2(s[1] - p0[1], s[0] - p0[0]);
    line(Array.from({ length: 65 }, (_, i) => [p0[0] + r * Math.cos(a0 + (ts.sweep * i) / 64), p0[1] + r * Math.sin(a0 + (ts.sweep * i) / 64)] as Vec2));
  }
  return out;
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
  const valueText = (v: Expr, unit: string) => (typeof v === "number" ? `${fmt(v)}${unit}` : `${v}`);
  for (const c of sk.constraints) {
    if ("value" in c) {
      let at: Vec2 | null = c.label ?? null;
      if (!at) {
        if (c.type === "length") at = mid(c.line);
        else if (c.type === "radius" || c.type === "diameter") at = mid(c.curve);
        else if (c.type === "angle") at = mid(c.a);
        else if (c.type === "distance") {
          const a = P(c.a);
          const b = P(c.b) ?? mid(c.b);
          at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
        }
      }
      if (!at) continue;
      const unit = c.type === "angle" ? "°" : "";
      const prefix = c.type === "diameter" ? "⌀" : c.type === "radius" ? "R" : "";
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
