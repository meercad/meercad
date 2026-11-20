/**
 * What a wheel event means in the 3D view. A trackpad sends its two-finger swipes as wheel events
 * too, so they are told apart from a mouse wheel by the shape of their deltas:
 *
 * - two-finger swipe on a trackpad, one-finger swipe on a Magic Mouse: orbit; with Shift, ⌘ or
 *   Option: pan
 * - pinch (Chromium sends it with ctrlKey set) or Ctrl + swipe: zoom
 * - a mouse wheel zooms, with any key held
 */
export type WheelGesture = "orbit" | "pan" | "zoom";

export type WheelLike = Pick<
  WheelEvent,
  "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "timeStamp"
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

/** Lines one notch scrolls when a wheel reports lines (Windows' default). */
const LINES_PER_NOTCH = 3;
/** The wheel delta one notch zooms by, whatever the device reported (OrbitControls: about 6 %). */
export const NOTCH_ZOOM_DELTA = 120;

/** How many notches a mouse wheel event turned (signed like its delta); 0 for none. */
export function mouseNotches(e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">): number {
  const v = e.deltaY !== 0 ? e.deltaY : e.deltaX;
  if (e.deltaMode === 1) return v / LINES_PER_NOTCH;
  if (e.deltaMode === 2) return v;
  if (multipleOf(v, 120)) return v / 120;
  if (multipleOf(v, 100)) return v / 100;

  return v / MAC_NOTCH;
}

/**
 * The delta a mouse wheel event should zoom by: the same step per notch on every system and with
 * Ctrl or ⌘ held (Chromium marks a pinch with ctrlKey, and the camera control zooms ten times as far
 * for it; a notch with Ctrl held is not a pinch). Null for trackpads: they keep their own deltas.
 */
export function mouseZoomDelta(e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">): number | null {
  return isMouseWheel(e) ? mouseNotches(e) * NOTCH_ZOOM_DELTA : null;
}

/** A gap longer than this starts a new gesture (momentum events follow each other every ~16 ms). */
const GESTURE_GAP_MS = 250;

/**
 * Sorts wheel events into gestures and tells a mouse wheel from fingers. A notched wheel is known on
 * the first event of a gesture. Fingers (a trackpad, a Magic Mouse) are known once a gesture moves
 * sideways too: a wheel only ever scrolls up and down, also one that scrolls smoothly in uneven pixel
 * steps (as many mice do). Until then a scroll zooms: a wheel must always zoom, and a swipe that
 * starts straight up or down turns the view as soon as it wavers. Kept until the gesture pauses, so a
 * finger delta that happens to look like a notch does not zoom halfway through a swipe.
 */
export class WheelClassifier {
  private device: "mouse" | "fingers" | "unknown" = "unknown";
  private last = -Infinity;

  /** `swipeOrbits` false: a swipe without keys zooms too, as a mouse wheel does (Shift/⌘/Option: pans). */
  classify(e: WheelLike, swipeOrbits = true): WheelGesture {
    const fresh = e.timeStamp - this.last > GESTURE_GAP_MS;
    this.last = e.timeStamp;
    if (fresh) this.device = isMouseWheel(e) ? "mouse" : "unknown";
    // Sideways without Shift (which turns a wheel sideways on macOS): fingers.
    if (this.device === "unknown" && e.deltaX !== 0 && !e.shiftKey) this.device = "fingers";
    // Pinch arrives as ctrlKey without a key being held; Ctrl + swipe zooms on purpose.
    if (e.ctrlKey || this.device === "mouse") return "zoom";
    if (e.shiftKey || e.metaKey || e.altKey) return "pan";

    return swipeOrbits && this.device === "fingers" ? "orbit" : "zoom";
  }
}

/**
 * Whether a wheel event is a trackpad pinch: Chromium sends a pinch as a wheel event with ctrlKey set
 * while the Ctrl key itself is up (`ctrlHeld`: the key is down, so it is Ctrl + swipe or Ctrl + wheel).
 */
export function isPinch(
  e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey">,
  ctrlHeld: boolean,
): boolean {
  return e.ctrlKey && !ctrlHeld && !isMouseWheel(e);
}

/**
 * How much a pinch event scales the view: Chromium reports a pinch by `scale` as deltaY = -100 · ln(scale),
 * so the fingers spreading to twice their distance zoom in twice as far (above 1: closer).
 */
export function pinchScale(deltaY: number): number {
  return Math.exp(-deltaY / 100);
}

/**
 * The wheel delta OrbitControls needs (without Ctrl, which it would take ten times) to dolly by `scale`:
 * it dollies by 0.95^(zoomSpeed · |delta| / 100). Divided by zoomSpeed, so "invert zoom" (a negative
 * speed, meant for the wheel) never turns a pinch round.
 */
export function pinchDelta(scale: number, zoomSpeed: number): number {
  return (100 * Math.log(scale)) / (zoomSpeed * Math.log(0.95));
}
