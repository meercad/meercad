/**
 * The introduction tour (Tour.tsx), by its buttons: the card sits under what a step points at, beside
 * it when there is no room below, over it when neither fits; the back and next buttons move through
 * the steps and the last one closes; storage that cannot be read counts the tour as done.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Tour, tourDone } from "./Tour";

afterAll(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the tour by its buttons", () => {
  it("places the card by the room there is, and moves back and forth to the end", async () => {
    const at = (cls: string, r: { left: number; top: number; width: number; height: number }) => {
      const el = document.createElement("div");
      el.className = cls;
      el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) }) as DOMRect;
      document.body.appendChild(el);
    };
    // Below the tool rail there is room; beside the tree there is; the view fills the window.
    at("toolbar", { left: 0, top: 50, width: 60, height: 100 });
    at("tree", { left: 0, top: 50, width: 200, height: innerHeight - 60 });
    at("view", { left: 0, top: 0, width: innerWidth, height: innerHeight });
    let closed = false;
    render(<Tour onClose={() => void (closed = true)} />);
    const card = () => document.querySelector<HTMLElement>(".tour-card")!;
    const next = () => document.querySelector<HTMLButtonElement>(".tour-card .btn.primary")!;
    expect(card().style.top).toBe("50%");
    await act(async () => void fireEvent.click(next()));
    expect(card().style.top).toBe("168px");
    await act(async () => void fireEvent.click(next()));
    expect(card().style.left).toBe("218px");
    await act(async () => void fireEvent.click(next()));
    expect(card().style.transform).toBe("translate(-50%, -50%)");
    const back = [...document.querySelectorAll<HTMLButtonElement>(".tour-card .btn")].find((b) => !b.classList.contains("primary") && b.querySelector("svg"))!;
    await act(async () => void fireEvent.click(back));
    expect(card().style.left).toBe("218px");
    for (let k = 0; k < 12 && !closed; k++) await act(async () => void fireEvent.click(next()));
    expect(closed).toBe(true);
  });

  it("counts as done when storage cannot be read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(tourDone()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    void screen;
  });
});
