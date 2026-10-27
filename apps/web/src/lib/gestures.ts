/**
 * Touch and pen gestures that mouse input gets from buttons: a long press stands in for the
 * right click, a quick still tap for the left click, two taps for a double click.
 */

export const LONG_PRESS_MS = 500;
const SLOP = 10;
const DOUBLE_TAP_MS = 350;

export type PressResult = "tap" | "double" | "long" | null;

/** Follows one finger or pen press at a time; a second finger (pinch, pan) cancels it. */
export class Press {
  private cur: { id: number; x: number; y: number; t: number; timer: number; fired: boolean } | null = null;
  private touches = new Set<number>();
  private lastTap: { x: number; y: number; t: number } | null = null;

  constructor(private onLong: (x: number, y: number) => void) {}

  down(e: PointerEvent): void {
    if (e.pointerType === "touch") this.touches.add(e.pointerId);
    this.cancel();
    if (this.touches.size > 1) return;
    const c = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), timer: 0, fired: false };
    c.timer = window.setTimeout(() => {
      c.fired = true;
      this.onLong(c.x, c.y);
    }, LONG_PRESS_MS);
    this.cur = c;
  }

  move(e: PointerEvent): void {
    const c = this.cur;
    if (c && c.id === e.pointerId && !c.fired && Math.hypot(e.clientX - c.x, e.clientY - c.y) > SLOP) this.cancel();
  }

  /** How the press ended: a tap, the second tap of a double tap, a long press, or a drag (null). */
  up(e: PointerEvent): PressResult {
    this.touches.delete(e.pointerId);
    const c = this.cur;
    if (!c || c.id !== e.pointerId) return null;
    window.clearTimeout(c.timer);
    this.cur = null;
    if (e.type === "pointercancel") return null;
    if (c.fired) return "long";
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
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  });
  const down = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    target = e.target instanceof Element && !e.target.closest("canvas, input, textarea, select") ? e.target : null;
    if (target) press.down(e);
    else press.cancel();
  };
  const move = (e: PointerEvent) => e.pointerType !== "mouse" && press.move(e);
  const up = (e: PointerEvent) => e.pointerType !== "mouse" && press.up(e);
  // The release after a long press would otherwise also click what is under the finger.
  const click = (e: MouseEvent) => {
    if (performance.now() - suppressClick > 1000) return;
    suppressClick = 0;
    e.preventDefault();
    e.stopPropagation();
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
