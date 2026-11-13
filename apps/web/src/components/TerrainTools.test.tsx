/**
 * The terrain tools' bar (TerrainTools.tsx) on a real terrain: the clean-up menu starts cropping,
 * erasing, removing what is above or loose pieces; while marking, Enter finishes, Delete takes the
 * last point back and Escape cancels (not while typing in a field); a crop keeps or removes inside
 * once it has three points; a part set onto the terrain is raised and lowered 10 mm a step (100 mm
 * a step from 1 m), typed, and cancelled.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, newProject, useApp } from "../store";
import { pickMenu, rebuilt, renderUi, withScreen } from "../../test/ui";
import { glb } from "../../../../tests/glbs";
import { addTerrain, useTerrainPlace } from "../lib/terrain";
import * as draw from "../lib/terrainDraw";
import { addMarkPoint, cancelMarking, startMarking, useTerrainDraw } from "../lib/terrainDraw";
import { cleanUpMenu, TerrainHud } from "./TerrainTools";

const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 10, y: 0 },
  { id: "p3", type: "point", x: 10, y: 10 },
  { id: "p4", type: "point", x: 0, y: 10 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
let ref = "";

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Terrain tools");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  ] as Feature[] });
  await rebuilt();
  await act(async () => addTerrain({ folder: "Yard", photos: 3, size: [1000, 1000, 10], measured: false } as never, glb([{ x: 0, y: 0, z: 0, s: 1000 }])));
  ref = useApp.getState().doc.references![0]!.id;
  renderUi(<TerrainHud />);
  await settle();
});
afterAll(cleanup);

describe("the terrain tools", () => {
  it("starts each clean-up tool from its menu", async () => {
    const above = vi.spyOn(draw, "cutAbove").mockResolvedValue(undefined as never);
    const loose = vi.spyOn(draw, "removeLoose").mockResolvedValue(undefined as never);
    for (const [label, kind] of [["Crop…", "crop"], ["Eraser", "erase"]] as const) {
      await act(async () => cleanUpMenu(ref, 10, 10));
      await settle();
      await pickMenu(label);
      expect(useTerrainDraw.getState().kind).toBe(kind);
      cancelMarking();
    }
    await act(async () => cleanUpMenu(ref, 10, 10));
    await settle();
    await pickMenu("Remove everything above…");
    expect(above).toHaveBeenCalledWith(ref);
    await act(async () => cleanUpMenu(ref, 10, 10));
    await settle();
    await pickMenu("Remove loose pieces");
    expect(loose).toHaveBeenCalledWith(ref);
    above.mockRestore();
    loose.mockRestore();
  });

  it("takes keys while marking: Delete takes a point back, Escape cancels, typing in a field does not count", async () => {
    await act(async () => {
      startMarking("line", ref);
      addMarkPoint([100, 100, 0], ref);
      addMarkPoint([200, 100, 0], ref);
    });
    await act(async () => void fireEvent.keyDown(document.body, { key: "Backspace" }));
    expect(useTerrainDraw.getState().points).toHaveLength(1);
    const input = document.createElement("input");
    document.body.append(input);
    await act(async () => void fireEvent.keyDown(input, { key: "Escape" }));
    expect(useTerrainDraw.getState().kind).toBe("line");
    input.remove();
    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(useTerrainDraw.getState().kind).toBeNull();
    // Enter finishes a line of two points.
    await act(async () => {
      startMarking("line", ref);
      addMarkPoint([100, 100, 0], ref);
      addMarkPoint([200, 100, 0], ref);
    });
    await act(async () => void fireEvent.keyDown(document.body, { key: "Enter" }));
    expect(useTerrainDraw.getState().kind).toBeNull();
  });

  it("keeps or removes inside a crop of three points", async () => {
    const crop = vi.spyOn(draw, "finishCrop").mockResolvedValue(undefined as never);
    await act(async () => {
      startMarking("crop", ref);
      for (const p of [[0, 0, 0], [500, 0, 0], [500, 500, 0]] as [number, number, number][]) addMarkPoint(p, ref);
    });
    await act(async () => void fireEvent.click(screen.getByText("Remove inside")));
    await act(async () => void fireEvent.click(screen.getByText("Keep inside")));
    expect(crop.mock.calls.map((c) => c[0])).toEqual([false, true]);
    await act(async () => void fireEvent.click(screen.getByTitle("Take back the last point")));
    crop.mockRestore();
    cancelMarking();
  });

  it("raises and lowers a part set onto the terrain, by 10 mm and from 1 m by 100 mm", async () => {
    await act(async () => useTerrainPlace.setState({ body: "ex1", offset: 0, move: null }));
    await act(async () => void fireEvent.click(screen.getByTitle("Raise")));
    expect(useTerrainPlace.getState().offset).toBe(10);
    await act(async () => void fireEvent.click(screen.getByTitle("Lower")));
    expect(useTerrainPlace.getState().offset).toBe(0);
    await act(async () => void fireEvent.change(screen.getByLabelText("Height above the ground"), { target: { value: "1000" } }));
    expect(useTerrainPlace.getState().offset).toBe(1000);
    await act(async () => void fireEvent.click(screen.getByTitle("Raise")));
    expect(useTerrainPlace.getState().offset).toBe(1100);
    await act(async () => void fireEvent.click(screen.getByTitle("Cancel")));
    expect(useTerrainPlace.getState().body).toBeNull();
  });
});
