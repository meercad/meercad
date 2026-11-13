/**
 * Touch gestures (gestures.ts): a still tap, a double tap, a long press and a long-press drag; two-
 * and three-finger taps and three-finger swipes; long press opening right-click menus on the page;
 * a button that answers the first tap on an iPad.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLongPressMenus, LONG_PRESS_MS, MultiTouch, Press } from "./gestures";

const ev = (type: string, id: number, x: number, y: number, pointerType = "touch") =>
  ({ type, pointerId: id, clientX: x, clientY: y, pointerType }) as unknown as PointerEvent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("one finger", () => {
  it("tells a tap, a double tap, a long press and a long-press drag apart", () => {
    const long = vi.fn();
    const drag = vi.fn();
    const p = new Press(long, drag);
    p.down(ev("pointerdown", 1, 10, 10));
    expect(p.up(ev("pointerup", 1, 10, 10))).toBe("tap");
    p.down(ev("pointerdown", 1, 12, 11));
    expect(p.up(ev("pointerup", 1, 12, 11))).toBe("double");
    vi.advanceTimersByTime(1000);
    p.down(ev("pointerdown", 1, 10, 10));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(long).toHaveBeenCalledWith(10, 10, expect.anything());
    expect(p.up(ev("pointerup", 1, 10, 10))).toBe("long");
    p.down(ev("pointerdown", 1, 10, 10));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    p.move(ev("pointermove", 1, 60, 60));
    expect(drag).toHaveBeenCalledWith(10, 10);
    expect(p.up(ev("pointerup", 1, 60, 60))).toBe("long-drag");
  });

  it("drops a press that moves early, a second finger and a cancel", () => {
    const long = vi.fn();
    const p = new Press(long);
    p.down(ev("pointerdown", 1, 10, 10));
    p.move(ev("pointermove", 1, 50, 50));
    expect(p.up(ev("pointerup", 1, 50, 50))).toBeNull();
    p.down(ev("pointerdown", 1, 10, 10));
    p.down(ev("pointerdown", 2, 40, 40));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(long).not.toHaveBeenCalled();
    p.down(ev("pointerdown", 3, 10, 10));
    expect(p.up(ev("pointercancel", 3, 10, 10))).toBeNull();
    expect(p.up(ev("pointerup", 9, 10, 10))).toBeNull();
  });
});

describe("several fingers", () => {
  it("reports two- and three-finger taps and three-finger swipes", () => {
    const seen: string[] = [];
    const m = new MultiTouch((g) => seen.push(g));

    for (const [n, dx] of [
      [2, 0],
      [3, 0],
      [3, -100],
      [3, 100],
    ] as const) {
      for (let i = 0; i < n; i++) m.down(ev("pointerdown", i + 1, 100 + i * 30, 100));
      for (let i = 0; i < n; i++) m.move(ev("pointermove", i + 1, 100 + i * 30 + dx, 100));
      for (let i = 0; i < n; i++) m.up(ev("pointerup", i + 1, 100 + i * 30 + dx, 100));
    }

    expect(seen).toEqual(["tap2", "tap3", "swipe-left", "swipe-right"]);
    // A mouse, one finger, or a cancelled touch says nothing.
    m.down(ev("pointerdown", 1, 0, 0, "mouse"));
    m.down(ev("pointerdown", 5, 0, 0));
    m.up(ev("pointerup", 5, 0, 0));
    m.down(ev("pointerdown", 6, 0, 0));
    m.down(ev("pointerdown", 7, 9, 0));
    m.up(ev("pointercancel", 6, 0, 0));
    m.up(ev("pointerup", 7, 9, 0));
    m.up(ev("pointerup", 42, 0, 0));
    expect(seen).toHaveLength(4);
  });
});

describe("long press on the page", () => {
  it("opens the right-click menu and swallows the click that follows", () => {
    const off = installLongPressMenus();
    const el = document.createElement("div");
    document.body.append(el);

    const menu = vi.fn();
    const clicked = vi.fn();
    el.addEventListener("contextmenu", menu);
    el.addEventListener("click", clicked);
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      }),
    );
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(menu).toHaveBeenCalledOnce();
    el.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 1,
        pointerType: "touch",
        clientX: 5,
        clientY: 5,
      }),
    );
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).not.toHaveBeenCalled();
    // A mouse is left to the browser; an input field is left alone.
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "mouse" }));

    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, pointerType: "touch" }),
    );
    input.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 3, pointerType: "touch" }),
    );
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(menu).toHaveBeenCalledOnce();
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toHaveBeenCalledOnce();
    off();
  });
});
