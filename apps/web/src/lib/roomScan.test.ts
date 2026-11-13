/**
 * Scanning rooms and areas on the iPhone and iPad (roomScan.ts) with a stand-in for the native Room
 * plugin: a room of four 4 m walls with a door and a bed opens as a new project and says what it
 * found; a scan with no walls says to scan again; given up says nothing, failed says so; a device
 * without LiDAR says why; an area comes in as a terrain around the open design.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { glb } from "../../../../tests/glbs";

const plugin = vi.hoisted(() => ({
  caps: { room: true, area: true },
  scanRoom: vi.fn(),
  scanArea: vi.fn(),
  files: new Map<string, string>(),
}));
vi.mock("@capacitor/core", async (orig) => ({
  ...(await orig<typeof import("@capacitor/core")>()),
  registerPlugin: () => ({ capabilities: async () => plugin.caps, scanRoom: plugin.scanRoom, scanArea: plugin.scanArea }),
}));
vi.mock("@capacitor/filesystem", async (orig) => {
  const real = await orig<typeof import("@capacitor/filesystem")>();
  return { ...real, Filesystem: { ...real.Filesystem, readFile: async ({ path }: { path: string }) => ({ data: plugin.files.get(path.replace("file://", "")) ?? "" }) } };
});

import { newProject, useApp } from "../store";
import { scanArea, scanRoom } from "./roomScan";

const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
const wall = (id: string, center: [number, number, number], along: [number, number]) => ({ id, center, along, size: [4000, 2500, 0] as [number, number, number] });
afterEach(() => {
  plugin.scanRoom.mockReset();
  plugin.scanArea.mockReset();
});

describe("scanning a room", () => {
  it("opens a room as a project of parts and says what it found", async () => {
    plugin.scanRoom.mockResolvedValueOnce({
      walls: [wall("w1", [0, -2000, 1250], [1, 0]), wall("w2", [2000, 0, 1250], [0, 1]), wall("w3", [0, 2000, 1250], [-1, 0]), wall("w4", [-2000, 0, 1250], [0, -1])],
      doors: [{ id: "d1", center: [0, -2000, 1000], along: [1, 0], size: [900, 2000, 0], wall: "w1" }],
      windows: [],
      openings: [],
      floors: [],
      objects: [{ category: "bed", center: [0, 0, 250], along: [1, 0], size: [2000, 1600, 500] }],
    });
    await scanRoom();
    expect(useApp.getState().project?.name).toMatch(/^Room /);
    expect(useApp.getState().doc.features.length).toBeGreaterThan(4);
    expect(toasts()).toMatch(/4 walls, 1 doors and windows, 1 pieces of furniture/);
  });

  it("says to scan again without walls, nothing when given up, and why when it failed", async () => {
    plugin.scanRoom.mockResolvedValueOnce({ walls: [], doors: [], windows: [], openings: [], floors: [], objects: [] });
    await scanRoom();
    expect(toasts()).toMatch(/No walls were found/);
    const before = useApp.getState().toasts.length;
    plugin.scanRoom.mockRejectedValueOnce({ code: "cancelled" });
    await scanRoom();
    expect(useApp.getState().toasts.length).toBe(before);
    plugin.scanRoom.mockRejectedValueOnce({ code: "failed", message: "Room too dark" });
    await scanRoom();
    expect(toasts()).toMatch(/Room too dark/);
    plugin.scanArea.mockRejectedValueOnce({ code: "failed" });
    await scanArea();
    expect(toasts()).toMatch(/Scanning failed/);
  });
});

describe("scanning an area", () => {
  it("adds the area as a terrain around the open design", async () => {
    await newProject(undefined, "Garden");
    const data = glb([{ x: 0, y: 0, z: 0, s: 3000 }]);
    plugin.files.set("/tmp/area.glb", btoa(Array.from(data, (c) => String.fromCharCode(c)).join("")));
    plugin.scanArea.mockResolvedValueOnce({ path: "/tmp/area.glb", photos: 0, size: [3000, 3000, 10], measured: true });
    await scanArea();
    expect(useApp.getState().doc.references ?? []).toHaveLength(1);
  });

  it("says why a device without LiDAR cannot scan rooms or areas", async () => {
    vi.resetModules();
    plugin.caps = { room: false, area: false };
    // Asked once per start: a fresh copy of the app asks again.
    const fresh = await import("./roomScan");
    const store = await import("../store");
    const said = () => store.useApp.getState().toasts.map((t) => t.text).join(" | ");
    await fresh.scanRoom();
    expect(said()).toMatch(/Scanning rooms needs an iPhone or iPad with LiDAR/);
    await fresh.scanArea();
    expect(said()).toMatch(/Scanning areas needs an iPhone or iPad with LiDAR/);
  });
});
