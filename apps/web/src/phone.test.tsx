/**
 * The phone layout (lib/layout.ts and what follows it) in an iPhone-sized window, 390 × 844: the
 * page says it is compact, the tools sit in a bar at the bottom with a Parts button that opens and
 * closes the parts sheet, a sketch shows a Constrain button for its sheet instead, and the parts
 * sheet makes way for a sketch or a step's dialog.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// An iPhone-sized window before the app reads the screen size.
vi.hoisted(() => {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 390, height: 844 });
  // happy-dom reads "a, b" as both instead of either: answer a list as the browser does.
  const own = window.matchMedia.bind(window);
  window.matchMedia = (q: string) => {
    const parts = q.split(",").map((x) => own(x.trim()));
    const list = own(q);
    return new Proxy(list, { get: (t, k) => (k === "matches" ? parts.some((p) => p.matches) : typeof Reflect.get(t, k) === "function" ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, k)) });
  };
});
vi.mock("./lib/thumbnails", async (orig) => ({ ...(await orig<typeof import("./lib/thumbnails")>()), startBackgroundPictures: () => undefined, fillThumbnails: async () => undefined }));
import { App } from "./App";
import { closeSketch, newProject, startFeature, startSketch, cancelDialog, useApp } from "./store";
import { isCompact, usePhoneSheets } from "./lib/layout";
import { renderUi } from "../test/ui";

const settle = (ms = 50) => act(async () => new Promise((r) => setTimeout(r, ms)));
const barButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".toolbar.rail button.tool")].find((b) => b.textContent?.trim() === label);

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
    const constrain = barButton("Constrain")!;
    expect(constrain).toBeDefined();
    await act(async () => void fireEvent.click(constrain));
    expect(usePhoneSheets.getState().constraints).toBe(true);
    await act(async () => void fireEvent.click(barButton("Constrain")!));
    expect(usePhoneSheets.getState().constraints).toBe(false);
    await act(async () => closeSketch());
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
