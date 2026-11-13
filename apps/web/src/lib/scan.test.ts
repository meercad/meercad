/**
 * Scanning on the iPhone and iPad (scan.ts) with a stand-in for the native Scan plugin: a device that
 * cannot scan says why (for objects and for LiDAR); a scan given up says nothing, one that failed
 * says so; a finished scan of two pieces comes in as two mesh parts, its size in the message; an
 * object scan with its picture comes in textured.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeStl } from "@meercad/io";
import { prism } from "../../../../tests/acceptance/meshes";

const plugin = vi.hoisted(() => ({
  caps: { scan: true, surface: true } as { scan: boolean; surface?: boolean; reason?: string },
  scan: vi.fn(),
  imported: vi.fn(async () => undefined),
  files: new Map<string, string>(),
}));
vi.mock("@capacitor/core", async (orig) => ({
  ...(await orig<typeof import("@capacitor/core")>()),
  registerPlugin: () => ({ capabilities: async () => plugin.caps, scan: plugin.scan, imported: plugin.imported }),
}));
vi.mock("@capacitor/filesystem", async (orig) => {
  const real = await orig<typeof import("@capacitor/filesystem")>();
  return { ...real, Filesystem: { ...real.Filesystem, readFile: async ({ path }: { path: string }) => ({ data: plugin.files.get(path.replace("file://", "")) ?? "" }) } };
});

import { newProject, useApp } from "../store";
import { scanObject } from "./scan";

const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const stl = (x: number) => b64(writeStl([{ positions: Float32Array.from(prism([[x, 0], [x + 10, 0], [x + 10, 10], [x, 10]], 5)), indices: Uint32Array.from({ length: 36 }, (_, i) => i) }]));
const parts = () => useApp.getState().doc.features.filter((f) => f.op === "import");

beforeAll(async () => {
  await newProject(undefined, "Scans");
});
afterEach(() => plugin.scan.mockReset());

describe("scanning", () => {
  it("brings in a scan of two pieces as two parts, and says how big it is", async () => {
    plugin.files.set("/tmp/a.stl", stl(0));
    plugin.files.set("/tmp/b.stl", stl(20));
    plugin.scan.mockResolvedValueOnce({ path: "/tmp/a.stl", paths: ["/tmp/a.stl", "/tmp/b.stl"], folder: "/tmp", triangles: 24, size: [30, 10, 5], photos: 12, seconds: 40 });
    await scanObject("lidar");
    expect(parts()).toHaveLength(2);
    expect(toasts()).toMatch(/Scan: 30\.0 × 10\.0 × 5\.0 mm · 24 triangles · 12 photos/);
    expect(plugin.imported).toHaveBeenCalledWith({ folder: "/tmp" });
  });

  it("brings in an object scan with its picture", async () => {
    plugin.files.set("/tmp/c.stl", stl(40));
    plugin.files.set("/tmp/c.uv", b64(new Uint8Array(36 * 8)));
    plugin.files.set("/tmp/c.jpg", b64(new Uint8Array([0xff, 0xd8, 0xff])));
    plugin.scan.mockResolvedValueOnce({ path: "/tmp/c.stl", folder: "/tmp", triangles: 12, size: [10, 10, 5], photos: 0, seconds: 3, uvs: "/tmp/c.uv", texture: "/tmp/c.jpg" });
    await scanObject("object");
    const last = parts().at(-1) as { texture?: unknown };
    expect(last.texture).toBeDefined();
  });

  it("says nothing when the scan was given up, and says so when it failed", async () => {
    const before = useApp.getState().toasts.length;
    plugin.scan.mockRejectedValueOnce({ code: "cancelled", message: "cancelled" });
    await scanObject("surface");
    expect(useApp.getState().toasts.length).toBe(before);
    plugin.scan.mockRejectedValueOnce({ code: "failed", message: "Tracking lost" });
    await scanObject("surface");
    expect(toasts()).toMatch(/Tracking lost/);
  });

  it("says why a device cannot scan", async () => {
    plugin.caps.scan = false;
    plugin.caps.surface = false;
    plugin.caps.reason = "Needs iOS 18";
    await scanObject("object");
    expect(toasts()).toMatch(/Needs iOS 18/);
    await scanObject("lidar");
    expect(toasts()).toMatch(/Scanning with LiDAR needs an iPhone or iPad with LiDAR/);
    expect(plugin.scan).not.toHaveBeenCalled();
  });
});
