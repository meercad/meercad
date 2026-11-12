/**
 * The app's frame: the tab strip (TabStrip) switches, renames, reorders and closes projects; the
 * introduction tour (Tour) goes forward and back by keys and is not shown again once done; the
 * command palette (CommandPalette) finds a command by typing, runs it with Enter, and offers the
 * sketch tools inside a sketch.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { emptyDocument } from "@meercad/schema";
import { closeSketch, newProject, startSketch, useApp } from "../store";
import { renderUi, withScreen } from "../../test/ui";
import { testFiles } from "../../test/setup";
import { TabStrip } from "./Tabs";
import { Tour, tourDone } from "./Tour";
import { CommandPalette } from "./CommandPalette";
import { useSketchUi } from "../sketch/state";

const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
const tabNamed = (name: string) => tabs().find((t) => t.textContent?.includes(name))!;

beforeAll(() => withScreen(1280, 800));
afterEach(cleanup);

describe("the tab strip", () => {
  it("switches, renames, reorders and closes projects", async () => {
    await newProject(emptyDocument(), "First");
    await newProject(emptyDocument(), "Second");
    renderUi(<TabStrip />);
    expect(tabs().map((t) => t.textContent?.trim().split("\n")[0])).toEqual(expect.arrayContaining([expect.stringContaining("First"), expect.stringContaining("Second")]));
    await act(async () => void fireEvent.click(tabNamed("First")));
    await waitFor(() => expect(useApp.getState().project?.name).toBe("First"));
    // Double-click the open one to rename it.
    await act(async () => void fireEvent.doubleClick(tabNamed("First")));
    const input = screen.getByLabelText("Project name");
    await act(async () => void fireEvent.change(input, { target: { value: "Renamed" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    await settle();
    expect(useApp.getState().project?.name).toBe("Renamed");
    expect([...testFiles.projects.values()].some((p) => p.name === "Renamed")).toBe(true);
    // Escape keeps the name.
    await act(async () => void fireEvent.doubleClick(tabNamed("Renamed")));
    const again = screen.getByLabelText("Project name");
    await act(async () => void fireEvent.change(again, { target: { value: "Nope" } }));
    await act(async () => void fireEvent.keyDown(again, { key: "Escape" }));
    await settle();
    expect(useApp.getState().project?.name).toBe("Renamed");
    // Drag "Second" before "Renamed".
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => void data.set(k, v), getData: (k: string) => data.get(k) ?? "", get types() { return [...data.keys()]; }, effectAllowed: "" };
    await act(async () => void fireEvent.dragStart(tabNamed("Second"), { dataTransfer }));
    await act(async () => void fireEvent.dragOver(tabNamed("Renamed"), { dataTransfer }));
    await act(async () => void fireEvent.drop(tabNamed("Renamed"), { dataTransfer }));
    const order = useApp.getState().tabs.map((t) => t.name);
    expect(order.indexOf("Second")).toBeLessThan(order.indexOf("Renamed"));
    // A middle click closes a tab.
    const before = useApp.getState().tabs.length;
    await act(async () => void fireEvent(tabNamed("Second"), new MouseEvent("auxclick", { bubbles: true, button: 1 })));
    await settle();
    expect(useApp.getState().tabs.length).toBe(before - 1);
  });
});

describe("the introduction tour", () => {
  it("goes forward and back by keys, and is done once closed", async () => {
    localStorage.removeItem("meercad.tourDone");
    expect(tourDone()).toBe(false);
    let closed = 0;
    renderUi(<Tour onClose={() => closed++} />);
    const title = () => document.querySelector(".tour-card")?.textContent ?? "";
    const first = title();
    await act(async () => void fireEvent.keyDown(window, { key: "ArrowRight" }));
    expect(title()).not.toBe(first);
    await act(async () => void fireEvent.keyDown(window, { key: "ArrowLeft" }));
    expect(title()).toBe(first);
    // Enter to the end, then once more: closed.
    for (let k = 0; k < 20 && !closed; k++) await act(async () => void fireEvent.keyDown(window, { key: "Enter" }));
    expect(closed).toBe(1);
    expect(tourDone()).toBe(true);
    cleanup();
    renderUi(<Tour onClose={() => closed++} />);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(closed).toBe(2);
  });
});

describe("the command palette", () => {
  it("finds a command by typing and runs it with Enter", async () => {
    await newProject(undefined, "Palette");
    renderUi(<CommandPalette onHelp={() => undefined} onShortcuts={() => undefined} onTour={() => undefined} />);
    await act(async () => void window.dispatchEvent(new Event("meercad:palette")));
    await settle();
    const input = document.querySelector<HTMLInputElement>(".palette input, input")!;
    await act(async () => void fireEvent.change(input, { target: { value: "toggle planes" } }));
    const was = useApp.getState().showPlanes;
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    expect(useApp.getState().showPlanes).toBe(!was);
    // Arrow keys move through the list; Escape closes.
    await act(async () => void window.dispatchEvent(new Event("meercad:palette")));
    await settle();
    const box = document.querySelector<HTMLInputElement>(".palette input, input")!;
    await act(async () => void fireEvent.change(box, { target: { value: "fillet" } }));
    await act(async () => void fireEvent.keyDown(box, { key: "ArrowDown" }));
    await act(async () => void fireEvent.keyDown(box, { key: "ArrowUp" }));
    await act(async () => void fireEvent.keyDown(box, { key: "Enter" }));
    expect(useApp.getState().dialog?.feature.op).toMatch(/fillet/);
    await act(async () => (await import("../store")).cancelDialog());
  });

  it("offers the sketch tools inside a sketch", async () => {
    renderUi(<CommandPalette onHelp={() => undefined} onShortcuts={() => undefined} onTour={() => undefined} />);
    await act(async () => startSketch({ ref: "origin.XY" }));
    await act(async () => void window.dispatchEvent(new Event("meercad:palette")));
    await settle();
    const input = document.querySelector<HTMLInputElement>(".palette input, input")!;
    await act(async () => void fireEvent.change(input, { target: { value: "circle" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    expect(useSketchUi.getState().tool).toBe("circle");
    await act(async () => closeSketch());
  });
});
