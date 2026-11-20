/**
 * Pointer input of the sketch editor: hover and previews while moving, dragging points, box selection,
 * and what a click does with each tool. Mouse, pen and fingers arrive as pointer events.
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import type { Expr, SketchFeature } from "@meercad/schema";
import type { SectionChain } from "@meercad/kernel/fit";
import {
  distance2,
  type ResolvedConstraint,
  type SketchSolver,
  type SolvedCurve,
  type SolvedSketch,
  type Vec2,
} from "@meercad/sketch";
import { perFrame, type Viewport } from "@meercad/viewport";
import { Press } from "../../lib/gestures";
import { rightClick } from "../../lib/keymap";
import { edgeSelectorForPick } from "../../lib/topology";
import { t } from "../../lib/i18n";
import { toast, useApp } from "../../store";
import { writeSketch } from "../actions";
import { chainAt } from "../section";
import { sameSel, setSketchSelection, useSketchUi, type SketchSel, type SketchTool } from "../state";
import {
  applySolution,
  connectedCurves,
  curvePointIds,
  curveSamples,
  parseSel,
  pointEntries,
  refsOfEntity,
} from "./geometry";
import { hitHandle, tangentFor, withTangent, type TangentHandle } from "./handles";
import { draftBuilder } from "./shapes";
import { DRAG_TOOLS, drawingTip, picksGeometry, POINT_TOOLS, unwrapSweep } from "./tools";
import type { Draft, Entry, Snap, ToolState } from "./types";

/** The text beside the cursor, in pixels from the canvas's corner. */
export interface Tip {
  x: number;
  y: number;
  text: string;
}

/** What the editor gives its pointer input: the sketch as shown, and the actions clicks trigger. */
export interface PointerEditor {
  viewport: Viewport;
  sketch: SketchFeature | undefined;
  shown: SolvedSketch | null;
  solver: SketchSolver | null;
  constraints: ResolvedConstraint[];
  external: SolvedCurve[];
  ts: ToolState;
  sections: SectionChain[];
  hoverChain: number;
  cursorScreen: MutableRefObject<{ x: number; y: number }>;
  /** One screen pixel in sketch units. */
  px: () => number;
  toSketch: (event: { clientX: number; clientY: number }) => Vec2 | null;
  snap: (p: Vec2, exclude?: Set<string>, from?: Vec2, free?: boolean) => Snap;
  hitPoint: (p: Vec2, tol: number) => string | null;
  hitCurve: (p: Vec2, tol: number) => SolvedCurve | null;
  /** Tangent knobs of the selected splines. */
  handles: TangentHandle[];
  setHoverHandle: (h: TangentHandle | null) => void;
  rerender: () => void;
  setDrag: (solved: SolvedSketch | null) => void;
  setHover: (hover: SketchSel | null) => void;
  setHoverChain: (i: number) => void;
  setTip: (tip: Tip | null) => void;
  setEntry: (entry: Entry | null) => void;
  commit: (next: Draft, merge?: boolean) => unknown;
  confirmStep: () => void;
  lineTo: (snap: Snap, length?: Expr) => void;
  addRect: (a: Snap, b: Snap, centered: boolean) => void;
  addCircle: (center: Snap, r: number) => void;
  addArc: (center: Snap, s: Snap, e: Snap, ccw: boolean) => void;
  add3PointArc: (a: Snap, b: Snap, m: Vec2) => void;
  addPolygon: (center: Snap, corner: Vec2) => void;
  addPoint: (snap: Snap) => void;
  finishSpline: (closed?: boolean) => void;
  trimAt: (p: Vec2) => void;
  cornerAt: (p: Vec2, kind: "fillet" | "chamfer") => void;
  offsetAt: (p: Vec2) => void;
  addDimension: (a: SketchSel, b: SketchSel | null, at: Vec2) => void;
  traceSection: (chains: SectionChain[]) => void;
}

