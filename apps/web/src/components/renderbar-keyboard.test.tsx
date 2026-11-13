/**
 * The rendered view's bar (RenderBar.tsx) and keyboard detection (keyboard.ts): picture sizes
 * twice the view for "as on screen"; the turntable turns on and off; a picture is saved at the size
 * picked (with or without background), and one that cannot be made says so. On a touch screen the
 * shortcut hints hide until a real keyboard shows up, which is then remembered; typing in a field
 * does not count.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Viewport } from "@meercad/viewport";
import { getViewport, newProject, useApp } from "../store";
import { pickMenu, rebuilt, renderUi, withScreen } from "../../test/ui";
import { imageSizes, RenderBar, saveRender } from "./RenderBar";
import { ViewportView } from "./ViewportView";
import { installKeyboardDetection } from "../lib/keyboard";

let vp: Viewport;
beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Render bar");
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
});
afterAll(cleanup);

describe("the rendered view's bar", () => {
  it("offers twice the view as on screen, and the usual sizes", () => {
    const s = imageSizes({ width: 800, height: 600 });
    expect(s.map((x) => [x.width, x.height])).toEqual([[1600, 1200], [1920, 1080], [3840, 2160], [2048, 2048]]);
    expect(s[0]!.label).toMatch(/1600 × 1200/);
  });

  it("turns the turntable on and off, and saves a picture at the size picked", async () => {
    const exit = vi.fn();
    renderUi(<RenderBar vp={vp} onExit={exit} />);
    await act(async () => void fireEvent.click(screen.getByText("Turntable")));
    expect(vp.turntable).toBe(true);
    await act(async () => void fireEvent.click(screen.getByText("Turntable")));
    expect(vp.turntable).toBe(false);
    await act(async () => void fireEvent.click(screen.getByText("Transparent")));
    const render = vi.spyOn(vp, "renderImage");
    await act(async () => void fireEvent.click(screen.getByText("Save image")));
    await pickMenu(/^Full HD/);
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(render).toHaveBeenCalledWith(1920, 1080, { transparent: true });
    await act(async () => void fireEvent.click(screen.getByTitle("Back to the working view")));
    expect(exit).toHaveBeenCalled();
  });

  it("says so when the picture cannot be made", async () => {
    vi.spyOn(vp, "renderImage").mockImplementationOnce(() => {
      throw new Error("out of GPU memory");
    });
    await saveRender(vp, 100, 100, false);
    expect(useApp.getState().toasts.map((t) => t.text).join(" ")).toMatch(/Could not save the picture: out of GPU memory/);
    // A canvas that gives no picture.
    vi.spyOn(vp, "renderImage").mockReturnValueOnce({ width: 1, height: 1, toBlob: (cb: (b: Blob | null) => void) => cb(null) } as never);
    await saveRender(vp, 100, 100, false);
    expect(useApp.getState().toasts.map((t) => t.text).join(" ")).toMatch(/could not be encoded/);
  });
});

describe("keyboard detection", () => {
  it("hides the shortcut hints on a touch screen until a key outside a field is pressed, and remembers it", () => {
    localStorage.removeItem("meercad.keyboard");
    const own = window.matchMedia;
    const fake = (q: string) => ({ matches: q === "(pointer: coarse)", addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList;
    window.matchMedia = fake as typeof window.matchMedia;
    try {
      installKeyboardDetection();
      const root = document.documentElement;
      expect(root.classList.contains("no-keyboard")).toBe(true);
      // Typing a letter into a field: the on-screen keyboard, no hardware keyboard yet.
      const input = document.createElement("input");
      document.body.append(input);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(root.classList.contains("no-keyboard")).toBe(true);
      // A navigation key in the field is a real keyboard.
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      expect(root.classList.contains("no-keyboard")).toBe(false);
      expect(localStorage.getItem("meercad.keyboard")).toBe("1");
      input.remove();
      // Next start: remembered.
      installKeyboardDetection();
      expect(root.classList.contains("no-keyboard")).toBe(false);
    } finally {
      window.matchMedia = own;
      document.documentElement.classList.remove("no-keyboard");
    }
  });
});
