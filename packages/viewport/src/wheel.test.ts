import { describe, expect, it } from "vitest";
import {
  isMouseWheel,
  isPinch,
  mouseNotches,
  mouseZoomDelta,
  NOTCH_ZOOM_DELTA,
  pinchDelta,
  pinchScale,
  WheelClassifier,
  type WheelLike,
} from "./wheel";

const ev = (o: Partial<WheelLike>): WheelLike => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
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
  it("fingers swiping orbit, with Shift, ⌘ or Option pan, pinch and Ctrl zoom", () => {
    const c = new WheelClassifier();
    // Sideways as well as up and down: fingers.
    expect(c.classify(ev({ deltaX: 2, deltaY: 6, timeStamp: 0 }))).toBe("orbit");
    expect(c.classify(ev({ deltaY: 6, timeStamp: 16 }))).toBe("orbit");
    expect(c.classify(ev({ deltaY: 6, shiftKey: true, timeStamp: 32 }))).toBe("pan");
    expect(c.classify(ev({ deltaY: 6, ctrlKey: true, timeStamp: 48 }))).toBe("zoom");
    expect(c.classify(ev({ deltaY: 6, metaKey: true, timeStamp: 64 }))).toBe("pan");
    expect(c.classify(ev({ deltaX: 6, altKey: true, timeStamp: 80 }))).toBe("pan");
  });

  it("a mouse wheel zooms, notched or smooth, also with Shift, ⌘ or Ctrl", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaY: 4.000244140625, timeStamp: 0 }))).toBe("zoom");
    expect(c.classify(ev({ deltaX: 4.000244140625, shiftKey: true, timeStamp: 1000 }))).toBe("zoom");

    // A smoothly scrolling wheel: uneven pixel steps, never sideways.
    for (const [deltaY, t] of [
      [-3, 2000],
      [-7.5, 2016],
      [-12, 2032],
      [-1.5, 2048],
    ]) {
      expect(c.classify(ev({ deltaY: deltaY!, timeStamp: t! }))).toBe("zoom");
    }

    // Shift turns a wheel sideways on macOS: that is no sign of fingers.
    expect(c.classify(ev({ deltaX: -6, shiftKey: true, timeStamp: 3000 }))).toBe("pan");
    expect(c.classify(ev({ deltaY: -6, timeStamp: 3016 }))).toBe("zoom");
  });

  it("zooms a swipe until it moves sideways, then keeps the fingers for the whole gesture", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaY: 3, timeStamp: 0 }))).toBe("zoom");
    expect(c.classify(ev({ deltaX: 1, deltaY: 3, timeStamp: 16 }))).toBe("orbit");
    // looks like a notch, still the swipe
    expect(c.classify(ev({ deltaY: 100, timeStamp: 32 }))).toBe("orbit");
    expect(c.classify(ev({ deltaY: 100, timeStamp: 600 }))).toBe("zoom"); // a new gesture
  });

  it("zooms every scroll when swiping should not turn the view, pans with a key", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaX: 2, deltaY: 3 }), false)).toBe("zoom");
    expect(c.classify(ev({ deltaY: 6, shiftKey: true, timeStamp: 16 }), false)).toBe("pan");
    expect(c.classify(ev({ deltaY: 6, ctrlKey: true, timeStamp: 32 }), false)).toBe("zoom");
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

describe("trackpad pinch", () => {
  it("is a ctrlKey wheel event without the Ctrl key down, and not a notched wheel", () => {
    expect(isPinch(ev({ deltaY: -1.73, ctrlKey: true }), false)).toBe(true);
    expect(isPinch(ev({ deltaY: -1.73, ctrlKey: true }), true)).toBe(false); // Ctrl + swipe
    expect(isPinch(ev({ deltaY: 4.000244140625, ctrlKey: true }), false)).toBe(false); // Ctrl + wheel
    expect(isPinch(ev({ deltaY: -1.73 }), false)).toBe(false); // a swipe
  });
  it("zooms as far as the fingers spread, also with the wheel inverted", () => {
    // Chromium: spreading the fingers to twice their distance sends deltaY summing to -100 · ln 2.
    const steps = [-20, -15.31, -34];
    const scale = steps.reduce((s, d) => s * pinchScale(d), 1);
    expect(scale).toBeCloseTo(2, 3);

    for (const speed of [1, -1]) {
      // What OrbitControls dollies by for the delta sent on: 0.95^(speed · |d| / 100), towards for d < 0.
      const dolly = steps.reduce((s, d) => {
        const sent = pinchDelta(pinchScale(d), speed);
        const f = Math.pow(0.95, speed * Math.abs(sent * 0.01));

        return s * (sent < 0 ? f : 1 / f);
      }, 1);
      expect(1 / dolly).toBeCloseTo(2, 3);
    }

    expect(pinchDelta(pinchScale(5), 1)).toBeGreaterThan(0); // closing the fingers zooms out
  });
});
