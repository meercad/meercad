/**
 * In-viewport sketch editor. Geometry lives in the document; this component renders the locally
 * solved sketch on its plane, turns pointer input into entities and constraints, and drags points
 * with PlaneGCS temporary constraints. The steps live in `./editor`: geometry, snapping, the shapes
 * the tools draw, trimming, dimensions, typed values, pointer and keyboard input, and the panels.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { evaluate, resolveFeature } from "@meercad/model";
import type { Expr, SketchFeature } from "@meercad/schema";
import {
  cornerEdit,
  distance2,
  findRegions,
  offsetCurves,
  patternCurves,
  SketchEditError,
  sub3,
  toWorld,
  type ResolvedConstraint,
  type SketchSolver,
  type SolvedSketch,
  type Vec2,
} from "@meercad/sketch";
import { frameMatrix, THREE, type Handle, type Viewport } from "@meercad/viewport";
import { parseExpr } from "../components/ExprInput";
import { usePhoneSheets } from "../lib/layout";
import { closeSketch, toast, useApp } from "../store";
import { t, tn } from "../lib/i18n";
import { lengthExpr } from "../lib/units";
import { planeSupport } from "../lib/planeSupport";
import { dropMirrors } from "../lib/sceneMirror";
import { usePrefs } from "../lib/keymap";
import { activeSketch, setExternalKinds, writeSketch } from "./actions";
import { anchorLine, changedAngle, holdLine, keepLine } from "../lib/angleHold";
import { getSolver } from "./solver";
import { meshSections, traceSections } from "./section";
import { setSketchSelection, setTool, useSketchUi, type SketchSel } from "./state";
import { dimensionFor } from "./editor/dimension";
import { entryTarget } from "./editor/entry";
import { applySolution, joinedChain, nearestLineEnd, planeEdges } from "./editor/geometry";
import { useSketchKeys } from "./editor/keys";
import { constraintLabels, pairAngle, quickDimensions } from "./editor/labels";
import { ConstraintLabels, ConstraintPalette, DrawEntry, QuickChips, SketchHud } from "./editor/panels";
import { activeSplines, splineHandles, type Handle } from "./editor/handles";
import { useSketchPointer, type Tip } from "./editor/pointer";
import {
  disposeGroup,
  drawDimensionLines,
  drawSketch,
  placeOnScreen,
  SKETCH_VALUE,
  planeAxes,
  previewObjects,
  sameHandle,
  snapObjects,
} from "./editor/scene";
import {
  centerArcDraft,
  circleDraft,
  draftBuilder,
  lineDraft,
  polygonDraft,
  rectDraft,
  splineDraft,
  threePointArcDraft,
  type ShapeStyle,
} from "./editor/shapes";
import { hitCurve, hitPoint, snapPoint, snapTargetsOf } from "./editor/snap";
import { ENTRY_FIELDS, isAngleField, POINT_TOOLS, toolHint } from "./editor/tools";
import { trimDraft } from "./editor/trim";
import type { Draft, Entry, LastShape, NewConstraint, Snap, ToolState } from "./editor/types";

/** New shapes smaller than this many screen pixels are slips, not shapes. */
const MIN_SHAPE_PIXELS = 2;
/** How near (screen pixels) a click must be to the curve it trims or offsets, or the corner it rounds. */
const EDIT_PICK_PIXELS = { curve: 8, corner: 12, point: 2 };