/** A press in progress, the points being dragged and the selection box; kept across re-renders. */
interface Gesture {
  down: {
    x: number;
    y: number;
    p: Vec2;
    target: SketchSel | null;
    /** The tangent knob pressed (select tool). */
    handle: TangentHandle | null;
    moved: boolean;
    started: boolean;
  } | null;
  dragState: { ids: string[]; start: Vec2; origin: Map<string, Vec2>; solved: SolvedSketch | null } | null;
  /** A tangent knob being dragged, and the tangent it gives so far. */
  handleDrag: { handle: TangentHandle; tangent: [number, number] | null; solved: SolvedSketch | null } | null;
  box: { a: Vec2; b: Vec2 } | null;
  /** Where the right button went down: released there, it is a right click (not a drag). */
  right: { x: number; y: number } | null;
  /**
   * The fingers on the view. Kept with the gesture: the handlers are made anew on every render,
   * which a drag causes, and a second finger must still be seen as the second.
   */
  touches: Set<number>;
}

type MoveFrame = ReturnType<typeof perFrame<PointerEvent>>;

/** A press that moves less than this stays a click (pixels). */
const CLICK_SLOP = 4;
/** A drawing tool's press moved further than this drew a shape (pixels). */
const DRAWN_BY_DRAG = 6;
/** Pick distances, in screen pixels. */
const PICK_PIXELS = { point: 9, curve: 7, section: 10, closeSpline: 6, newPoint: 2, handle: 11 };

/** Subscribes the editor's pointer input to the canvas; it re-subscribes on every render. */
export function useSketchPointer(editor: PointerEditor) {
  const gesture = useRef<Gesture>({
    down: null,
    dragState: null,
    handleDrag: null,
    box: null,
    right: null,
    touches: new Set(),
  });
  const pressRef = useRef(new Press(() => {}));
  // Moves are handled once per frame by whichever moveCursor the latest render installed.
  const moveRef = useRef<(event: PointerEvent) => void>(() => {});
  const moveFrame = useRef(perFrame((event: PointerEvent) => moveRef.current(event))).current;
  useEffect(() => {
    // Gesture state lives in a ref: this effect re-subscribes on every render, which may happen mid-drag.
    const pointer = new SketchPointer(editor, gesture.current, pressRef.current, moveFrame);
    moveRef.current = pointer.moveCursor;

    return pointer.listen();
  });
}

/** One render's pointer handlers. */
class SketchPointer {
  constructor(
    private readonly ed: PointerEditor,
    private readonly g: Gesture,
    /** Fingers navigate here. Before any pen was used, a still tap stands in for a click. */
    private readonly press: Press,
    private readonly moveFrame: MoveFrame,
  ) {}

  private get element() {
    return this.ed.viewport.canvas;
  }

  /** Adds the listeners; the returned function removes them. */
  listen(): () => void {
    const element = this.element;
    element.addEventListener("pointermove", this.onMove);
    element.addEventListener("pointerdown", this.onDown);
    element.addEventListener("pointerup", this.onUp);
    element.addEventListener("pointercancel", this.onCancel);
    element.addEventListener("dblclick", this.onDbl);
    element.addEventListener("pointerleave", this.onLeave);

    return () => {
      element.removeEventListener("pointermove", this.onMove);
      element.removeEventListener("pointerdown", this.onDown);
      element.removeEventListener("pointerup", this.onUp);
      element.removeEventListener("pointercancel", this.onCancel);
      element.removeEventListener("dblclick", this.onDbl);
      element.removeEventListener("pointerleave", this.onLeave);
    };
  }

  /**
   * Without a Pencil (iPhone, or an iPad used by finger) one finger draws and drags like the pen;
   * two fingers pan and zoom. Once a Pencil has been used, fingers only navigate.
   */
  private fingerDraws() {
    return !this.ed.viewport.penSeen;
  }

  /** The tangent knob under the cursor (select tool), unless a sketch point is nearer. */
  private handleAt(p: Vec2): TangentHandle | null {
    const { handles, hitPoint, shown, px } = this.ed;
    if (!handles.length || useSketchUi.getState().tool !== "select") return null;

    const pt = hitPoint(p, px() * PICK_PIXELS.point);
    const q = pt ? shown?.points.get(pt) : undefined;

    return hitHandle(handles, p, px() * PICK_PIXELS.handle, q ? distance2(p, q) : Infinity);
  }

