import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sureTap } from "../apps/web/src/lib/gestures";

const touch = (x = 10, y = 10) => ({ pointerType: "touch", clientX: x, clientY: y });

describe("sureTap (Done in a sketch answers the first tap)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once on a normal tap: the click comes, the lift does not run it again", () => {
    const run = vi.fn();
    const h = sureTap(run);
    h.onPointerDown(touch());
    h.onPointerUp(touch());
    h.onClick();
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs on the lift when iOS swallows the click, and a late click does not run it twice", () => {
    const run = vi.fn();
    const h = sureTap(run);
    h.onPointerDown(touch());
    h.onPointerUp(touch());
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
    h.onClick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves mouse clicks, drags and cancelled touches alone", () => {
    const run = vi.fn();
    const h = sureTap(run);
    h.onPointerDown({ pointerType: "mouse", clientX: 0, clientY: 0 });
    h.onPointerUp({ pointerType: "mouse", clientX: 0, clientY: 0 });
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
    h.onPointerDown(touch(0, 0));
    h.onPointerUp(touch(40, 0));
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
    h.onPointerDown(touch());
    h.onPointerCancel();
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
    h.onClick();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
