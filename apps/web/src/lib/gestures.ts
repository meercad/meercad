/**
 * Touch and pen gestures that mouse input gets from buttons: a long press stands in for the
 * right click, a quick still tap for the left click, two taps for a double click.
 */

export const LONG_PRESS_MS = 500;

const SLOP = 10;
const DOUBLE_TAP_MS = 350;

export type PressResult = "tap" | "double" | "long" | "long-drag" | null;

/**
 * Follows one finger or pen press at a time; a second finger (pinch, pan) cancels it. Held still
 * for LONG_PRESS_MS it reports a long press; moving on after that reports a long-press drag
 * (area selection).
 */
export class Press {
  private cur: {
    id: number;
    x: number;
    y: number;
    t: number;
    timer: number;
    fired: boolean;
    dragging: boolean;
  } | null = null;

  private touches = new Set<number>();
  private lastTap: { x: number; y: number; t: number } | null = null;

  constructor(
    private onLong: (x: number, y: number, event: PointerEvent) => void,
    private onLongDrag?: (x: number, y: number) => void,
  ) {}

  down(event: PointerEvent): void {
    if (event.pointerType === "touch") this.touches.add(event.pointerId);

    this.cancel();
    if (this.touches.size > 1) return;

    const c = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      t: performance.now(),
      timer: 0,
      fired: false,
      dragging: false,
    };
    c.timer = window.setTimeout(() => {
      c.fired = true;
      this.onLong(c.x, c.y, event);
    }, LONG_PRESS_MS);
    this.cur = c;
  }

  move(event: PointerEvent): void {
    const c = this.cur;

    if (
      !c ||
      c.id !== event.pointerId ||
      c.dragging ||
      Math.hypot(event.clientX - c.x, event.clientY - c.y) <= SLOP
    ) {
      return;
    }

    if (!c.fired) return this.cancel();

    c.dragging = true;
    this.onLongDrag?.(c.x, c.y);
  }

  /** How the press ended: a tap, the second tap of a double tap, a long press, or a drag (null). */
  up(event: PointerEvent): PressResult {
    this.touches.delete(event.pointerId);

    const c = this.cur;
    if (!c || c.id !== event.pointerId) return null;

    window.clearTimeout(c.timer);
    this.cur = null;
    if (event.type === "pointercancel") return null;
    if (c.fired) return c.dragging ? "long-drag" : "long";

    const now = performance.now();
    const l = this.lastTap;

    if (l && now - l.t < DOUBLE_TAP_MS && Math.hypot(c.x - l.x, c.y - l.y) < SLOP * 2) {
      this.lastTap = null;

      return "double";
    }

    this.lastTap = { x: c.x, y: c.y, t: now };

    return "tap";
  }

  cancel(): void {
    if (this.cur) window.clearTimeout(this.cur.timer);

    this.cur = null;
  }
}

export type MultiGesture = "tap2" | "tap3" | "swipe-left" | "swipe-right";

/**
 * Several-finger gestures: a quick two- or three-finger tap, and a three-finger swipe sideways
 * (the iPad's own undo/redo gesture).
 */
export class MultiTouch {
  private pts = new Map<number, { x0: number; y0: number; x: number; y: number }>();
  private done: { dx: number; dy: number }[] = [];
  private max = 0;
  private t0 = 0;
  private cancelled = false;

  constructor(private on: (g: MultiGesture) => void) {}

  down(event: PointerEvent): void {
    if (event.pointerType !== "touch") return;

    if (!this.pts.size) {
      this.done = [];
      this.max = 0;
      this.t0 = performance.now();
      this.cancelled = false;
    }

    this.pts.set(event.pointerId, {
      x0: event.clientX,
      y0: event.clientY,
      x: event.clientX,
      y: event.clientY,
    });
    this.max = Math.max(this.max, this.pts.size);
  }

