import { describe, expect, it } from "vitest";
import {
  isMouseWheel,
  mouseNotches,
  mouseZoomDelta,
  NOTCH_ZOOM_DELTA,
  WheelClassifier,
  type WheelLike,
} from "./wheel";

const ev = (o: Partial<WheelLike>): WheelLike => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  timeStamp: 0,
  ...o,
});

describe("isMouseWheel", () => {
  it("knows notched wheels", () => {
    expect(isMouseWheel(ev({ deltaY: 4.000244140625 }))).toBe(true); // macOS, one notch
    expect(isMouseWheel(ev({ deltaY: -3 * 4.000244140625 }))).toBe(true);
    expect(isMouseWheel(ev({ deltaX: 2 * 4.000244140625 }))).toBe(true); // macOS turns Shift + wheel sideways
    expect(isMouseWheel(ev({ deltaY: 100 }))).toBe(true); // Windows
    expect(isMouseWheel(ev({ deltaY: -120 }))).toBe(true);
    expect(isMouseWheel(ev({ deltaY: 3, deltaMode: 1 }))).toBe(true); // lines
  });
  it("knows trackpad swipes", () => {
    expect(isMouseWheel(ev({ deltaY: 4 }))).toBe(false);
    expect(isMouseWheel(ev({ deltaY: -1 }))).toBe(false);
    expect(isMouseWheel(ev({ deltaX: 3, deltaY: -2 }))).toBe(false);
    expect(isMouseWheel(ev({ deltaY: 2.5 }))).toBe(false);
    expect(isMouseWheel(ev({ deltaX: 12 }))).toBe(false);
  });
});

describe("WheelClassifier", () => {
  it("swipe orbits, Shift pans, pinch and Ctrl zoom", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaY: 6, timeStamp: 0 }))).toBe("orbit");
    expect(c.classify(ev({ deltaY: 6, shiftKey: true, timeStamp: 16 }))).toBe("pan");
    expect(c.classify(ev({ deltaY: 6, ctrlKey: true, timeStamp: 32 }))).toBe("zoom");
    expect(c.classify(ev({ deltaY: 6, metaKey: true, timeStamp: 48 }))).toBe("zoom");
  });
  it("a mouse wheel keeps zooming, also with Shift", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaY: 4.000244140625, timeStamp: 0 }))).toBe("zoom");
    expect(c.classify(ev({ deltaX: 4.000244140625, shiftKey: true, timeStamp: 1000 }))).toBe("zoom");
  });
  it("keeps the device for the whole gesture", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaY: 3, timeStamp: 0 }))).toBe("orbit");
    // looks like a notch, still the swipe
    expect(c.classify(ev({ deltaY: 100, timeStamp: 16 }))).toBe("orbit");
    expect(c.classify(ev({ deltaY: 100, timeStamp: 600 }))).toBe("zoom"); // a new gesture
  });
  it("zooms everything when swiping should not orbit", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaY: 3 }), false)).toBe("zoom");
  });
});

describe("zooming with a mouse wheel", () => {
  const wheel = (deltaY: number, deltaMode = 0, deltaX = 0) => ({ deltaX, deltaY, deltaMode });

  it("counts the notches whatever the system reports", () => {
    expect(mouseNotches(wheel(-120))).toBe(-1);
    expect(mouseNotches(wheel(240))).toBe(2);
    expect(mouseNotches(wheel(-100))).toBe(-1);
    expect(mouseNotches(wheel(-4.000244140625))).toBeCloseTo(-1, 9);
    expect(mouseNotches(wheel(3, 1))).toBe(1);
    expect(mouseNotches(wheel(1, 2))).toBe(1);
    expect(mouseNotches(wheel(0, 0, 120))).toBe(1);
  });

  it("zooms the same step per notch, and leaves a trackpad's deltas alone", () => {
    expect(mouseZoomDelta(wheel(-4.000244140625))).toBeCloseTo(-NOTCH_ZOOM_DELTA, 6);
    expect(mouseZoomDelta(wheel(-200))).toBe(-2 * NOTCH_ZOOM_DELTA);
    expect(mouseZoomDelta(wheel(-3, 1))).toBe(-NOTCH_ZOOM_DELTA);
    expect(mouseZoomDelta(wheel(-3.5))).toBeNull();
    expect(mouseZoomDelta(wheel(0))).toBeNull();
  });
});
