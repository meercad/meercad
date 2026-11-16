/**
 * The phone layout (lib/layout.ts and what follows it) in an iPhone-sized window, 390 × 844: the
 * page says it is compact, the tools sit in a bar at the bottom with a Parts button that opens and
 * closes the parts sheet, a fixed set of tools with "More" for the rest, groups that open as a sheet
 * from below, a sketch's Constrain button in its header, and the parts sheet making way for a sketch or
 * a step's dialog.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// An iPhone-sized window before the app reads the screen size.
vi.hoisted(() => {
  (
    window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }
  ).happyDOM.setViewport({ width: 390, height: 844 });

  // happy-dom reads "a, b" as both instead of either: answer a list as the browser does.
  const own = window.matchMedia.bind(window);

  window.matchMedia = (q: string) => {
    const parts = q.split(",").map((x) => own(x.trim()));
    const list = own(q);

    return new Proxy(list, {
      get: (t, k) =>
        k === "matches"
          ? parts.some((p) => p.matches)
          : typeof Reflect.get(t, k) === "function"
            ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t)
            : Reflect.get(t, k),
    });
  };
});
vi.mock("./lib/thumbnails", async (orig) => ({
  ...(await orig<typeof import("./lib/thumbnails")>()),
  startBackgroundPictures: () => undefined,
  fillThumbnails: async () => undefined,
}));
import { App } from "./App";
import { closeSketch, newProject, startFeature, startSketch, cancelDialog, useApp } from "./store";
import { isCompact, usePhoneSheets } from "./lib/layout";
import { renderUi } from "../test/ui";

const settle = (ms = 50) => act(async () => new Promise((r) => setTimeout(r, ms)));
const barButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".toolbar.rail button.tool")].find(
    (b) => b.textContent?.trim() === label,
  );

beforeAll(async () => {
  localStorage.setItem("meercad.tourDone", "1");
  renderUi(<App />);
  await settle();
  await act(async () => newProject(undefined, "Phone"));
  await settle();
});
afterAll(cleanup);

describe("the phone layout", () => {
  it("knows it is on a phone and says so to the stylesheet", () => {
    expect(window.innerWidth).toBe(390);
    expect(isCompact()).toBe(true);
    expect(document.documentElement.hasAttribute("data-compact")).toBe(true);
  });

  it("opens and closes the parts sheet from the bar", async () => {
    const parts = barButton("Parts")!;
    expect(parts).toBeDefined();

    const was = useApp.getState().sideOpen;
    await act(async () => void fireEvent.click(parts));
    expect(useApp.getState().sideOpen).toBe(!was);
    await act(async () => void fireEvent.click(barButton("Parts")!));
    expect(useApp.getState().sideOpen).toBe(was);
  });

  it("makes the parts sheet give way to a sketch, which offers its constraints sheet", async () => {
    await act(async () => useApp.setState({ sideOpen: true }));
    await act(async () => startSketch({ ref: "origin.XY" }));
    await settle();
    expect(useApp.getState().sideOpen).toBe(false);

    // The bar has no room for it: Constrain sits in the sketch's header, beside Done.
    expect(barButton("Constrain")).toBeUndefined();

    const constrain = () => document.querySelector<HTMLButtonElement>(".sketch-hud .sketch-constrain")!;
    expect(constrain()).not.toBeNull();
    await act(async () => void fireEvent.click(constrain()));
    expect(usePhoneSheets.getState().constraints).toBe(true);
    await act(async () => void fireEvent.click(constrain()));
    expect(usePhoneSheets.getState().constraints).toBe(false);

    // The sketch bar: the main drawing tools and More, which holds the rest under headings.
    const labels = [...document.querySelectorAll(".toolbar.rail button.tool > span")].map(
      (e) => e.textContent,
    );
    expect(labels).toEqual(["Select", "Line", "Rectangle", "Circle", "Dimension", "More"]);
    await act(async () => void fireEvent.click(barButton("More")!));

    const sheet = document.querySelector(".tool-sheet")!;
    expect(sheet.textContent).toContain("Trim");
    expect(sheet.textContent).toContain("3-point arc");
    expect(sheet.textContent).toContain("Polygon");
    await act(async () => void fireEvent.click(sheet.querySelector('[aria-label="Close"]')!));
    expect(document.querySelector(".tool-sheet")).toBeNull();
    await act(async () => closeSketch());
  });

  it("keeps a fixed bar: the main groups and More with the rest", () => {
    const labels = [...document.querySelectorAll(".toolbar.rail button.tool > span")].map(
      (e) => e.textContent,
    );
    expect(labels).toEqual(["Parts", "Sketch", "Create", "Components", "Modify", "More"]);
  });

  it("opens a group as a sheet from below, its tools under headings, and starts one", async () => {
    await act(async () => void fireEvent.click(barButton("Components")!));

    const sheet = document.querySelector(".tool-sheet")!;
    expect(sheet).not.toBeNull();
    // In the body, not inside the bar (whose glass would be the frame of a fixed sheet).
    expect(sheet.closest(".toolbar")).toBeNull();

    const headings = [...sheet.querySelectorAll(".rail-flyout-heading")].map((e) => e.textContent);
    expect(headings).toEqual(["Mechanics", "Storage and labels"]);

    const gear = [...sheet.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) =>
      b.textContent?.startsWith("Gear"),
    )!;
    await act(async () => void fireEvent.click(gear));
    await settle();
    expect(document.querySelector(".tool-sheet")).toBeNull();
    expect(useApp.getState().dialog?.feature.op).toBe("gear");
    await act(async () => cancelDialog());

    // More: everything that is not on the bar, measuring and joints included.
    await act(async () => void fireEvent.click(barButton("More")!));

    const more = document.querySelector(".tool-sheet")!.textContent;
    for (const name of ["Transform", "Joints", "Measure", "Mirror"]) expect(more).toContain(name);
    await act(async () => void fireEvent.pointerDown(document.querySelector(".tool-sheet-backdrop")!));
    expect(document.querySelector(".tool-sheet")).toBeNull();
  });

  it("makes the parts sheet give way to a step's dialog", async () => {
    await act(async () => useApp.setState({ sideOpen: true }));
    await act(async () => startFeature("box"));
    await settle();
    expect(useApp.getState().sideOpen).toBe(false);
    await act(async () => cancelDialog());
    // The tour is not offered on a phone.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Introduction" })).toBeNull());
  });
});
