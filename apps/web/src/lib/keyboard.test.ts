/** Shortcut hints hide on a touch screen until a hardware keyboard shows itself. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installKeyboardDetection, touchOnly } from "./keyboard";

type Listener = () => void;

/** A device as the media queries see it; `change()` tells the app that a pointer came or went. */
function device(pointers: { coarse: boolean; fine: boolean }) {
  const listeners: Listener[] = [];

  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("coarse") ? pointers.coarse : pointers.fine;
    },
    addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
  }));

  return { pointers, change: () => listeners.forEach((listener) => listener()) };
}

const press = (key: string, target: EventTarget = window, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

describe("keyboard detection", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("no-keyboard");
    document.body.innerHTML = "";
  });

  afterEach(() => vi.unstubAllGlobals());

  it("leaves the hints on with a mouse or trackpad", () => {
    device({ coarse: false, fine: true });
    installKeyboardDetection();

    expect(touchOnly()).toBe(false);
  });

  it("hides the hints on a touch screen until a key is pressed outside a text field", () => {
    device({ coarse: true, fine: false });
    installKeyboardDetection();

    expect(touchOnly()).toBe(true);

    // Typing into a field is what the on-screen keyboard does too.
    const field = document.body.appendChild(document.createElement("input"));

    press("a", field);
    expect(touchOnly()).toBe(true);

    press("a");
    expect(touchOnly()).toBe(false);
    expect(localStorage.getItem("meercad.keyboard")).toBe("1");
  });

  it("takes Escape, arrows and shortcuts in a text field as a hardware keyboard", () => {
    for (const [key, init] of [
      ["Escape", {}],
      ["ArrowDown", {}],
      ["s", { metaKey: true }],
      ["z", { ctrlKey: true }],
    ] as const) {
      localStorage.clear();
      device({ coarse: true, fine: false });
      installKeyboardDetection();

      const field = document.body.appendChild(document.createElement("textarea"));

      expect(touchOnly(), key).toBe(true);
      press(key, field, init);
      expect(touchOnly(), key).toBe(false);
    }
  });

  it("remembers a keyboard seen on an earlier visit", () => {
    localStorage.setItem("meercad.keyboard", "1");
    device({ coarse: true, fine: false });
    installKeyboardDetection();

    expect(touchOnly()).toBe(false);
  });

  it("shows the hints as soon as a mouse or trackpad is connected", () => {
    const tablet = device({ coarse: true, fine: false });

    installKeyboardDetection();
    expect(touchOnly()).toBe(true);

    tablet.pointers.fine = true;
    tablet.change();
    expect(touchOnly()).toBe(false);
  });

  it("works when storage is blocked: nothing is remembered", () => {
    device({ coarse: true, fine: false });

    const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const blockedWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    installKeyboardDetection();
    expect(touchOnly()).toBe(true);

    press("Tab");
    expect(touchOnly()).toBe(false);

    blocked.mockRestore();
    blockedWrite.mockRestore();
  });
});
