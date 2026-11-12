/**
 * Terrains (terrain.ts, terrainDraw.ts) in the real 3D view: a model from photos is added, lines and
 * areas drawn on it follow the ground with their true length and area, distances and places read
 * right, the size is corrected from a known distance, and clean-ups replace the model in one step.
 * The ground: a 20 × 20 m flat square at height 0, with a second one 2 m higher beside it.
 */
import { act, cleanup } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentDoc, getViewport, newProject, undo, useApp } from "../store";
import { answer, rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { glb } from "../../../../tests/glbs";
import { addTerrain, buildTerrain, hasTerrain, sceneryOf } from "./terrain";
import {
  addMarkPoint,
  areaOf,
  cancelMarking,
  cutAbove,
  deleteMark,
  distanceText,
  drape,
  drapeFill,
  finishCrop,
  finishMarking,
  lengthOf,
  measurePoint,
  metres,
  placeText,
  removeLoose,
  squareMetres,
  startMarking,
  startScaling,
  undoMarkPoint,
  useTerrainDraw,
} from "./terrainDraw";

const settle = (ms = 50) => act(async () => new Promise((r) => setTimeout(r, ms)));
const ground = glb([
  { x: 0, y: 0, z: 0, s: 20_000 },
  { x: 20_000, y: 0, z: 2_000, s: 20_000 },
]);
const ref = () => currentDoc().references![0]!;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Terrain");
  renderUi(<ViewportView />);
  await rebuilt();
  await act(async () => addTerrain({ folder: "Garden", photos: 42, size: [40_000, 20_000, 2_000], measured: false, geo: { lat: 52.5, lon: 13.4, alt: 34, error: 1.2 } } as never, ground));
  await settle(200);
  const vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("terrains", () => {
  it("adds a model from photos as a reference with its place on Earth", () => {
    expect(hasTerrain()).toBe(true);
    expect(ref()).toMatchObject({ id: "rf1", name: "Garden", format: "glb", geo: { lat: 52.5, lon: 13.4, alt: 34 } });
    expect(sceneryOf(currentDoc())).toHaveLength(1);
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/42 photos → 40 × 20 × 2.0 m, placed by GPS/);
  });

  it("follows the ground: a line's length and an area's size", () => {
    const vp = getViewport()!;
    expect(vp.sceneryHeight(10_000, 10_000)).toBeCloseTo(0, 3);
    expect(vp.sceneryHeight(30_000, 10_000)).toBeCloseTo(2_000, 3);
    // 10 m straight across the flat square.
    const line = drape([[2_000, 10_000, 0], [12_000, 10_000, 0]], false, vp);
    expect(lengthOf(line)).toBeCloseTo(10_000, 0);
    const square: [number, number, number][] = [[2_000, 2_000, 0], [12_000, 2_000, 0], [12_000, 12_000, 0], [2_000, 12_000, 0]];
    const fill = drapeFill(square, vp);
    const { flat, ground: along } = areaOf(square, fill);
    expect(flat).toBeCloseTo(100e6, -3);
    expect(along).toBeCloseTo(100e6, -5);
    expect(metres(12_400)).toBe("12.4 m");
    expect(metres(1_234_000)).toBe("1.23 km");
    expect(squareMetres(250e6)).toBe("250 m²");
    expect(squareMetres(1.2e10)).toBe("1.20 ha");
  });

  it("reads distances, slopes, bearings and places", () => {
    // 30 m east and 40 m north, 5 m up: 50.2 m, level 50 m, 10 %, 37° from north.
    expect(distanceText([0, 0, 0], [30_000, 40_000, 5_000])).toBe("50.2 m · level 50.0 m · ↑ 5.0 m (10 %) · 37° from north");
    expect(placeText(ref(), [1_000, 2_000, 500])).toMatch(/^E 1\.00 · N 2\.00 · height 0\.50\n52\.5000180, 13\.4000148 · 34\.5 m$/);
    expect(placeText({ ...ref(), geo: undefined }, [1_000, 2_000, 500])).toBe("E 1.00 · N 2.00 · height 0.50");
  });

  it("keeps lines, areas, notes and points drawn on it", async () => {
    startMarking("line");
    addMarkPoint([0, 0, 0]);
    finishMarking();
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/at least two points/);
    addMarkPoint([5_000, 0, 0]);
    addMarkPoint([9_000, 0, 0]);
    undoMarkPoint();
    addMarkPoint([10_000, 0, 0]);
    finishMarking();
    expect(ref().marks).toEqual([expect.objectContaining({ id: "m1", kind: "line", points: [[0, 0, 0], [5_000, 0, 0], [10_000, 0, 0]] })]);
    startMarking("area");
    for (const p of [[0, 0, 0], [5_000, 0, 0], [5_000, 5_000, 0]] as [number, number, number][]) addMarkPoint(p);
    finishMarking();
    startMarking("note");
    addMarkPoint([1_000, 1_000, 0]);
    await answer("Tree");
    startMarking("point");
    addMarkPoint([2_000, 2_000, 0]);
    await answer();
    expect(ref().marks!.map((m) => [m.kind, m.text])).toEqual([["line", undefined], ["area", undefined], ["note", "Tree"], ["point", "P1"]]);
    deleteMark("rf1", "m2");
    expect(ref().marks!.map((m) => m.id)).toEqual(["m1", "m3", "m4"]);
    startMarking("line");
    cancelMarking();
    expect(useTerrainDraw.getState().kind).toBeNull();
  });

  it("corrects its size from a distance whose real length is known", async () => {
    startScaling("rf1");
    measurePoint([0, 0, 0], "rf1");
    measurePoint([10_000, 0, 0], "rf1");
    await answer("12.5");
    // 12.5 m instead of 10 m: everything 1.25 times as big, the marks too.
    expect(ref().scale).toBeCloseTo(1.25, 9);
    expect(ref().marks!.find((m) => m.id === "m1")!.points[2]).toEqual([12_500, 0, 0]);
  });

  it("cleans the model up in one step that Undo takes back", async () => {
    const before = ref().data;
    // Above 1 m over the lowest ground: the square 2 m up goes, in one step.
    const cut = cutAbove("rf1");
    await answer("1");
    await act(async () => cut);
    await settle(100);
    expect(ref().data).not.toBe(before);
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/^Cut above 1.00 m: 2 of 4 triangles removed/);
    await act(async () => undo());
    expect(ref().data).toBe(before);
    await act(async () => removeLoose("rf1"));
    await settle(100);
    // Keeping what is inside the first square takes the second one away.
    startMarking("crop");
    for (const p of [[-100, -100, 0], [21_000, -100, 0], [21_000, 21_000, 0], [-100, 21_000, 0]] as [number, number, number][]) addMarkPoint(p);
    finishCrop(true);
    await settle(100);
    expect(ref().data).not.toBe(before);
    await act(async () => undo());
    expect(ref().data).toBe(before);
  });

  it("builds a model from photos through the Mac app", async () => {
    const desktop = (window as unknown as { meercadDesktop: { photos: { build: (f?: string) => Promise<unknown> } } }).meercadDesktop;
    const was = desktop.photos.build;
    desktop.photos.build = async () => ({ folder: "DCIM", photos: 12, size: [5_000, 5_000, 500], measured: true, data: ground });
    try {
      await act(async () => buildTerrain("/photos"));
      expect(currentDoc().references!.at(-1)!.name).toMatch(/^Area /);
      expect(useApp.getState().toasts.at(-1)!.text).toMatch(/Area scanned: 5.0 × 5.0 × 0.5 m, true size/);
    } finally {
      desktop.photos.build = was;
    }
  });
});
