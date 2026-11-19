/** A scanned room as a design: floor, walls with their cut-outs and furniture boxes. */
import { describe, expect, it } from "vitest";
import type { ExtrudeFeature, Feature, SketchFeature } from "@meercad/schema";
import { roomDocument, WALL, type RoomScan, type RoomSurface } from "./roomDoc";

const names = {
  wall: (n: number) => `Wand ${n}`,
  floor: "Boden",
  furniture: "Möbel",
  object: (category: string) => `Möbel ${category}`,
  door: "Tür",
  window: "Fenster",
  opening: "Öffnung",
};

const empty: RoomScan = { walls: [], doors: [], windows: [], openings: [], floors: [], objects: [] };

/** A wall 4 m long and 2.5 m high, its foot at z = 0. */
const wall = (id: string, center: [number, number], along: [number, number]): RoomSurface => ({
  id,
  center: [center[0], center[1], 1250],
  along,
  size: [4000, 2500, 0],
});

const byName = (features: Feature[], name: string) => features.filter((feature) => feature.name === name);
const extrude = (features: Feature[], name: string) =>
  byName(features, name).find((feature) => feature.op === "extrude") as ExtrudeFeature;
const sketchOf = (features: Feature[], name: string) =>
  byName(features, name).find((feature) => feature.op === "sketch") as SketchFeature;
const corners = (sketch: SketchFeature) =>
  sketch.entities.flatMap((entity) => (entity.type === "point" ? [[entity.x, entity.y]] : []));

describe("roomDocument", () => {
  it("makes an empty design from an empty scan", () => {
    expect(roomDocument(empty, names)).toEqual({
      format: "meercad/1",
      params: {},
      features: [],
      rollback: null,
    });
  });

  it("takes the floor's measured outline, extruded downwards", () => {
    const doc = roomDocument(
      {
        ...empty,
        floors: [
          { id: "f0", center: [0, 0, 0], along: [1, 0], size: [0, 0, 0], corners: [[0, 0, 0]] },
          {
            id: "f1",
            center: [0, 0, 0],
            along: [1, 0],
            size: [0, 0, 0],
            corners: [
              [0.4, 0, 0],
              [3000, 0, 0],
              [3000, 2000, 0],
            ],
          },
        ],
      },
      names,
    );

    expect(corners(sketchOf(doc.features, "Boden"))).toEqual([
      [0, 0],
      [3000, 0],
      [3000, 2000],
    ]);
    expect(extrude(doc.features, "Boden")).toMatchObject({ distance: 100, mode: "new_body", flip: true });
    expect(sketchOf(doc.features, "Boden").entities.at(-1)).toMatchObject({ p1: "p3", p2: "p1" });
  });

  it("builds walls a wall thickness longer, a floor around them and cuts doors and windows", () => {
    const scan: RoomScan = {
      ...empty,
      walls: [wall("w1", [2000, 0], [1, 0]), wall("w2", [0, 2000], [0, 1])],
      // A floor without an outline: the box around the walls instead.
      floors: [{ id: "f1", center: [2000, 2000, 0], along: [1, 0], size: [0, 0, 0] }],
      doors: [{ id: "d1", wall: "w2", center: [0, 1000, 1000], along: [0, 1], size: [900, 2000, 0] }],
      // No wall given: the nearest one.
      windows: [{ id: "x1", center: [2500, 30, 1500], along: [1, 0], size: [1000, 1000, 0] }],
      openings: [],
    };
    const doc = roomDocument(scan, names);
    const features = doc.features;

    expect(corners(sketchOf(features, "Boden"))).toEqual([
      [0, 0],
      [4000, 0],
      [4000, 4000],
      [0, 4000],
    ]);
    expect(corners(sketchOf(features, "Wand 1"))).toEqual([
      [-60, -60],
      [4060, -60],
      [4060, 60],
      [-60, 60],
    ]);
    expect(extrude(features, "Wand 1")).toMatchObject({ distance: 2500, mode: "new_body" });
    expect(extrude(features, "Wand 1").flip).toBeUndefined();

    const door = extrude(features, "Tür");
    const windowCut = extrude(features, "Fenster");

    expect(door).toMatchObject({ mode: "cut", targets: [extrude(features, "Wand 2").id], distance: 2000 });
    expect(windowCut).toMatchObject({
      mode: "cut",
      targets: [extrude(features, "Wand 1").id],
      distance: 1000,
    });
    // The window sits 1 m up: on a level plane of its own.
    expect((sketchOf(features, "Fenster").plane as { ref: string }).ref).toMatch(/^pl/);
    expect(features.find((feature) => feature.op === "plane")).toMatchObject({
      name: "1.00 m",
      offset: 1000,
    });
    expect(corners(sketchOf(features, "Fenster"))[0]).toEqual([2000, -(WALL + 100) / 2 + 30]);
    expect(doc.partGroups).toBeUndefined();
  });

  it("measures from the lowest wall and cuts what reaches below the floor only down to it", () => {
    const low = { ...wall("w1", [0, 0], [1, 0]), center: [0, 0, 1350] as [number, number, number] };
    const doc = roomDocument(
      {
        ...empty,
        walls: [low],
        doors: [{ id: "d1", wall: "w9", center: [0, 0, 1000], along: [1, 0], size: [900, 2000, 0] }],
        openings: [{ id: "o1", center: [0, 0, 1600], along: [1, 0], size: [500, 500, 0] }],
      },
      names,
    );

    // The wall's foot (z = 100) is the floor; the door's bottom lies 100 below it.
    expect(sketchOf(doc.features, "Wand 1").plane).toEqual({ ref: "origin.XY" });
    expect(sketchOf(doc.features, "Tür").plane).toEqual({ ref: "origin.XY" });
    expect(extrude(doc.features, "Tür").distance).toBe(1900);
    // The opening's bottom lies 1.25 m above the floor: a plane of its own.
    expect(doc.features.filter((feature) => feature.op === "plane")).toHaveLength(1);
  });

  it("shares a level plane between parts at the same height", () => {
    const doc = roomDocument(
      {
        ...empty,
        objects: [
          { category: "table", center: [0, 0, 1000], along: [1, 0], size: [1000, 600, 40] },
          { category: "shelf", center: [2000, 0, 1003], along: [0, 1], size: [800, 300, 40] },
        ],
      },
      names,
    );
    const planes = doc.features.filter((feature) => feature.op === "plane");

    expect(planes).toHaveLength(1);
    expect(sketchOf(doc.features, "Möbel table").plane).toEqual(sketchOf(doc.features, "Möbel shelf").plane);
    expect(doc.partGroups).toEqual([
      {
        name: "Möbel",
        parts: [extrude(doc.features, "Möbel table").id, extrude(doc.features, "Möbel shelf").id],
      },
    ]);
    expect(Object.values(doc.partColors!)).toEqual(["#c8a27c", "#c8a27c"]);
  });

  it("skips cut-outs when there is no wall", () => {
    const doc = roomDocument(
      { ...empty, doors: [{ id: "d1", center: [0, 0, 1000], along: [1, 0], size: [900, 2000, 0] }] },
      names,
    );

    expect(doc.features).toEqual([]);
  });
});
