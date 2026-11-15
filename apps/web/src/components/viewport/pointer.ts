/**
 * Mouse, touch and pen input on the 3D view (sketch mode is handled by the sketch editor): hover,
 * clicks and double clicks, dragging a selection box, the context menu, and the touch gestures.
 *
 * Touch and pen: a tap selects one item after another and a tap on empty space deselects; holding
 * opens the context menu, holding and then dragging selects an area. A finger double tap turns the view
 * to the face, a pen double tap selects the whole part. Swiping three fingers sideways (or tapping two /
 * three) undoes and redoes.
 */
import { perFrame, samePick, type Pick, type Viewport } from "@meercad/viewport";
import type { Dispatch, SetStateAction } from "react";
import { selectParts } from "../../lib/clipboard";
import { MultiTouch, Press, type PressResult } from "../../lib/gestures";
import { rightClick } from "../../lib/keymap";
import { meshBodyIds } from "../../lib/meshParts";
import { previewPlace, useTerrainPlace } from "../../lib/terrain";
import { finishMarking, useTerrainDraw, useTerrainMeasure } from "../../lib/terrainDraw";
import { commitDialog, editFeature, redo, undo, useApp } from "../../store";
import { closeMenu } from "../Menu";
import { clickInView, DEFAULT_KINDS, pickKinds } from "./click";
import { openContextMenu } from "./contextMenu";
import { featureOfPick } from "./scene";

/** What a selection box takes: faces and edges, or one of them. */
export type BoxFilter = "all" | "face" | "edge";

/** A selection box being dragged, in pixels from the view's corner. */
export interface SelectionBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  filter: BoxFilter;
}

/** Two clicks this close in time (ms) are a double-click. */
const DOUBLE_MS = 400;
/** A press that moves further than this (px) is a drag, not a click. */
const CLICK_SLOP = 4;
/** The second click of a double-click lands within this (px) of the first. */
const DOUBLE_SLOP = 6;

/** The filter after a key while box-selecting: F = faces only, E = edges only, Tab cycles. */
export function nextBoxFilter(key: string, filter: BoxFilter): BoxFilter {
  return key === "f"
    ? "face"
    : key === "e"
      ? "edge"
      : filter === "all"
        ? "face"
        : filter === "face"
          ? "edge"
          : "all";
}

/**
 * In a scheme where a right click confirms: finishes the open tool or the measurement. False when nothing
 * ran.
 */
function confirmByRightClick(): boolean {
  if (rightClick() !== "confirm") return false;

  const state = useApp.getState();
  if (state.dialog) commitDialog();
  else if (state.measure.active) useApp.setState({ measure: { active: false, picks: [], result: null } });
  else return false;

  return true;
}

/** The pointer handling of one viewport, from attach() until the function it returns is called. */
export class ViewPointer {
  private readonly element: HTMLCanvasElement;
  /** Where a mouse or pen press went down, and whether it was on empty space. */
  private down: { x: number; y: number; button: number; empty: boolean } | null = null;
  /** The last plain click, to catch the second click of a double-click on a face. */
  private lastClick: { at: number; x: number; y: number; body: string | null } | null = null;
  private doubleDone = -Infinity;
  private filter: BoxFilter = "all";
  /** Where a long press that turned into an area selection started. */
  private area: { x: number; y: number } | null = null;
  private boxNow: SelectionBox | null = null;
  /** True while a long press has switched off orbiting, so the finger drags out an area. */
  private navOff = false;
  private readonly press: Press;
  private readonly multi: MultiTouch;
  /** Hover picking and box sizing raycast the model: once per frame is plenty. */
  private readonly moveFrame: ReturnType<typeof perFrame<PointerEvent>>;

  constructor(
    private readonly viewport: Viewport,
    private readonly boxRef: { readonly current: SelectionBox | null },
    private readonly setBox: Dispatch<SetStateAction<SelectionBox | null>>,
    private readonly fitKey: string | undefined,
  ) {
    this.element = viewport.canvas;
    this.press = new Press(
      (x, y, event) => this.longPress(x, y, event),
      (x, y) => this.longPressDrag(x, y),
    );
    this.multi = new MultiTouch((g) => {
      if (g === "swipe-left" || g === "tap2") undo();
      else redo();
    });
    this.moveFrame = perFrame((event: PointerEvent) => this.frameMove(event));
  }

  /** Starts listening; the returned function stops. */
  attach(): () => void {
    const element = this.element;
    window.addEventListener("keydown", this.onKey, true);
    element.addEventListener("pointermove", this.onMove);
    element.addEventListener("pointerdown", this.onDown);
    element.addEventListener("pointerup", this.onUp);
    element.addEventListener("pointercancel", this.onCancel);
    element.addEventListener("dblclick", this.onDbl);

    return () => {
      element.removeEventListener("pointermove", this.onMove);
      element.removeEventListener("pointerdown", this.onDown);
      element.removeEventListener("pointerup", this.onUp);
      element.removeEventListener("pointercancel", this.onCancel);
      element.removeEventListener("dblclick", this.onDbl);
      window.removeEventListener("keydown", this.onKey, true);
      this.press.cancel();
      this.moveFrame.cancel();
      this.restoreNav();
    };
  }