  /** The sketch point or curve under the cursor; curves win over the origin. */
  private targetAt(p: Vec2): SketchSel | null {
    const { hitPoint, hitCurve, px } = this.ed;
    const pt = hitPoint(p, px() * PICK_PIXELS.point);
    if (pt && pt !== "origin") return { kind: "point", id: pt };

    const curve = hitCurve(p, px() * PICK_PIXELS.curve);
    if (curve) return { kind: "curve", id: curve.id };
    if (pt) return { kind: "point", id: pt };

    return null;
  }

  // ---------------------------------------------------------------- events

  private onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") this.press.move(event);

    if (event.pointerType !== "touch" || (this.fingerDraws() && this.g.touches.size === 1)) {
      this.moveFrame(event);
    }
  };

  private onDown = (event: PointerEvent) => {
    this.moveFrame.flush();

    if (event.pointerType === "mouse" && event.button === 2) {
      this.g.right = { x: event.clientX, y: event.clientY };
    }

    if (event.pointerType !== "mouse") this.press.down(event);

    if (event.pointerType === "touch") {
      this.g.touches.add(event.pointerId);
      if (!this.fingerDraws()) return;
      // A second finger means navigating: drop what the first one started.
      if (this.g.touches.size > 1) return this.dropGesture();
    }

    this.start(event);
  };

  private onUp = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button === 2) {
      const r = this.g.right;
      this.g.right = null;

      if (
        r &&
        Math.hypot(event.clientX - r.x, event.clientY - r.y) <= CLICK_SLOP &&
        rightClick() === "confirm"
      ) {
        this.ed.confirmStep();
      }

      return;
    }

    if (event.pointerType !== "touch") this.moveFrame.flush();

    const r = event.pointerType === "mouse" ? null : this.press.up(event);
    if (event.pointerType === "touch") this.g.touches.delete(event.pointerId);

    if (event.pointerType !== "touch" || this.fingerDraws()) {
      this.finish(event);
      if (r === "double") this.onDbl(event);
    }
  };

  private onDbl = (event: MouseEvent) => {
    const { ts, setTip, rerender, toSketch, sketch } = this.ed;
    const tool = useSketchUi.getState().tool;

    if (tool === "line") {
      ts.points = [];
      setTip(null);
      rerender();
    }

    if (tool === "spline") return this.ed.finishSpline();

    const p = toSketch(event);

    // A double-click on a tangent knob makes the tangent automatic again.
    const knob = p && sketch ? this.handleAt(p) : null;

    if (knob && sketch) {
      this.ed.commit({
        entities: withTangent(sketch.entities, knob.spline, knob.index, null),
        constraints: sketch.constraints,
      });

      return;
    }

    if (tool === "select" && p) {
      const selection = this.targetAt(p);

      if (selection?.kind === "curve" && sketch) {
        // Select the whole connected chain.
        setSketchSelection(connectedCurves(sketch, selection.id).map((id) => ({ kind: "curve", id })));
      }
    }
  };

  private onCancel = (event: PointerEvent) => {
    this.press.up(event);
    this.g.touches.delete(event.pointerId);
  };

  private onLeave = () => {
    this.moveFrame.cancel();
    this.ed.setTip(null);
    this.ed.setHover(null);
    this.ed.ts.snap = null;
    this.ed.rerender();
  };

  private dropGesture() {
    const g = this.g;
    g.down = null;
    g.box = null;

    if (g.dragState || g.handleDrag) {
      g.dragState = null;
      g.handleDrag = null;
      this.ed.setDrag(null);
    }

    this.ed.ts.snap = null;
    this.ed.rerender();
  }

  // ---------------------------------------------------------------- moving

  /** A move, once per frame: drags or grows the box while selecting, otherwise hovers and previews. */
  moveCursor = (event: PointerEvent) => {
    const { toSketch, shown, cursorScreen } = this.ed;
    const p = toSketch(event);
    if (!p || !shown) return;

    const g = this.g;
    const tool = useSketchUi.getState().tool;
    const rect = this.element.getBoundingClientRect();
    cursorScreen.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    if (g.down && event.buttons === 1 && tool === "select") return this.moveWhileSelecting(event, p, shown);
    if (event.buttons && !g.down?.started) return;

    this.previewTool(event, p, tool, rect);
  };

  /** With the select tool held down: drag what was pressed, or span a selection box from empty space. */
  private moveWhileSelecting(event: PointerEvent, p: Vec2, shown: SolvedSketch) {
    const { solver, sketch, ts } = this.ed;
    const g = this.g;
    const down = g.down!;
    if (!down.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) < CLICK_SLOP) return;

    down.moved = true;

    if (down.handle) return this.dragHandle(p, down.handle);

    if (
      down.target &&
      !g.dragState &&
      solver &&
      sketch &&
      !this.startDrag(down.target, down.p, sketch, shown)
    ) {
      return;
    }

    if (g.dragState && solver && sketch) return this.dragTo(event, p, solver, sketch, shown);

    if (!down.target) {
      g.box = { a: down.p, b: p };
      ts.cursor = p;
      ts.points = [{ pos: g.box.a }, { pos: g.box.b }];
      this.ed.rerender();
    }
  }

  /** Starts dragging the pressed point or curve's points; false if none of them can move. */
  private startDrag(target: SketchSel, start: Vec2, sketch: SketchFeature, shown: SolvedSketch): boolean {
    const ids = target.kind === "point" ? [target.id] : curvePointIds(sketch, target.id);
    const movable = ids.filter((id) => sketch.entities.some((x) => x.id === id && x.type === "point"));
    if (!movable.length) return false;

    this.g.dragState = {
      ids: movable,
      start,
      origin: new Map(movable.map((id) => [id, shown.points.get(id)!])),
      solved: null,
    };

    return true;
  }

  /**
   * Moves the dragged points by the cursor's way and solves with them as targets; a single point
   * snaps like a new one, and Alt on a circle drags its radius instead.
   */
  private dragTo(
    event: PointerEvent,
    p: Vec2,
    solver: SketchSolver,
    sketch: SketchFeature,
    shown: SolvedSketch,
  ) {
    const { ts, snap } = this.ed;
    const g = this.g;
    const dragState = g.dragState!;
    const dx = p[0] - dragState.start[0];
    const dy = p[1] - dragState.start[1];
    const targets: Record<string, Vec2> = {};

    for (const id of dragState.ids) {
      const o = dragState.origin.get(id)!;
      targets[id] = [o[0] + dx, o[1] + dy];
    }

    // A single dragged point snaps like a newly drawn one.
    if (dragState.ids.length === 1) {
      const id = dragState.ids[0]!;
      const exclude = new Set([
        id,
        ...sketch.entities.filter((x) => x.type !== "point" && refsOfEntity(x).includes(id)).map((x) => x.id),
      ]);
      const sn = snap(targets[id]!, exclude, undefined, event.altKey);
      targets[id] = sn.pos;
      ts.snap = sn;
      ts.cursor = sn.pos;
    }

    const radiusDrag =
      g.down!.target?.kind === "curve" &&
      sketch.entities.find((x) => x.id === g.down!.target!.id)?.type === "circle" &&
      event.altKey;
    const solved = solver.solve(
      { entities: sketch.entities, constraints: this.ed.constraints, external: this.ed.external },
      radiusDrag
        ? {
            dragRadius: {
              curve: g.down!.target!.id,
              radius: Math.hypot(
                p[0] - shown.points.get(curvePointIds(sketch, g.down!.target!.id)[0]!)![0],
                p[1] - shown.points.get(curvePointIds(sketch, g.down!.target!.id)[0]!)![1],
              ),
            },
          }
        : { drag: targets },
    );
    dragState.solved = solved;
    this.ed.setDrag(solved);
  }

  /** Gives the dragged knob's point the tangent towards the cursor and shows the curve with it. */
  private dragHandle(p: Vec2, handle: TangentHandle) {
    const { solver, sketch } = this.ed;
    if (!solver || !sketch) return;

    const tangent = tangentFor(handle, p);
    const solved = solver.solve({
      entities: withTangent(sketch.entities, handle.spline, handle.index, tangent),
      constraints: this.ed.constraints,
      external: this.ed.external,
    });
    this.g.handleDrag = { handle, tangent, solved };
    this.ed.setDrag(solved);
  }

  /** Keeps the tangent the knob was dragged to. */
  private endHandleDrag(sketch: SketchFeature) {
    const { handle, tangent, solved } = this.g.handleDrag!;
    this.g.handleDrag = null;
    this.ed.setDrag(null);

    if (solved?.diagnostics.ok) {
      this.ed.commit({
        entities: withTangent(sketch.entities, handle.spline, handle.index, tangent),
        constraints: sketch.constraints,
      });
    }
  }

  /** Hover highlight, the snapped cursor and the tool's preview and tip. */
  private previewTool(event: PointerEvent, p: Vec2, tool: SketchTool, rect: DOMRect) {
    const { ts, setTip, px } = this.ed;
    const knob = this.handleAt(p);
    this.ed.setHoverHandle(knob);

    if (knob) {
      this.ed.setHover(null);
      ts.cursor = p;
      ts.snap = null;
      setTip({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        text: t("Drag to bend · double-click: automatic"),
      });
      this.ed.rerender();

      return;
    }

    this.ed.setHover(picksGeometry(tool) ? this.targetAt(p) : null);
    if (tool === "project") return;

    if (tool === "section") {
      const i = chainAt(this.ed.sections, p, px() * PICK_PIXELS.section);
      if (i !== this.ed.hoverChain) this.ed.setHoverChain(i);

      return;
    }

    const s: Snap = picksGeometry(tool)
      ? { pos: p }
      : this.ed.snap(p, undefined, tool === "line" ? ts.points[0]?.pos : undefined, event.altKey);
    ts.cursor = s.pos;
    // Tools that place points show where the next one will land.
    ts.snap = POINT_TOOLS.has(tool) ? s : null;

    if (tool === "arc_center" && ts.points.length === 2) {
      ts.sweep = unwrapSweep(ts.sweep, ts.points[0]!.pos, ts.points[1]!.pos, s.pos);
    }

    const text = drawingTip(tool, ts.points, s);
    setTip(text === null ? null : { x: event.clientX - rect.left, y: event.clientY - rect.top, text });
    this.ed.rerender();
  }

  // ---------------------------------------------------------------- pressing and releasing

  /** A press: drawing tools place their first point now, so a shape can be dragged out. */
  private start(event: PointerEvent) {
    if (event.button !== 0) return;

    const { ts, toSketch, snap } = this.ed;
    const p = toSketch(event);
    if (!p) return;

    const tool = useSketchUi.getState().tool;
    // Drawing tools start on press, so a shape can be dragged out as well as clicked twice.
    const started = DRAG_TOOLS.has(tool) && !ts.points.length;

    if (started) {
      ts.points = [snap(p, undefined, undefined, event.altKey)];
      this.ed.setEntry(null);
    }

    const handle = started ? null : this.handleAt(p);
    this.g.down = {
      x: event.clientX,
      y: event.clientY,
      p,
      target: handle ? null : this.targetAt(p),
      handle,
      moved: false,
      started,
    };

    // A finger tap is replayed after it lifted, when its pointer can no longer be captured.
    if ((tool === "select" || started) && (event.pointerType !== "touch" || this.fingerDraws())) {
      try {
        this.element.setPointerCapture(event.pointerId);
      } catch {
        // the pointer is already gone (a tap replayed after it lifted)
      }
    }
  }

  /** A release: ends a drag or a box, or is a click for the active tool. */
  private finish(event: PointerEvent) {
    const g = this.g;
    if (event.button !== 0 || !g.down) return;

    const d = g.down;
    g.down = null;

    const { toSketch, sketch, ts, snap } = this.ed;
    const p = toSketch(event);
    if (!p || !sketch) return;

    const tool = useSketchUi.getState().tool;
    if (g.handleDrag) return this.endHandleDrag(sketch);
    if (d.handle) return;
    if (g.dragState) return this.endDrag(sketch);
    if (g.box) return this.endBox(event, sketch);
    if (d.moved && tool === "select") return;

    const dragged = d.started && Math.hypot(event.clientX - d.x, event.clientY - d.y) > DRAWN_BY_DRAG;
    // A plain click on a drawing tool only placed the first point (on press).
    if (d.started && !dragged) return this.ed.rerender();

    const s = snap(p, undefined, tool === "line" ? ts.points[0]?.pos : undefined, event.altKey);
    this.click(tool, event, p, s, d.target, dragged, sketch);
  }

  /** Keeps the dragged points where the solver put them, if it found a solution. */
  private endDrag(sketch: SketchFeature) {
    const g = this.g;
    const solved = g.dragState!.solved;
    g.dragState = null;
    this.ed.ts.snap = null;
    this.ed.setDrag(null);

    if (solved?.diagnostics.ok) {
      this.ed.commit({ entities: applySolution(sketch.entities, solved), constraints: sketch.constraints });
    }
  }

  /** Selects the points and whole curves inside the box; Shift adds them to the selection. */
  private endBox(event: PointerEvent, sketch: SketchFeature) {
    const g = this.g;
    const shown = this.ed.shown!;
    const box = g.box!;
    const [x0, x1] = [Math.min(box.a[0], box.b[0]), Math.max(box.a[0], box.b[0])];
    const [y0, y1] = [Math.min(box.a[1], box.b[1]), Math.max(box.a[1], box.b[1])];
    const inside = (q: Vec2) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
    const sel: SketchSel[] = [];

    for (const [id, q] of pointEntries(sketch, shown)) {
      if (id !== "origin" && inside(q)) sel.push({ kind: "point", id });
    }

    for (const curve of shown.curves) {
      if (curveSamples(curve).every(inside)) sel.push({ kind: "curve", id: curve.id });
    }

    g.box = null;
    this.ed.ts.points = [];
    setSketchSelection(event.shiftKey ? [...useSketchUi.getState().selection, ...sel] : sel);
  }

  /** A click with the active tool at `p`, which snapped to `s`. */
  private click(
    tool: SketchTool,
    event: PointerEvent,
    p: Vec2,
    s: Snap,
    target: SketchSel | null,
    dragged: boolean,
    sketch: SketchFeature,
  ) {
    const ed = this.ed;

    switch (tool) {
      case "pattern":
      case "select":
        return this.select(target, event);
      case "line":
        return this.clickLine(s, dragged);
      case "rect":
      case "rect_center":
        return this.clickTwice(s, (first) => ed.addRect(first, s, tool === "rect_center"));
      case "circle":
        return this.clickTwice(s, (first) => ed.addCircle(first, distance2(first.pos, s.pos)));
      case "arc_center":
        return this.clickArcCenter(s);
      case "arc":
        return this.clickArc(s);
      case "point":
        return ed.addPoint(s);
      case "spline":
        return this.clickSpline(s);
      case "polygon":
        return this.clickTwice(s, (first) => ed.addPolygon(first, s.pos));
      case "trim":
        return ed.trimAt(p);
      case "fillet":
      case "chamfer":
        return ed.cornerAt(p, tool);
      case "offset":
        return ed.offsetAt(p);
      case "dimension":
        return this.clickDimension(p);
      case "section":
        return this.clickSection(p);
      case "project":
        return this.clickProject(event, sketch);
    }
  }

  /** Selects what was pressed; Shift, Cmd or Ctrl toggle it in the selection. */
  private select(selection: SketchSel | null, event: PointerEvent) {
    const cur = useSketchUi.getState().selection;
    if (!selection) return setSketchSelection([]);

    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      setSketchSelection(
        cur.some((x) => sameSel(x, selection))
          ? cur.filter((x) => !sameSel(x, selection))
          : [...cur, selection],
      );
    } else {
      setSketchSelection([selection]);
    }
  }

  /** The line tool: the first click starts, every further one draws a line and goes on from there. */
  private clickLine(s: Snap, dragged: boolean) {
    const { ts, setTip, rerender } = this.ed;

    if (!ts.points.length) {
      ts.points = [s];

      return rerender();
    }

    this.ed.lineTo(s);

    // A dragged line stands alone; clicked lines keep chaining.
    if (dragged) {
      ts.points = [];
      setTip(null);
    }

    rerender();
  }

  /** Shapes from two points: the first click places one, the second draws the shape. */
  private clickTwice(s: Snap, draw: (first: Snap) => void) {
    const { ts, setTip, rerender } = this.ed;

    if (!ts.points.length) {
      ts.points = [s];
    } else {
      draw(ts.points[0]!);
      ts.points = [];
      setTip(null);
    }

    rerender();
  }

  /** Centre, start, then the end (the way the cursor went round sets the direction). */
  private clickArcCenter(s: Snap) {
    const { ts, setTip, rerender } = this.ed;

    if (ts.points.length < 2) {
      ts.points = [...ts.points, s];
      ts.sweep = 0;
    } else {
      this.ed.addArc(ts.points[0]!, ts.points[1]!, s, ts.sweep >= 0);
      ts.points = [];
      setTip(null);
    }

    rerender();
  }

  /** Start, end (clicked or dragged out), then a third click sets how far it bulges. */
  private clickArc(s: Snap) {
    const { ts, setTip, rerender, px } = this.ed;

    if (ts.points.length < 2) {
      const last = ts.points[ts.points.length - 1];

      if (!last || distance2(last.pos, s.pos) > px() * PICK_PIXELS.newPoint) {
        ts.points = [...ts.points, s];
      }
    } else {
      this.ed.add3PointArc(ts.points[0]!, ts.points[1]!, s.pos);
      ts.points = [];
      setTip(null);
    }

    rerender();
  }

  /** A spline's next point; clicking the first point again closes the curve. */
  private clickSpline(s: Snap) {
    const { ts, rerender, px } = this.ed;
    const first = ts.points[0];
    const onFirst =
      first &&
      ts.points.length >= 3 &&
      (s.point ? s.point === first.point : distance2(first.pos, s.pos) < px() * PICK_PIXELS.closeSpline);
    if (onFirst) return this.ed.finishSpline(true);

    const last = ts.points[ts.points.length - 1];

    if (!last || distance2(last.pos, s.pos) > px() * PICK_PIXELS.newPoint) {
      ts.points = [...ts.points, s];
    }

    rerender();
  }

  /**
   * The dimension tool: the first click picks what to dimension, an optional second the other end,
   * and a click into empty space places the dimension.
   */
  private clickDimension(p: Vec2) {
    const { ts, rerender } = this.ed;
    const selection = this.targetAt(p);

    if (!ts.dimFirst) {
      if (!selection) return;

      ts.dimFirst = selection;
      setSketchSelection([selection]);

      // A single line/circle/arc gets its dimension placed on the next click.
      return rerender();
    }

    if (
      selection &&
      !(selection.kind === ts.dimFirst.kind && selection.id === ts.dimFirst.id) &&
      !ts.points.length
    ) {
      ts.points = [{ pos: p, point: `${selection.kind}:${selection.id}` }];
      setSketchSelection([ts.dimFirst, selection]);

      return rerender();
    }

    const second = ts.points[0]?.point ? parseSel(ts.points[0].point) : null;
    this.ed.addDimension(ts.dimFirst, second, p);
    ts.dimFirst = null;
    ts.points = [];
    setSketchSelection([]);
    rerender();
  }

  /** Traces the mesh section under the click into sketch curves. */
  private clickSection(p: Vec2) {
    const { sections, px } = this.ed;
    const i = chainAt(sections, p, px() * PICK_PIXELS.section);

    if (i < 0) {
      return toast(
        sections.length
          ? t("Click the orange section line of the mesh")
          : t("The sketch plane does not cut a mesh part. Sketch on a plane through the part."),
        "error",
      );
    }

    this.ed.traceSection([sections[i]!]);
  }

  /** Projects the clicked model edge into the sketch as fixed reference geometry. */
  private clickProject(event: PointerEvent, sketch: SketchFeature) {
    const pick = this.ed.viewport.pick(event.clientX, event.clientY, new Set(["edge"]));
    const sel = pick ? edgeSelectorForPick(pick, useApp.getState().output?.meshes ?? []) : null;
    if (!sel) return toast(t("Click a model edge to project it into the sketch"), "error");

    const builder = draftBuilder(sketch);
    builder.entity({ type: "projection", edges: [sel] }, "pr");
    writeSketch(builder.draft);
  }
}
