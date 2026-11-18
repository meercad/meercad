/**
 * Dragging a value chip out of the way (chipDrag.ts): a short press stays a click, a longer one moves
 * the chip with the pointer and drops it where it is let go, and the click after a drag is swallowed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHIP_DRAG_SLOP, followChipDrag, isChipDrag } from "./chipDrag";

const chip = () => {
  const element = document.createElement("div");
  document.body.append(element);

  return element;
};

const press = (target: EventTarget | null, x = 10, y = 10, button = 0, pointerId = 1) => ({
  clientX: x,
  clientY: y,
  pointerId,
  button,
  currentTarget: target,
});
const send = (type: string, x: number, y: number, pointerId = 1) =>
  window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId, bubbles: true }));

afterEach(() => document.body.replaceChildren());

describe("a press on a chip", () => {
  it("drags once it has gone further than a few pixels", () => {
    expect(isChipDrag([0, 0], [CHIP_DRAG_SLOP, 0])).toBe(false);
    expect(isChipDrag([0, 0], [CHIP_DRAG_SLOP, 1])).toBe(true);
  });

  it("moves the chip with the pointer and drops it where it is let go", () => {
    const element = chip();
    const drop = vi.fn();
    followChipDrag(press(element), drop);
    send("pointermove", 11, 10);
    expect(element.style.translate).toBe("");
    send("pointermove", 40, 30, 2);
    send("pointermove", 40, 30);
    expect(element.style.translate).toBe("30px 20px");
    send("pointerup", 50, 30, 2);
    expect(drop).not.toHaveBeenCalled();
    send("pointerup", 50, 30);
    expect(drop).toHaveBeenCalledWith(50, 30);
    expect(element.style.translate).toBe("");

    // The click the browser sends after the release does not reach the chip.
    const clicked = vi.fn();
    element.addEventListener("click", clicked);
    element.click();
    expect(clicked).not.toHaveBeenCalled();
  });

  it("stays a click when it hardly moves, and ends without a drop when cancelled", () => {
    const element = chip();
    const drop = vi.fn();
    followChipDrag(press(element), drop);
    send("pointerup", 12, 11);
    expect(drop).not.toHaveBeenCalled();

    followChipDrag(press(element), drop);
    send("pointermove", 60, 60);
    send("pointercancel", 60, 60);
    expect(drop).not.toHaveBeenCalled();
    expect(element.style.translate).toBe("");
  });

  it("is no drag with another button or without a chip", () => {
    const drop = vi.fn();
    followChipDrag(press(chip(), 10, 10, 2), drop);
    followChipDrag(press(null), drop);
    send("pointermove", 60, 60);
    send("pointerup", 60, 60);
    expect(drop).not.toHaveBeenCalled();
  });
});
