/**
 * What a wheel event means in the 3D view. A trackpad sends its two-finger swipes as wheel events
 * too, so they are told apart from a mouse wheel by the shape of their deltas:
 *
 * - two-finger swipe: orbit; with Shift: pan
 * - pinch (Chromium sends it with ctrlKey set) or Ctrl/⌘ + two-finger swipe: zoom
 * - a mouse wheel zooms as before, with or without Shift
 */
export type WheelGesture = "orbit" | "pan" | "zoom";

export type WheelLike = Pick<
  WheelEvent,
  "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "shiftKey" | "timeStamp"
>;

/** One notch of a mouse wheel on macOS: Cocoa's 0.1 line step (16.16 fixed point) times 40 px. */
const MAC_NOTCH = 4.000244140625;

const multipleOf = (v: number, step: number) => {
  const r = Math.abs(v) / step;

  return r >= 1 - 1e-9 && Math.abs(r - Math.round(r)) < 1e-6;
};

/**
 * Whether one wheel event comes from a notched mouse wheel. Trackpads (and other smooth scrolling
 * devices) send pixel deltas on both axes; a mouse wheel moves one axis (Shift turns it sideways on
 * macOS) by whole notches: multiples of 4.000244 px on macOS, 100 or 120 px elsewhere, or lines.
 */
export function isMouseWheel(e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">): boolean {
  if (e.deltaMode !== 0) return true;
  if (e.deltaX !== 0 && e.deltaY !== 0) return false;

  const v = e.deltaY !== 0 ? e.deltaY : e.deltaX;
  if (v === 0) return false;
  if (!Number.isInteger(v) && multipleOf(v, MAC_NOTCH)) return true;

  return Number.isInteger(v) && (multipleOf(v, 100) || multipleOf(v, 120));
}

/** A gap longer than this starts a new gesture (momentum events follow each other every ~16 ms). */
const GESTURE_GAP_MS = 250;

/**
 * Sorts wheel events into gestures. The device is judged on the first event of a gesture and kept
 * until it pauses, so a trackpad delta that happens to look like a notch does not zoom halfway
 * through a swipe.
 */
export class WheelClassifier {
  private mouse = false;
  private last = -Infinity;

  /** `swipeOrbits` false: everything zooms, as a plain wheel would. */
  classify(e: WheelLike, swipeOrbits = true): WheelGesture {
    const fresh = e.timeStamp - this.last > GESTURE_GAP_MS;
    this.last = e.timeStamp;
    // Pinch arrives as ctrlKey without a key being held; Ctrl/⌘ + swipe zooms on purpose.
    if (e.ctrlKey || e.metaKey) return "zoom";
    if (fresh) this.mouse = isMouseWheel(e);
    if (this.mouse || !swipeOrbits) return "zoom";

    return e.shiftKey ? "pan" : "orbit";
  }
}