  private readonly onKey = (event: KeyboardEvent) => {
    if (!this.boxRef.current) return;

    const k = event.key.toLowerCase();

    // While box-selecting, F = faces only, E = edges only, Tab cycles.
    if (k === "f" || k === "e" || k === "tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.filter = nextBoxFilter(k, this.filter);
      this.setBox((b) => (b ? { ...b, filter: this.filter } : b));
    }
  };

  /** Holding still: the context menu; should the finger move on, it drags out an area instead of orbiting. */
  private longPress(x: number, y: number, event: PointerEvent): void {
    if (useApp.getState().sketchId || this.boxRef.current) return;

    this.down = null;
    openContextMenu(this.viewport, this.fitKey, this.viewport.pick(x, y, pickKinds()), x, y);

    if (event.pointerType === "touch") {
      this.navOff = true;
      this.viewport.controls.enabled = false;
    }
  }

  /** Holding and then dragging: an area selection from where the press started. */
  private longPressDrag(x: number, y: number): void {
    if (useApp.getState().dialog) return;

    closeMenu();
    this.area = { x, y };
    this.filter = "all";
  }

  private readonly onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") {
      this.press.move(event);
      this.multi.move(event);
    }

    if ((event.pointerType === "touch" && !this.area) || useApp.getState().sketchId) return;

    this.moveFrame(event);
  };

  private showBox(x0: number, y0: number, event: PointerEvent): void {
    const rect = this.element.getBoundingClientRect();
    this.boxNow = {
      x0: x0 - rect.left,
      y0: y0 - rect.top,
      x1: event.clientX - rect.left,
      y1: event.clientY - rect.top,
      filter: this.filter,
    };
    this.setBox(this.boxNow);
  }

  /** Once per frame while the pointer moves: size the box, follow the ground, or hover-pick. */
  private frameMove(event: PointerEvent): void {
    if (this.area) return this.showBox(this.area.x, this.area.y, event);

    const d = this.down;

    if (
      d &&
      d.button === 0 &&
      d.empty &&
      event.buttons === 1 &&
      !useApp.getState().dialog &&
      Math.hypot(event.clientX - d.x, event.clientY - d.y) > CLICK_SLOP
    ) {
      this.press.cancel();

      return this.showBox(d.x, d.y, event);
    }

    if (event.buttons) return;
    if (this.followGround(event)) return;

    this.viewport.setHover(this.viewport.pick(event.clientX, event.clientY, pickKinds()));
  }

  /**
   * Setting a part onto the terrain or drawing on it: the ground under the pointer is what counts. True
   * when that is all the pointer does now.
   */
  private followGround(event: PointerEvent): boolean {
    const ms = useTerrainMeasure.getState();
    const measuring = ms.scale || (useApp.getState().measure.active && ms.points.length === 1);
    if (!useTerrainPlace.getState().body && !useTerrainDraw.getState().kind && !measuring) return false;

    const hit = this.viewport.sceneryHit(event.clientX, event.clientY);
    if (useTerrainPlace.getState().body && hit) previewPlace(hit.point);
    if (useTerrainDraw.getState().kind) useTerrainDraw.setState({ hover: hit?.point ?? null });
    if (measuring) useTerrainMeasure.setState({ hover: hit?.point ?? null });

    return !measuring || !!ms.scale;
  }

  /** Selects what the box takes (adding to the selection with Shift). */
  private finishBox(additive: boolean): void {
    const b = this.boxNow ? { ...this.boxNow, filter: this.filter } : this.boxRef.current;
    this.boxNow = null;
    if (!b) return;

    this.setBox(null);

    const picks = this.picksInBox(b);
    const cur = useApp.getState().selection;
    useApp.setState({
      selection: additive ? [...cur, ...picks.filter((pick) => !cur.some((c) => samePick(c, pick)))] : picks,
      selectedFeature: null,
    });
  }

  /** The faces and edges in the box; mesh parts' triangles are skipped (they are picked as whole parts). */
  private picksInBox(b: SelectionBox): Pick[] {
    const rect = this.element.getBoundingClientRect();
    const enclosed = b.x1 >= b.x0;
    const ks = new Set<"face" | "edge">(b.filter === "all" ? ["face", "edge"] : [b.filter]);
    const meshParts = meshBodyIds(useApp.getState().doc.features, useApp.getState().output?.meshes ?? []);

    return this.viewport
      .boxSelect(b.x0 + rect.left, b.y0 + rect.top, b.x1 + rect.left, b.y1 + rect.top, enclosed, ks)
      .filter((pick) => !((pick.kind === "face" || pick.kind === "edge") && meshParts.has(pick.bodyId)));
  }

  private restoreNav(): void {
    if (!this.navOff) return;

    this.navOff = false;
    this.viewport.controls.enabled = true;
  }

  private readonly onDown = (event: PointerEvent) => {
    this.multi.down(event);
    if (event.pointerType !== "mouse" && !useApp.getState().sketchId) this.press.down(event);
    if (event.pointerType === "touch") return;

    this.moveFrame.cancel();
    this.filter = "all";
    this.down = {
      x: event.clientX,
      y: event.clientY,
      button: event.button,
      empty: event.button === 0 && !this.viewport.pick(event.clientX, event.clientY, pickKinds()),
    };
  };

  private readonly onUp = (event: PointerEvent) => {
    const gesture = event.pointerType === "mouse" ? null : this.press.up(event);
    this.multi.up(event);
    this.restoreNav();

    if (this.area) {
      this.moveFrame.flush();
      this.area = null;
      this.down = null;

      return this.finishBox(false);
    }

    if (event.pointerType === "touch") return this.touchUp(event, gesture);

    this.moveFrame.flush();

    const d = this.down;
    this.down = null;
    if (gesture === "double" && event.pointerType === "pen") return this.onDbl(event);
    if (this.boxNow || this.boxRef.current) return this.finishBox(event.shiftKey);

    if (
      !d ||
      useApp.getState().sketchId ||
      Math.hypot(event.clientX - d.x, event.clientY - d.y) > CLICK_SLOP
    ) {
      return;
    }

    this.click(d.button, event);
  };

  /** A finger lifted: a tap clicks, a double tap turns the view to the face. */
  private touchUp(event: PointerEvent, gesture: PressResult): void {
    if (useApp.getState().sketchId) return;

    if (gesture === "tap") {
      clickInView(this.viewport, this.viewport.pick(event.clientX, event.clientY, pickKinds()), true, [
        event.clientX,
        event.clientY,
      ]);
    }

    if (gesture === "double") {
      const pick = this.viewport.pick(event.clientX, event.clientY, new Set(["face"]));
      if (pick?.kind === "face" && pick.normal) this.viewport.lookAtFace(pick.point, pick.normal);
    }
  }

  /** A mouse or pen click that did not move: the context menu on the right button, else a pick. */
  private click(button: number, event: PointerEvent): void {
    const pick = this.viewport.pick(event.clientX, event.clientY, pickKinds());

    if (button === 2) {
      if (!confirmByRightClick()) {
        openContextMenu(this.viewport, this.fitKey, pick, event.clientX, event.clientY);
      }

      return;
    }

    if (button !== 0) return;

    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const doubleClicked = this.secondClickOnFace(pick, event);
    if (doubleClicked) return selectParts([doubleClicked], additive, true);

    clickInView(this.viewport, pick, additive || event.pointerType === "pen", [event.clientX, event.clientY]);
  }

  /**
   * The second click of a double-click on a face selects its part right away: going through the face
   * again and then the part made the highlight and the steps list flicker. Records this click as the
   * last one and returns the part when it completes a double-click.
   */
  private secondClickOnFace(pick: Pick | null, event: PointerEvent): string | null {
    const now = performance.now();
    const prev = this.lastClick;
    this.lastClick = {
      at: now,
      x: event.clientX,
      y: event.clientY,
      body: pick?.kind === "face" ? pick.bodyId : null,
    };

    if (
      prev?.body &&
      (!pick || pick.kind === "face") &&
      now - prev.at < DOUBLE_MS &&
      Math.hypot(event.clientX - prev.x, event.clientY - prev.y) < DOUBLE_SLOP &&
      !useApp.getState().dialog &&
      !useApp.getState().measure.active &&
      !useTerrainDraw.getState().kind
    ) {
      this.lastClick = null;
      this.doubleDone = now;

      return prev.body;
    }

    return null;
  }

  private readonly onDbl = (event: MouseEvent) => {
    // Already handled on the second click.
    if (performance.now() - this.doubleDone < DOUBLE_MS) return;
    if (useTerrainDraw.getState().kind) return finishMarking();
    if (useApp.getState().sketchId || useApp.getState().dialog) return;

    const pick = this.viewport.pick(event.clientX, event.clientY, DEFAULT_KINDS);

    // Double-clicking a face selects its whole part; other entities open their feature.
    if (pick?.kind === "face") {
      return selectParts([pick.bodyId], event.shiftKey || event.metaKey || event.ctrlKey, true);
    }

    const fid = pick ? featureOfPick(pick, useApp.getState().doc.features) : null;
    if (fid) editFeature(fid);
  };

  private readonly onCancel = (event: PointerEvent) => {
    this.press.up(event);
    this.multi.up(event);
    this.restoreNav();
    if (event.pointerType === "touch" && !this.area) return;

    this.moveFrame.cancel();
    this.area = null;
    this.boxNow = null;
    this.down = null;
    this.setBox(null);
  };
}
