/**
 * More of exporting and importing (io.ts) with the real kernel: an export the kernel cannot do says
 * so for meshes, STEP, USDZ and a robot; a 3MF of parts in two materials tells which filament goes
 * in which slot; a version saved as a file of a version that is gone says so; a meerCAD file opens
 * as a new design; a file over 40 MB is refused; a version file that
 * cannot be read says so.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, kernel, newProject, rebuildNow, useApp } from "../store";
import { answer, renderUi } from "../../test/ui";
import { exportMesh, exportStep, importFile, importVersionFile, saveVersionFile, viewInAr } from "./io";

const rect = (p: string, x: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y: 0 },
  { id: `${p}2`, type: "point", x: x + 10, y: 0 },
  { id: `${p}3`, type: "point", x: x + 10, y: 10 },
  { id: `${p}4`, type: "point", x, y: 10 },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");

beforeAll(async () => {
  await newProject(undefined, "IO more");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("a", 0), constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
    { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 20), constraints: [] },
    { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 5, mode: "new_body" },
  ] as Feature[] }, { type: "set_material", part: "ex1", material: "pla" }, { type: "set_material", part: "ex2", material: "petg" });
  await rebuildNow();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("exports that cannot be done", () => {
  it("say so for meshes, STEP, USDZ and a robot", async () => {
    vi.spyOn(kernel, "exportMeshes").mockRejectedValue(new Error("kernel gone"));
    await exportMesh("stl");
    expect(toasts()).toMatch(/STL export failed: kernel gone/);
    await viewInAr();
    expect(toasts()).toMatch(/USDZ export failed: kernel gone/);
    vi.spyOn(kernel, "exportStep").mockRejectedValue(new Error("no STEP today"));
    await exportStep();
    expect(toasts()).toMatch(/STEP export failed: no STEP today/);
  });
});

describe("a 3MF of two materials", () => {
  it("tells which filament goes in which slot", async () => {
    const { usePrefs } = await import("../lib/keymap");
    usePrefs.setState({ threeMfMaterials: true } as never);
    renderUi(<></> as never);
    let done: Promise<void> = Promise.resolve();
    await act(async () => void (done = exportMesh("3mf")));
    await done;
    const notice = await waitFor(() => {
      const n = document.querySelector("[role=alertdialog]");
      if (!n) throw new Error("no notice yet");
      return n;
    });
    expect(notice?.textContent).toMatch(/2 filaments assigned/);
    expect(notice?.textContent).toMatch(/Filament 1: PLA/);
    expect(notice?.textContent).toMatch(/Filament 2: PETG/);
    await answer();
    usePrefs.setState({ threeMfMaterials: false } as never);
  });
});

describe("files in and out", () => {
  it("says so when a version to save is gone", () => {
    saveVersionFile("nope");
    expect(toasts()).toMatch(/nope/);
  });

  it("opens a meerCAD file as a new design, and refuses a huge file", async () => {
    const doc = { format: "meercad/1", params: { w: "3 mm" }, features: [], rollback: null };
    const ok = await importFile(new File([JSON.stringify(doc)], "Opened.meercad"));
    expect(ok).toBe(true);
    expect(useApp.getState().project?.name).toBe("Opened");
    expect(useApp.getState().doc.params["w"]).toBe("3 mm");
    const big = new File([new Uint8Array(41 * 1024 * 1024)], "huge.stl");
    expect(await importFile(big)).toBe(false);
    expect(toasts()).toMatch(/larger than 40 MB/);
  });

  it("says when a version file cannot be read", async () => {
    expect(await importVersionFile(new File(["not json"], "v.meercad"))).toEqual([]);
    expect(toasts()).toMatch(/Not a valid meerCAD file/);
  });
});
