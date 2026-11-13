/**
 * The top bar (TopBar.tsx) on a phone: the project name opens the open projects (switch, new, rename,
 * close); the "…" menu exports every variant as a zip and a sketch as DXF or SVG, sends to an
 * installed slicer, and opens AR on the iPhone.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./io", async (orig) => ({
  ...(await orig<typeof import("./io")>()),
  exportVariants: async (f: string) => void calls.push(`variants:${f}`),
  exportSketch: (id: string, f: string) => void calls.push(`sketch:${id}:${f}`),
  sendToSlicer: async (id: string) => void calls.push(`slicer:${id}`),
  viewInAr: async () => void calls.push("ar"),
}));
vi.mock("../lib/native", async (orig) => ({ ...(await orig<typeof import("../lib/native")>()), nativeApp: true }));

import * as layout from "../lib/layout";
import { replaceDocument, newProject, rebuildNow, useApp } from "../store";
import { usePremium } from "../lib/premium";
import { useSlicers } from "../lib/slicers";
import { answer, pickMenu, renderUi } from "../../test/ui";
import { TopBar } from "./TopBar";

const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 10, y: 0 },
  { id: "p3", type: "point", x: 10, y: 10 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p1" },
];
const more = async () => act(async () => void fireEvent.click(screen.getByTitle("File, settings, help")));
const names = async () => act(async () => void fireEvent.click(screen.getByTitle("Open projects")));

beforeAll(async () => {
  vi.spyOn(layout, "useCompact").mockReturnValue(true);
  usePremium.setState({ tester: true, off: {} });
  useSlicers.setState({ slicers: [{ id: "bambu", name: "Bambu Studio" }] as never });
  await newProject(undefined, "First");
  await newProject(undefined, "Phone");
  replaceDocument({
    ...useApp.getState().doc,
    params: { w: "10 mm" },
    variants: [{ name: "Small", params: { w: "5 mm" } }, { name: "Large", params: { w: "20 mm" } }],
    features: [{ id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] }] as Feature[],
  });
  await rebuildNow();
  renderUi(<TopBar />);
  await settle();
});
afterAll(() => {
  vi.restoreAllMocks();
  useSlicers.setState({ slicers: [] });
  cleanup();
});

describe("the phone's top bar", () => {
  it("exports variants and sketches, sends to a slicer and opens AR from the … menu", async () => {
    await more();
    await pickMenu("Export");
    await pickMenu(/^All \d+ variants/);
    await pickMenu("3MF");
    await more();
    await pickMenu("Export");
    await pickMenu(/^Sketch/);
    await pickMenu("DXF (laser)");
    await more();
    await pickMenu("Export");
    await pickMenu(/^Sketch/);
    await pickMenu("SVG");
    await more();
    await pickMenu("Send to slicer");
    await pickMenu("Bambu Studio");
    await more();
    await pickMenu("View in AR");
    await settle();
    expect(calls).toEqual(["variants:3mf", "sketch:sk1:dxf", "sketch:sk1:svg", "slicer:bambu", "ar"]);
  });

  it("switches, renames, closes and adds projects from the name", async () => {
    await names();
    await pickMenu("First");
    await settle(100);
    expect(useApp.getState().project?.name).toBe("First");
    await names();
    await pickMenu("Rename…");
    await answer("Renamed");
    await settle(100);
    expect(useApp.getState().project?.name).toBe("Renamed");
    await names();
    await pickMenu("Rename…");
    await answer("  ");
    expect(useApp.getState().project?.name).toBe("Renamed");
    const open = useApp.getState().tabs.length;
    await names();
    await pickMenu("New part");
    await settle(100);
    expect(useApp.getState().tabs.length).toBe(open + 1);
    await names();
    await pickMenu("Close");
    await settle(100);
    expect(useApp.getState().tabs.length).toBe(open);
  });
});