export function SketchEditor({ viewport, sketchId }: { viewport: Viewport; sketchId: string }) {
  const doc = useApp((state) => state.doc);
  const output = useApp((state) => state.output);
  const ui = useSketchUi();
  const sketch = doc.features.find((feature) => feature.id === sketchId) as SketchFeature | undefined;
  const view = output?.report.sketches.find((sketchView) => sketchView.id === sketchId);
  const frame = view?.frame;
  // Dimensions stay on the part's face the sketch lies on (lib/planeSupport.ts).
  const onFace = useMemo(
    () => (output && frame ? planeSupport(output.meshes, frame) : null),
    [output, frame],
  );
  const params = output?.report.params;
  const [solver, setSolver] = useState<SketchSolver | null>(null);
  const [drag, setDrag] = useState<SolvedSketch | null>(null);
  const [hover, setHover] = useState<SketchSel | null>(null);
  const [hoverHandle, setHoverHandleState] = useState<Handle | null>(null);
  const setHoverHandle = (h: Handle | null) => {
    if (!sameHandle(h, hoverHandle) && (h || hoverHandle)) setHoverHandleState(h);
  };
  const [tip, setTip] = useState<Tip | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [hoverChain, setHoverChain] = useState(-1);
  const layer = useRef<HTMLDivElement>(null);
  const toolState = useRef<ToolState>({ points: [], cursor: null, snap: null, sweep: 0, dimFirst: null });
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

  const external = useMemo(() => (view?.curves ?? []).filter((curve) => curve.external), [view]);
  useEffect(() => {
    setExternalKinds(new Map(external.map((curve) => [curve.id, curve.kind])));
  }, [external]);

  // ---------------------------------------------------------------- solving
  const resolvedConstraints = useMemo((): { list: ResolvedConstraint[]; bad: Set<string> } => {
    if (!sketch) return { list: [], bad: new Set() };

    const scope = new Map(Object.entries(params ?? {}));
    const bad = new Set<string>();
    const list = sketch.constraints.flatMap((constraint) => {
      try {
        return (
          resolveFeature({ ...sketch, constraints: [constraint] }, scope) as {
            constraints: ResolvedConstraint[];
          }
        ).constraints;
      } catch {
        bad.add(constraint.id);

        return [];
      }
    });

    return { list, bad };
  }, [sketch, params]);

  const solved = useMemo((): SolvedSketch | null => {
    if (!solver || !sketch) return null;

    try {
      return solver.solve({ entities: sketch.entities, constraints: resolvedConstraints.list, external });
    } catch (error) {
      return {
        points: new Map(),
        curves: [],
        diagnostics: {
          dof: 0,
          ok: false,
          conflicting: [],
          redundant: [],
          message: error instanceof Error ? error.message : String(error),
        },
      };
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
      cons = (resolveFeature({ ...sketch!, ...next }, scope) as { constraints: ResolvedConstraint[] })
        .constraints;
    } catch {
      return writeSketch(next, merge);
    }

    // A changed angle turns one line: the other is held where it is (see lib/angleHold.ts).
    const angle = changedAngle(sketch!.constraints, next.constraints);
    const keep = angle && shown ? anchorLine({ ...sketch!, ...next }, angle[0], angle[1]) : null;
    const drag = keep ? holdLine({ ...sketch!, ...next }, keep, shown!.points) : undefined;
    const solved = solver.solve(
      { entities: next.entities, constraints: cons, external },
      drag ? { drag } : {},
    );
    const entities = !solved.diagnostics.ok
      ? next.entities
      : keep
        ? keepLine(next.entities, applySolution(next.entities, solved), keep)
        : applySolution(next.entities, solved);

    if (!solved.diagnostics.ok && solved.diagnostics.conflicting.length) {
      toast(t("Over-constrained: {list}", { list: solved.diagnostics.conflicting.join(", ") }), "error");
    }

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

  // The viewport draws the grid in the sketch plane (endless, following the zoom); the sketch adds its axes.
  const axesGroup = useMemo(() => new THREE.Group(), []);
  useEffect(() => {
    if (!frame) return;

    viewport.setGridFrame(frame);
    viewport.overlay.add(axesGroup);
    axesGroup.matrixAutoUpdate = false;
    axesGroup.matrix.copy(frameMatrix(frame));
    axesGroup.add(planeAxes());

    return () => {
      viewport.setGridFrame(null);
      viewport.overlay.remove(axesGroup);
      disposeGroup(axesGroup);
    };
  }, [viewport, frame, axesGroup]);

  // Two lines picked together: the angle between them, on its arc in grey, ready to be fixed.
  const pickedCurves = ui.selection.filter((sel) => sel.kind === "curve");
  const angleChip =
    sketch && shown && pickedCurves.length === 2 && ui.selection.length === 2
      ? pairAngle(sketch, shown, pickedCurves[0]!.id, pickedCurves[1]!.id)
      : null;

  // Tangent knobs of the selected splines (select tool only).
  const handles =
    ui.tool === "select" && shown && frame
      ? splineHandles(sketch, shown, activeSplines(sketch, ui.selection), viewport.pixelSize(frame.origin))
      : [];

  const ts = toolState.current;
  useEffect(() => {
    disposeGroup(group);
    if (!frame || !shown) return;

    group.matrixAutoUpdate = false;
    group.matrix.copy(frameMatrix(frame));
    drawSketch(group, {
      sketch,
      shown,
      regions,
      sections,
      hotSection: ui.tool === "section" ? hoverChain : -1,
      selection: ui.selection,
      hover,
      handles,
      hoverHandle,
    });

    for (const obj of previewObjects(ui.tool, { ...ts, cursor: typedTarget() ?? ts.cursor })) group.add(obj);
    if (ts.snap) for (const obj of snapObjects(ts.snap, viewport.pixelSize(frame.origin))) group.add(obj);

    drawDimensionLines(group, sketch, shown, angleChip?.angle, onFace);
  });

  // ---------------------------------------------------------------- hit testing and snapping
  /** One screen pixel in sketch units. */
  const px = () => viewport.pixelSize(frame?.origin);
  const toSketch = (e: { clientX: number; clientY: number }) =>
    frame ? viewport.rayToPlane(e.clientX, e.clientY, frame) : null;
  const pointNear = (p: Vec2, tol: number, exclude?: Set<string>) => hitPoint(sketch, shown, p, tol, exclude);
  const curveNear = (p: Vec2, tol: number, exclude?: Set<string>) => hitCurve(shown, p, tol, exclude);

  // Midpoints and crossings of the solved curves, for snapping.
  const snapTargets = useMemo(() => snapTargetsOf(shown?.curves ?? []), [shown]);
  // Model edges in the sketch plane (outline and holes of the face sketched on).
  const modelEdges = useMemo(() => {
    if (!frame || !output) return [];

    const size = Math.max(
      1,
      ...output.report.bodies.map((b) => Math.hypot(...b.bbox.max.map((v, i) => v - b.bbox.min[i]!))),
    );

    return planeEdges(output.meshes, frame, size * 1e-5 + 1e-4);
  }, [output, frame]);
  // Where the plane cuts imported meshes: a guide to draw over, and what the section tool traces.
  const sections = useMemo(
    () => (frame && output ? meshSections(doc.features, output.meshes, frame) : []),
    [output, frame, doc.features],
  );

  /** Where the cursor lands (see `snapPoint`); `free` (Alt held) turns snapping off. */
  const snap = (p: Vec2, exclude?: Set<string>, from?: Vec2, free = false): Snap => {
    if (free || !shown) return { pos: p };

    const { snapGrid, snapGeometry } = usePrefs.getState();

    return snapPoint(
      {
        sketch,
        shown,
        unit: px(),
        snapGrid,
        snapGeometry,
        targets: snapTargets,
        modelEdges,
        sections,
        gridStep: () => viewport.gridSpacing,
      },
      p,
      exclude,
      from,
    );
  };

  // ---------------------------------------------------------------- building geometry
  const construction = ui.construction;
  const shapeStyle = (): ShapeStyle => ({ minSize: px() * MIN_SHAPE_PIXELS, construction });

  const addLine = (a: Snap, b: Snap, length?: Expr): [string, string] | null => {
    if (!sketch) return null;

    const made = lineDraft(sketch, a, b, length, shapeStyle());
    if (!made) return null;

    setLastShape({ kind: "line", id: made.line });
    commit(made.draft);

    return made.ends;
  };

  const addRect = (a: Snap, b: Snap, centered: boolean, size?: { w?: Expr; h?: Expr }) => {
    if (!sketch) return;

    const draft = rectDraft(sketch, a, b, centered, size, shapeStyle());
    if (draft) commit(draft);
  };

  const addCircle = (center: Snap, r: number, diameter?: Expr) => {
    if (!sketch) return;

    const made = circleDraft(sketch, center, r, diameter, shapeStyle());
    if (!made) return;

    setLastShape({ kind: "circle", id: made.circle });
    commit(made.draft);
  };

  const addArc = (center: Snap, s: Snap, e: Snap, ccw: boolean, angle?: Expr) => {
    if (!sketch) return;

    const made = centerArcDraft(sketch, center, s, e, ccw, angle, shapeStyle());
    if (!made) return;

    commit(made.draft);
    setLastShape({ kind: "arc", id: made.arc });
  };

  const add3PointArc = (
    a: Snap,
    b: Snap,
    m: Vec2,
    dims: { radius?: Expr | undefined; angle?: Expr | undefined } = {},
  ) => {
    if (!sketch) return;

    const made = threePointArcDraft(sketch, a, b, m, dims, shapeStyle());
    if (!made) return;

    commit(made.draft);
    setLastShape({ kind: "arc", id: made.arc });
  };

  const addPolygon = (center: Snap, corner: Vec2, sides = 6) => {
    if (!sketch) return;

    const draft = polygonDraft(sketch, center, corner, sides, shapeStyle());
    if (draft) commit(draft);
  };

  const addPoint = (snap: Snap) => {
    if (!sketch || snap.point) return;

    const builder = draftBuilder(sketch);
    builder.point(snap, construction);
    commit(builder.draft);
  };

  /** Lines, arcs and circles along mesh sections, as ordinary sketch geometry. */
  const traceSection = (chains: typeof sections) => {
    if (!sketch || !chains.length) return;

    const { draft, curves } = traceSections(sketch, chains, ui.traceTol, construction);
    if (!curves) return toast(t("Nothing to trace here"), "error");

    commit(draft);
    toast(
      tn(
        curves,
        "one::Traced {n} curve. Dimension it to set the size.",
        "Traced {n} curves. Dimension them to set the sizes.",
      ),
    );
  };

  /** Removes the piece of a curve between the nearest intersections around the click. */
  const trimAt = (p: Vec2) => {
    if (!sketch || !shown) return;

    const target = curveNear(p, px() * EDIT_PICK_PIXELS.curve);
    if (!target || target.external) return;

    const draft = trimDraft(sketch, shown, target, p, (pt) => pointNear(pt, px() * EDIT_PICK_PIXELS.point));
    if (draft) commit(draft);
  };

  /** Ends the spline being drawn: a curve through the clicked points (at least two). */
  const finishSpline = (closed = false) => {
    const pts = ts.points;
    ts.points = [];
    setTip(null);
    if (!sketch || pts.length < 2) return rerender();

    commit(splineDraft(sketch, pts, closed, construction));
  };

  /** Repeats the selected curves as set in the pattern tool's panel. */
  const repeatSelection = () => {
    if (!sketch || !shown) return;

    const ids = useSketchUi
      .getState()
      .selection.filter((x) => x.kind === "curve")
      .map((x) => x.id);
    const o = useSketchUi.getState().pattern;

    tryEdit(
      () =>
        patternCurves(
          sketch,
          shown.points,
          ids,
          o.kind === "linear"
            ? { kind: "linear", count: o.count, dx: o.dx, dy: o.dy }
            : { kind: "circular", count: o.count, angle: o.angle, center: [0, 0] },
        ),
      (reason) => t("Cannot repeat: {reason}", { reason }),
      () => setSketchSelection([]),
    );
  };

  /** Rounds or bevels the corner nearest the click (two lines meeting at a point). */
  const cornerAt = (p: Vec2, kind: "fillet" | "chamfer") => {
    if (!sketch || !shown) return;

    const corner = nearestLineEnd(sketch, shown.points, p, px() * EDIT_PICK_PIXELS.corner);
    if (!corner) return toast(t("Click the corner point where two lines meet"), "info");

    tryEdit(
      () => cornerEdit(sketch, shown.points, corner, ui.editSize, kind),
      (reason) =>
        kind === "fillet"
          ? t("Cannot round this corner: {reason}", { reason })
          : t("Cannot bevel this corner: {reason}", { reason }),
    );
  };

  /** Offsets the chain of lines and arcs (or the circle) under the click by the tool's distance. */
  const offsetAt = (p: Vec2) => {
    if (!sketch || !shown) return;

    const target = curveNear(p, px() * EDIT_PICK_PIXELS.curve);
    if (!target || target.external) return;

    tryEdit(
      () => offsetCurves(sketch, shown.points, joinedChain(sketch, target.id), ui.editSize),
      (reason) => t("Cannot offset: {reason}", { reason }),
    );
  };

  /** Commits a sketch edit; one the sketch package refuses shows its reason instead. */
  const tryEdit = (edit: () => Draft, message: (reason: string) => string, after?: () => void) => {
    try {
      commit(edit());
      after?.();
    } catch (error) {
      if (error instanceof SketchEditError) {
        toast(message(error.message), "error");
      } else {
        throw error;
      }
    }
  };

  /** Creates a dimension constraint between selections, with its label at `at`. */
  const addDimension = (a: SketchSel, b: SketchSel | null, at: Vec2) => {
    if (!sketch || !shown) return;

    const c = dimensionFor(shown, a, b, at);

    if (!c) {
      return toast(
        t("Dimension: pick a line, circle, arc, two points, a point and a line, or two lines"),
        "error",
      );
    }

    const builder = draftBuilder(sketch);
    const id = builder.constraint(c);
    if (commit(builder.draft)) setEditing(id);
  };

  /** Draws a line from the pending point to `s` and continues the chain (or closes it on its first point). */
  const lineTo = (snap: Snap, length?: Expr) => {
    const start = ts.points[0];
    if (!start) return;

    const made = addLine(start, snap, length);
    if (!made) return;

    const chainStart = ts.points[1] ?? { pos: start.pos, point: made[0] };
    ts.points =
      snap.point && snap.point === chainStart.point ? [] : [{ pos: snap.pos, point: made[1] }, chainStart];
    if (!ts.points.length) setTip(null);
  };

  // ---------------------------------------------------------------- typed values while drawing
  const [entry, setEntry] = useState<Entry | null>(null);
  // On a phone the constraint list is a sheet opened from the tool bar.
  const phoneConstraints = usePhoneSheets((s) => s.constraints);
  useEffect(() => () => usePhoneSheets.setState({ constraints: false }), []);

  /** The shape just drawn: its size and angle show as chips that can be tapped to fix them. */
  const [lastShape, setLastShape] = useState<LastShape | null>(null);
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
  const typedTarget = () => entryTarget(ui.tool, entry, ts, valueOf);

  const finishEntry = () => {
    const target = typedTarget();
    if (!entry || !target || !ts.points.length) return setEntry(null);

    const expr = (i: number) =>
      entry.fields[i]?.trim() ? entryExpr(entry.fields[i]!, isAngleField(ui.tool, i)) : undefined;
    placeTyped(target, expr);
    setEntry(null);
    setTip(null);
    rerender();
  };

  /** Draws the shape with its free end at the typed `target`; typed values become its dimensions. */
  const placeTyped = (target: Vec2, expr: (i: number) => Expr | undefined) => {
    const snap: Snap = { pos: target };

    if (ui.tool === "line") return lineTo(snap, expr(0));

    if (ui.tool === "rect" || ui.tool === "rect_center") {
      addRect(ts.points[0]!, snap, ui.tool === "rect_center", { w: expr(0), h: expr(1) });
    } else if (ui.tool === "circle") {
      const center = ts.points[0]!;
      addCircle(center, distance2(center.pos, target), expr(0));
    } else if (ui.tool === "arc") {
      add3PointArc(ts.points[0]!, ts.points[1]!, target, { radius: expr(0), angle: expr(1) });
    } else if (ui.tool === "arc_center") {
      addArc(ts.points[0]!, ts.points[1]!, snap, ts.sweep >= 0, expr(0));
    } else {
      return;
    }

    ts.points = [];
  };

  /**
   * A right click in a scheme where it confirms: finishes what is being drawn (a spline is kept, a
   * line chain ends), then puts the tool down, then closes the sketch, one step per click.
   */
  const confirmStep = () => {
    const tool = useSketchUi.getState().tool;
    if (tool === "spline" && ts.points.length >= 2) return finishSpline();

    if (ts.points.length || ts.dimFirst) {
      ts.points = [];
      ts.dimFirst = null;
      setEntry(null);
      setTip(null);

      return rerender();
    }

    if (tool !== "select") return setTool("select");

    closeSketch();
  };

  // ---------------------------------------------------------------- pointer and keyboard
  useSketchPointer({
    viewport,
    sketch,
    shown,
    solver,
    constraints: resolvedConstraints.list,
    external,
    ts,
    sections,
    hoverChain,
    cursorScreen,
    px,
    toSketch,
    snap,
    hitPoint: (p, tol) => pointNear(p, tol),
    hitCurve: (p, tol) => curveNear(p, tol),
    handles,
    setHoverHandle,
    rerender,
    setDrag,
    setHover,
    setHoverChain,
    setTip,
    setEntry,
    commit,
    confirmStep,
    lineTo,
    addRect,
    addCircle,
    addArc,
    add3PointArc,
    addPolygon,
    addPoint,
    finishSpline,
    trimAt,
    cornerAt,
    offsetAt,
    addDimension,
    traceSection,
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

  useSketchKeys({ ts, setEntry, setTip, finishSpline, rerender });

  // ---------------------------------------------------------------- HTML labels
  const labels = useMemo(
    () => (sketch && shown ? constraintLabels(sketch, shown, onFace) : []),
    [sketch, shown, onFace],
  );
  // Placed in the frame the camera moves (before the picture is drawn), so labels never trail behind
  // while orbiting; and after each render, for labels that came or changed.
  useEffect(() => {
    const place = () => {
      if (frame && layer.current) placeOnScreen(layer.current, frame, viewport);
    };

    place();

    return viewport.onChange(place);
  }, [frame, viewport]);
  useLayoutEffect(() => {
    if (frame && layer.current) placeOnScreen(layer.current, frame, viewport);
  });
  // The values are drawn in the scene (sketch/editor/scene.ts): gone with the editor.
  useEffect(() => () => dropMirrors(viewport, SKETCH_VALUE, new Set()), [viewport]);

  const placeAgain = () => {
    if (frame && layer.current) placeOnScreen(layer.current, frame, viewport);
  };

  // A length's dimension line drags like an arrow: the dimension moves parallel to itself (with the
  // select tool; a drawing tool's clicks go to the sketch).
  useEffect(() => {
    if (!frame || !sketch || ui.tool !== "select") return void viewport.setGrips([]);

    const world = (p: Vec2) => toWorld(frame, p);
    const way = (v: Vec2) => sub3(toWorld(frame, v), toWorld(frame, [0, 0]));

    viewport.setGrips(
      labels.flatMap((l): Handle[] => {
        if (!l.line || !l.up) return [];

        const [at, up] = [l.at, l.up];
        let moved = false;

        const move = (offset: number) => {
          if (offset === 0 && !moved) return;

          const label: [number, number] = [
            +(at[0] + up[0] * offset).toFixed(2),
            +(at[1] + up[1] * offset).toFixed(2),
          ];
          commit(
            {
              entities: sketch.entities,
              constraints: sketch.constraints.map((x) => (x.id === l.id ? ({ ...x, label } as typeof x) : x)),
            },
            moved,
          );
          moved = true;
        };

        return [
          {
            id: `dimension:${l.id}`,
            origin: world(at),
            dir: way(up),
            value: 0,
            hidden: true,
            grip: [world(l.line[0]), world(l.line[1])],
            onDrag: move,
            onEnd: move,
          },
        ];
      }),
    );
  });
  useEffect(() => () => viewport.setGrips([]), [viewport]);

  // Chips with the new shape's size and angle; tapping one fixes that value as a dimension.
  const lastCurve = lastShape && shown?.curves.find((curve) => curve.id === lastShape.id);
  const quick = sketch && lastCurve ? quickDimensions(sketch, lastCurve) : [];
  if (angleChip) quick.push(angleChip);

  const addQuickDim = (make: (expr: Expr) => NewConstraint, expr: Expr) => {
    if (!sketch) return;

    const builder = draftBuilder(sketch);
    builder.constraint(make(expr));
    commit(builder.draft);
  };

  if (!sketch) return null;

  const diag = shown?.diagnostics;
  const conflicting = new Set([...(diag?.conflicting ?? []), ...resolvedConstraints.bad]);

  return (
    <>
      {/* Hovering a value colours it: its copy in the scene follows. */}
      <div className="overlay-layer" ref={layer} onPointerOver={placeAgain} onPointerOut={placeAgain}>
        <QuickChips
          quick={quick}
          shapeId={lastShape?.id}
          typing={typingQuick}
          setTyping={setTypingQuick}
          onSet={addQuickDim}
        />
        <ConstraintLabels
          sketch={sketch}
          labels={labels}
          editing={editing}
          setEditing={setEditing}
          selection={ui.selection}
          conflicting={conflicting}
          tool={ui.tool}
          onEdited={(constraints) => commit({ entities: sketch.entities, constraints }, true)}
          onMoved={(id, clientX, clientY) => {
            const at = toSketch({ clientX, clientY });
            if (!at) return;

            const label: [number, number] = [+at[0].toFixed(2), +at[1].toFixed(2)];
            commit({
              entities: sketch.entities,
              constraints: sketch.constraints.map((x) => (x.id === id ? ({ ...x, label } as typeof x) : x)),
            });
          }}
        />
        {tip && !entry ? (
          <div className="cursor-tip" style={{ left: tip.x, top: tip.y }}>
            {tip.text}
          </div>
        ) : null}
        {entry && ENTRY_FIELDS[ui.tool] ? (
          <DrawEntry
            tool={ui.tool}
            entry={entry}
            setEntry={setEntry}
            inputs={entryInputs}
            at={cursorScreen.current}
            valueOf={valueOf}
            onPlace={finishEntry}
          />
        ) : null}
      </div>
      <ConstraintPalette open={phoneConstraints} />
      <SketchHud
        sketch={sketch}
        diag={diag}
        tool={ui.tool}
        hint={toolHint(ui.tool, ts.points.length, !!ts.dimFirst)}
        sectionCount={sections.length}
        onRepeat={repeatSelection}
        onTraceAll={() => traceSection(sections)}
      />
    </>
  );
}

export { activeSketch };