  move(event: PointerEvent): void {
    const p = this.pts.get(event.pointerId);
    if (p) Object.assign(p, { x: event.clientX, y: event.clientY });
  }

  up(event: PointerEvent): void {
    const p = this.pts.get(event.pointerId);
    if (!p) return;

    this.pts.delete(event.pointerId);
    if (event.type === "pointercancel") this.cancelled = true;

    this.done.push({ dx: event.clientX - p.x0, dy: event.clientY - p.y0 });
    if (this.pts.size || this.cancelled || this.max < 2) return;

    const n = this.done.length;
    const dx = this.done.reduce((a, d) => a + d.dx, 0) / n;
    const dy = this.done.reduce((a, d) => a + d.dy, 0) / n;
    const still = this.done.every((d) => Math.hypot(d.dx, d.dy) < SLOP * 2);

    if (this.max === 3 && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) {
      this.on(dx < 0 ? "swipe-left" : "swipe-right");
    } else if (still && performance.now() - this.t0 < 300) {
      this.on(this.max === 2 ? "tap2" : "tap3");
    }
  }
}

/**
 * Long press on page elements (feature tree, project cards, …) fires `contextmenu`, which iPad
 * Safari never does by itself, so every right-click menu also opens by touch and pen. The canvas
 * handles its own presses (see ViewportView).
 */
export function installLongPressMenus(): () => void {
  let suppressClick = 0;
  let target: Element | null = null;
  const press = new Press((x, y) => {
    if (!target?.isConnected) return;

    suppressClick = performance.now();
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }),
    );
  });

  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;

    target =
      event.target instanceof Element && !event.target.closest("canvas, input, textarea, select")
        ? event.target
        : null;
    if (target) press.down(event);
    else press.cancel();
  };

  const move = (event: PointerEvent) => event.pointerType !== "mouse" && press.move(event);
  const up = (event: PointerEvent) => event.pointerType !== "mouse" && press.up(event);

  // The release after a long press would otherwise also click what is under the finger.
  const click = (event: MouseEvent) => {
    if (performance.now() - suppressClick > 1000) return;

    suppressClick = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("click", click, true);

  return () => {
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    window.removeEventListener("click", click, true);
  };
}

/**
 * Click handlers for a button that has to answer the first tap. iOS sometimes swallows the click
 * after a finger tap, when the page changes right then (in a sketch: the rebuild after a line, the
 * value chips moving), and only a second tap clicks; "Done" then looked dead. A finger or pen
 * lift on the button runs it if no click follows within a moment; a late click is not run twice.
 * A long press is no tap: it opens the element's menu (installLongPressMenus).
 */
export function sureTap(run: () => void): {
  onClick: () => void;
  onPointerDown: (e: { pointerType: string; clientX: number; clientY: number }) => void;
  onPointerUp: (e: { pointerType: string; clientX: number; clientY: number }) => void;
  onPointerCancel: () => void;
} {
  let down: { x: number; y: number; t: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // When the lift ran it, the click that may still come late must not run it again.
  let liftRanAt = -Infinity;

  const fire = () => {
    clearTimeout(timer);
    run();
  };

  return {
    onPointerDown: (e) => {
      down = e.pointerType === "mouse" ? null : { x: e.clientX, y: e.clientY, t: performance.now() };
    },
    onPointerUp: (e) => {
      const d = down;
      down = null;

      if (
        !d ||
        e.pointerType === "mouse" ||
        Math.hypot(e.clientX - d.x, e.clientY - d.y) > SLOP ||
        performance.now() - d.t >= LONG_PRESS_MS
      ) {
        return;
      }

      clearTimeout(timer);
      timer = setTimeout(() => {
        liftRanAt = performance.now();
        run();
      }, 400);
    },
    onPointerCancel: () => {
      down = null;
      clearTimeout(timer);
    },
    onClick: () => {
      if (performance.now() - liftRanAt < 1500) return;

      fire();
    },
  };
}
