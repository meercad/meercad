/**
 * A model from drone photos on the iPad (terrain.ts with the Terrain plugin): its progress shows, the
 * model is read from the file the plugin wrote and goes into the design; a build given up says
 * nothing; one that failed says why; stopping goes to the plugin; a second build while one runs is
 * refused.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { glb } from "../../../../tests/glbs";

const plugin = vi.hoisted(() => ({
  build: vi.fn(),
  cancel: vi.fn(async () => undefined),
  progress: null as ((e: { progress: number; step: string }) => void) | null,
  files: new Map<string, string>(),
}));
vi.mock("@capacitor/core", async (orig) => ({
  ...(await orig<typeof import("@capacitor/core")>()),
  registerPlugin: () => ({
    build: plugin.build,
    cancel: plugin.cancel,
    addListener: async (_: string, fn: (e: { progress: number; step: string }) => void) => ((plugin.progress = fn), { remove: async () => void (plugin.progress = null) }),
  }),
}));
vi.mock("@capacitor/filesystem", async (orig) => {
  const real = await orig<typeof import("@capacitor/filesystem")>();
  return { ...real, Filesystem: { ...real.Filesystem, readFile: async ({ path }: { path: string }) => ({ data: plugin.files.get(path.replace("file://", "")) ?? "" }), deleteFile: async () => undefined } };
});
vi.mock("./persistence", async (orig) => ({ ...(await orig<typeof import("./persistence")>()), desktop: undefined }));

import { newProject, useApp } from "../store";
import { buildTerrain, cancelTerrain } from "./terrain";

const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
beforeAll(async () => {
  await newProject(undefined, "Garden");
});
afterEach(() => plugin.build.mockReset());

describe("a model from photos on the iPad", () => {
  it("shows progress, reads the model and adds it to the design", async () => {
    const data = glb([{ x: 0, y: 0, z: 0, s: 2000 }]);
    plugin.files.set("/tmp/garden.glb", btoa(Array.from(data, (c) => String.fromCharCode(c)).join("")));
    const details: (string | undefined)[] = [];
    plugin.build.mockImplementationOnce(async () => {
      plugin.progress?.({ progress: 0.5, step: "model" });
      details.push(useApp.getState().tasks.at(-1)?.detail);
      plugin.progress?.({ progress: 1, step: "writing" });
      return { path: "/tmp/garden.glb", folder: "Garden photos", photos: 40, triangles: 12, size: [2000, 2000, 10], seconds: 90 };
    });
    await buildTerrain();
    expect(details).toEqual(["Building the model"]);
    expect(useApp.getState().doc.references ?? []).toHaveLength(1);
    expect(plugin.progress).toBeNull();
  });

  it("says nothing when given up, says why when it failed, refuses a second build, and stops", async () => {
    plugin.build.mockResolvedValueOnce({ cancelled: true });
    const before = useApp.getState().toasts.length;
    await buildTerrain();
    expect(useApp.getState().toasts.length).toBe(before);
    plugin.build.mockRejectedValueOnce(new Error("Too few photos overlap"));
    await buildTerrain();
    expect(toasts()).toMatch(/No model came from the photos: Too few photos overlap/);
    let finish!: (v: unknown) => void;
    plugin.build.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const first = buildTerrain();
    await new Promise((r) => setTimeout(r, 0));
    await buildTerrain();
    expect(toasts()).toMatch(/A model from photos is already being built/);
    cancelTerrain();
    expect(plugin.cancel).toHaveBeenCalled();
    finish({ cancelled: true });
    await first;
  });
});
