/**
 * Moving a value chip (a dimension's number) out of the way by dragging it, with mouse, finger or
 * pen. A press that stays within a few pixels is still a click (it opens the value for typing); once
 * it goes further, the chip follows the pointer and lands where it is let go.
 */

/** A press that moves further than this (pixels) drags the chip instead of clicking it. */
export const CHIP_DRAG_SLOP = 4;

/** True once a press has gone far enough from where it started to be a drag. */
export function isChipDrag(from: readonly [number, number], to: readonly [number, number]): boolean {
  return Math.hypot(to[0] - from[0], to[1] - from[1]) > CHIP_DRAG_SLOP;
}

interface PressEvent {
  clientX: number;
  clientY: number;
  pointerId: number;
  button: number;
  currentTarget: EventTarget | null;
}

/**
 * Follows a press on `chip`: while it drags, the chip is shown moved with the pointer; on release
 * `drop` gets where it was let go, and the click that follows a drag is swallowed. Only the main
 * button drags.
 */
export function followChipDrag(event: PressEvent, drop: (clientX: number, clientY: number) => void): void {
  const chip = event.currentTarget;
  if (event.button !== 0 || !(chip instanceof HTMLElement)) return;

  const start: [number, number] = [event.clientX, event.clientY];
  const pointer = event.pointerId;
  let dragging = false;

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    if (!dragging && !isChipDrag(start, [e.clientX, e.clientY])) return;

    dragging = true;
    chip.style.translate = `${e.clientX - start[0]}px ${e.clientY - start[1]}px`;
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;

    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    chip.style.translate = "";
    if (!dragging || e.type === "pointercancel") return;

    // The click the browser sends after the release would open the value: a drag is not a click.
    const swallow = (click: Event) => (click.stopPropagation(), click.preventDefault());
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    drop(e.clientX, e.clientY);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
