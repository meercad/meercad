/**
 * More of the app's state (store.ts) with the real kernel: a lithophane shows first with a coarse
 * picture and then the fine one; while its value is dragged the picture stays coarse, and letting go
 * builds it fine again; a rebuild the kernel cannot do says so (as a toast, or on the preview); a
 * face tool on a mesh part says to convert it first, a sketch there starts on a plane to pick; and
 * with nothing picked a new sketch waits for its plane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "@meercad/schema";
import { writeStl } from "@meercad/io";
import { prism } from "../../../tests/acceptance/meshes";
import { apply, cancelDialog, kernel, newProject, rebuildNow, scheduleRebuild, setDraftTextures, startFeature, startSketch, useApp } from "./store";
import { testCall } from "./lib/mcpBridge";

const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
const idle = async () => {
  // The rebuild starts in a microtask: let it begin, then wait until it is done.
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(() => expect(useApp.getState().building).toBe(false), { timeout: 30_000, interval: 50 });
};
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const picture = btoa(String.fromCharCode(...Array.from({ length: 64 }, (_, i) => (i * 4) % 256)));

afterEach(() => {
  vi.restoreAllMocks();
  cancelDialog();
});

describe("rebuilding", () => {
  it("shows a lithophane coarse first, then fine; dragged, coarse until let go", async () => {
    await newProject(undefined, "Litho");
    const rebuilds: unknown[] = [];
    const own = kernel.rebuild.bind(kernel);
    vi.spyOn(kernel, "rebuild").mockImplementation((doc, opts) => (rebuilds.push(opts), own(doc, opts)));
    apply({ type: "add_features", features: [{ id: "li1", op: "lithophane", image: { width: 8, height: 8, pixels: picture }, width: 40 } as Feature] });
    await idle();
    // A quick one with a coarse picture, then the fine one.
    expect(rebuilds.some((o) => (o as { draft?: boolean }).draft === true)).toBe(true);
    expect(rebuilds.at(-1)).toMatchObject({ props: false });
    expect((rebuilds.at(-1) as { draft?: boolean }).draft).toBeUndefined();
    rebuilds.length = 0;
    setDraftTextures(true);
    scheduleRebuild();
    await idle();
    expect(rebuilds.every((o) => (o as { draft?: boolean }).draft === true)).toBe(true);
    setDraftTextures(true);
    setDraftTextures(false);
    await idle();
    expect(rebuilds.length).toBeGreaterThan(1);
  });

  it("says when the kernel cannot rebuild, as a toast or on the preview", async () => {
    await newProject(undefined, "Broken kernel");
    vi.spyOn(kernel, "rebuild").mockRejectedValueOnce(new Error("out of memory"));
    scheduleRebuild();
    await idle();
    expect(toasts()).toMatch(/Rebuild failed: out of memory/);
    // While a step's preview shows, the error goes on the preview.
    apply({ type: "add_features", features: [{ id: "pr1", op: "primitive", shape: "box", size: [10, 10, 10], mode: "new_body" } as Feature] });
    await idle();
    startFeature("primitive");
    await idle();
    const seen: string[] = [];
    const off = useApp.subscribe((st) => void (st.previewError && seen.push(st.previewError)));
    vi.spyOn(kernel, "rebuild").mockRejectedValueOnce(new Error("broke on the preview"));
    scheduleRebuild();
    await idle();
    off();
    expect(seen.join(" ")).toMatch(/broke on the preview/);
  });
});

describe("tools on mesh parts and planes", () => {
  it("asks to convert a mesh part before a face tool, and lets a sketch pick its plane", async () => {
    await testCall("new_project", { name: "Mesh tools" });
    const stl = writeStl([{ positions: Float32Array.from(prism([[0, 0], [20, 0], [20, 20], [0, 20]], 5)), indices: Uint32Array.from({ length: 36 }, (_, i) => i) }]);
    const id = ((await testCall("import_file", { name: "m.stl", base64: b64(stl) })) as { added: string[] }).added[0]!;
    await rebuildNow();
    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === id)!;
    useApp.setState({ selection: [{ kind: "face", bodyId: id, face: 0, tags: m.faceTags[0]!, point: [1, 1, 5], normal: [0, 0, 1] }] });
    startFeature("fillet");
    expect(useApp.getState().dialog).toBeNull();
    expect(toasts()).toMatch(/mesh/i);
    // A sketch from a mesh part's face: the selection goes, the plane is picked next.
    startFeature("sketch");
    expect(useApp.getState().selection).toEqual([]);
    expect(useApp.getState().pickingSketchPlane).toBe(true);
    useApp.setState({ pickingSketchPlane: false });
    startSketch();
    expect(useApp.getState().pickingSketchPlane).toBe(true);
    useApp.setState({ pickingSketchPlane: false });
  });
});
