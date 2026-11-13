/**
 * The tool rail (Toolbar.tsx) with the scan pack on a device that scans: the Scan group holds objects,
 * surfaces, rooms, areas and drone photos, each starting its scan; a flyout taller than the window goes
 * to two columns; the mouse leaving the rail closes a group after a moment. On a phone the bar
 * scrolls sideways and a group opens as a menu above it.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("../lib/scan", async (orig) => ({ ...(await orig<typeof import("../lib/scan")>()), canScan: async () => true, scanObject: async (k: string) => void calls.push(`object:${k}`) }));
vi.mock("../lib/roomScan", async (orig) => ({ ...(await orig<typeof import("../lib/roomScan")>()), canScanSpaces: true, scanRoom: async () => void calls.push("room"), scanArea: async () => void calls.push("area") }));
vi.mock("../lib/terrain", async (orig) => ({ ...(await orig<typeof import("../lib/terrain")>()), canBuildTerrain: true, buildTerrain: async () => void calls.push("terrain") }));

import { newProject } from "../store";
import * as layout from "../lib/layout";
import { usePremium } from "../lib/premium";
import { renderUi } from "../../test/ui";
import { Toolbar } from "./Toolbar";

const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const group = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".rail-group > button")].find((b) => b.textContent?.includes(label))!;

beforeAll(async () => {
  await newProject(undefined, "Scan rail");
  usePremium.setState({ tester: true, off: {} });
});
afterAll(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the Scan group", () => {
  it("starts each kind of scan", async () => {
    renderUi(<Toolbar />);
    await settle();
    for (const label of ["Object (photos)", "Object (LiDAR)", "Surface (LiDAR)", "Room (LiDAR)", "Area (guided)", "Area (drone photos)"]) {
      await act(async () => void fireEvent.click(group("Scan")));
      await act(async () => void fireEvent.click(screen.getByText(label)));
    }
    await settle();
    expect(calls).toEqual(["object:object", "object:lidar", "object:surface", "room", "area", "terrain"]);
  });

  it("puts a tall flyout in two columns, and closes a hovered group when the mouse leaves", async () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const was = proto["getBoundingClientRect"];
    proto["getBoundingClientRect"] = function (this: HTMLElement) {
      const two = this.classList.contains("two-columns");
      return { left: 60, top: 0, right: 260, bottom: two ? 900 : 2000, width: 200, height: two ? 900 : 2000, x: 60, y: 0, toJSON: () => ({}) };
    };
    try {
      const g = group("Scan");
      await act(async () => void fireEvent.pointerEnter(g.parentElement!, { pointerType: "mouse" }));
      const flyout = document.querySelector<HTMLElement>(".rail-flyout, [role=menu]")!;
      expect(flyout.classList.contains("two-columns")).toBe(true);
      expect(flyout.style.maxHeight).toMatch(/px/);
      await act(async () => void fireEvent.pointerEnter(document.querySelector(".rail > .rail-items > button.tool, .rail button.tool:not(.group)")!));
      await act(async () => void fireEvent.pointerLeave(document.querySelector(".rail")!, { pointerType: "mouse" }));
      await settle(300);
      expect(g.getAttribute("aria-expanded")).toBe("false");
    } finally {
      proto["getBoundingClientRect"] = was;
    }
  });
});

describe("the phone's bar", () => {
  it("scrolls sideways and opens a group as a menu above it", async () => {
    cleanup();
    vi.spyOn(layout, "useCompact").mockReturnValue(true);
    renderUi(<Toolbar />);
    await settle();
    const rail = document.querySelector<HTMLElement>(".rail")!;
    const items = rail.querySelector<HTMLElement>(".rail-items")!;
    Object.defineProperty(items, "scrollWidth", { configurable: true, value: 1000 });
    Object.defineProperty(items, "clientWidth", { configurable: true, value: 390 });
    items.scrollLeft = 100;
    await act(async () => void items.dispatchEvent(new Event("scroll")));
    expect(rail.dataset["more"]).toBe("both");
    calls.length = 0;
    await act(async () => void fireEvent.click(group("Scan")));
    const item = screen.getAllByRole("menuitem").find((m) => m.textContent?.includes("Room (LiDAR)"))!;
    await act(async () => void fireEvent.click(item));
    await settle();
    expect(calls).toEqual(["room"]);
  });
});
