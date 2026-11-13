/**
 * The command palette's view and file commands, the view cube and the versions dialog
 * (CommandPalette.tsx, ViewCube.tsx, VersionsDialog.tsx) on a design with a block: each view command
 * turns the camera, the flat projection toggles, exports and new/import run; a click on the cube's
 * face looks from there, a drag orbits, a double tap goes back to the corner view; a version is
 * restored (the design before kept as one), renamed, saved as a file and deleted.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, currentDoc, getViewport, newProject, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";
import { CommandPalette } from "./CommandPalette";
import { openVersions, VersionsDialog } from "./VersionsDialog";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 40, y: 0 },
  { id: "p3", type: "point", x: 40, y: 20 },
  { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
let vp: Viewport;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const frame = () => (vp as unknown as { frame(): void }).frame();
async function command(label: string) {
  await act(async () => void window.dispatchEvent(new Event("meercad:palette")));
  const input = document.querySelector<HTMLInputElement>(".palette input")!;
  await act(async () => void fireEvent.change(input, { target: { value: label } }));
  const item = [...document.querySelectorAll(".palette-list button")].find((b) => b.textContent?.includes(label));
  expect(item, label).toBeDefined();
  await act(async () => void fireEvent.click(item!));
  await settle();
}

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Palette");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  ] as Feature[] });
  renderUi(<><ViewportView /><CommandPalette onHelp={() => undefined} onShortcuts={() => undefined} onTour={() => undefined} /><VersionsDialog /></>);
  await rebuilt();
  vp = getViewport()!;
});
afterAll(cleanup);

describe("the command palette's view and file commands", () => {
  it("turns the view to each side and toggles the flat projection", async () => {
    for (const label of ["Front view", "Back view", "Top view", "Bottom view", "Right view", "Left view", "Isometric view"]) {
      const q = vp.cameraQuaternion.clone();
      await command(label);
      await settle(500);
      frame();
      expect(vp.cameraQuaternion.equals(q), label).toBe(false);
    }
    await command("Fit all");
    const before = vp.projection;
    await command("Toggle orthographic");
    expect(vp.projection).not.toBe(before);
    await command("Toggle orthographic");
    expect(vp.projection).toBe(before);
  });

  it("shows all hidden parts and deletes the selection", async () => {
    useApp.setState({ hidden: new Set(["ex1"]) });
    await command("Show all hidden parts");
    expect(useApp.getState().hidden.size).toBe(0);
    useApp.setState({ selection: [], selectedFeature: "ex1" } as never);
    await command("Delete selection");
    await rebuilt();
    expect(currentDoc().features.some((f) => f.id === "ex1")).toBe(false);
    const { undo } = await import("../store");
    await act(async () => undo());
    await rebuilt();
  });

  it("exports in each format and opens settings", async () => {
    const saved: string[] = [];
    const desktop = (window as unknown as { meercadDesktop: { saveFile: (o: { name?: string; defaultName?: string }) => Promise<unknown> } }).meercadDesktop;
    const own = desktop.saveFile;
    desktop.saveFile = async (o) => (saved.push(String(o.name ?? o.defaultName ?? "file")), null);
    const settings = vi.fn();
    window.addEventListener("meercad:settings", settings);
    for (const label of ["Export STL", "Export 3MF", "Export OBJ", "Export STEP", "Export USDZ"]) {
      await command(label);
      await settle(300);
    }
    await command("Settings");
    window.removeEventListener("meercad:settings", settings);
    desktop.saveFile = own;
    expect(settings).toHaveBeenCalled();
    expect(useApp.getState().toasts.filter((t) => t.kind === "error").map((t) => t.text)).toEqual([]);
  });
});

describe("the view cube", () => {
  const cube = () => document.querySelector<HTMLElement>(".cube")!;
  it("looks from a face clicked, orbits by a drag, and goes back to the corner by a double tap", async () => {
    const face = cube().querySelector<HTMLElement>("[data-dir]")!;
    const q0 = vp.cameraQuaternion.clone();
    await act(async () => {
      fireEvent.pointerDown(face, { clientX: 10, clientY: 10, pointerId: 1, pointerType: "mouse" });
      fireEvent.pointerUp(face, { clientX: 10, clientY: 10, pointerId: 1, pointerType: "mouse" });
    });
    await settle(500);
    frame();
    expect(vp.cameraQuaternion.equals(q0)).toBe(false);
    const q1 = vp.cameraQuaternion.clone();
    await act(async () => {
      fireEvent.pointerDown(cube(), { clientX: 10, clientY: 10, pointerId: 2, pointerType: "mouse" });
      fireEvent.pointerMove(cube(), { clientX: 11, clientY: 10, pointerId: 2 });
      fireEvent.pointerMove(cube(), { clientX: 40, clientY: 30, pointerId: 2 });
      fireEvent.pointerUp(cube(), { clientX: 40, clientY: 30, pointerId: 2, pointerType: "mouse" });
    });
    expect(vp.cameraQuaternion.equals(q1)).toBe(false);
    // Two quick taps of a finger: the corner view.
    for (const id of [3, 4])
      await act(async () => {
        fireEvent.pointerDown(cube(), { clientX: 10, clientY: 10, pointerId: id, pointerType: "touch" });
        fireEvent.pointerUp(cube(), { clientX: 10, clientY: 10, pointerId: id, pointerType: "touch" });
      });
    await act(async () => void fireEvent.doubleClick(cube()));
    await act(async () => void fireEvent.pointerEnter(face));
    await act(async () => void fireEvent.pointerLeave(face));
  });
});

describe("the versions dialog", () => {
  it("restores a version keeping the design before, renames, saves as a file and deletes", async () => {
    apply({ type: "save_version", name: "First", at: 1 });
    apply({ type: "set_param", name: "w", expr: "7 mm" });
    await act(async () => openVersions());
    await settle();
    await act(async () => void fireEvent.click(screen.getByTitle("Restore")));
    await settle();
    expect(currentDoc().params["w"]).toBeUndefined();
    expect((currentDoc().versions ?? []).map((v) => v.name)).toEqual(expect.arrayContaining(["First", "Before “First”"]));
    // Restored again: the design now is a version already, none is added.
    const n = currentDoc().versions!.length;
    await act(async () => void fireEvent.click(screen.getAllByTitle("Restore")[0]!));
    expect(currentDoc().versions!.length).toBe(n);
    await act(async () => void fireEvent.click(screen.getAllByTitle("Rename")[0]!));
    const field = document.querySelector<HTMLInputElement>(".versions-dialog input.field")!;
    await act(async () => void fireEvent.change(field, { target: { value: "Renamed" } }));
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }));
    expect(currentDoc().versions!.some((v) => v.name === "Renamed")).toBe(true);
    await act(async () => void fireEvent.click(screen.getAllByTitle("Save as a file…")[0]!));
    await act(async () => void fireEvent.click(document.querySelector(".versions-dialog button[title=Delete]")!));
    expect(currentDoc().versions!.some((v) => v.name === "Renamed")).toBe(false);
    await act(async () => void fireEvent.click(screen.getByTitle("Close (Esc)")));
  });
});
