import { describe, expect, it } from "vitest";
import { validateDocument } from "@meercad/schema";
import { roomDocument, WALL, type RoomScan } from "../../apps/web/src/lib/roomDoc.js";
import { newSession } from "./helpers.js";

// A 4 × 3 m room, 2.5 m high (floor at 0.30 m in the scan's frame), as RoomPlan reports it: a door
// in the south wall, a window in the east wall, a table.
const z0 = 300;
const wall = (id: string, cx: number, cy: number, along: [number, number], length: number) => ({
  id,
  center: [cx, cy, z0 + 1250] as [number, number, number],
  along,
  size: [length, 2500, 0] as [number, number, number],
});
const scan: RoomScan = {
  walls: [
    wall("S", 2000, 0, [1, 0], 4000),
    wall("E", 4000, 1500, [0, 1], 3000),
    wall("N", 2000, 3000, [-1, 0], 4000),
    wall("W", 0, 1500, [0, -1], 3000),
  ],
  doors: [{ id: "d", center: [1000, 0, z0 + 1000], along: [1, 0], size: [900, 2000, 0], wall: "S" }],
  windows: [{ id: "w", center: [4000, 1500, z0 + 1400], along: [0, 1], size: [1200, 1000, 0] }],
  openings: [],
  floors: [
    {
      id: "f",
      center: [2000, 1500, z0],
      along: [1, 0],
      size: [4000, 3000, 0],
      corners: [
        [0, 0, z0],
        [4000, 0, z0],
        [4000, 3000, z0],
        [0, 3000, z0],
      ],
    },
  ],
  objects: [{ category: "table", center: [2000, 1500, z0 + 375], along: [1, 0], size: [1600, 800, 750] }],
};
const names = {
  wall: (n: number) => `Wall ${n}`,
  floor: "Floor",
  furniture: "Furniture",
  object: (c: string) => c,
  door: "Door",
  window: "Window",
  opening: "Opening",
};

describe("room scans become parts", () => {
  it("builds floor, walls with their door and window cut out, and the furniture", async () => {
    const doc = roomDocument(scan, names);
    expect(validateDocument(doc).ok).toBe(true);

    const { report } = (await newSession()).rebuild(doc);
    expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    // Floor, four walls, the table.
    expect(report.bodies).toHaveLength(6);

    const vol = (name: string) =>
      report.bodies.find((b) => doc.features.find((f) => f.id === b.id)?.name === name)!.volume;
    const wallVol = (length: number) => (length + WALL) * WALL * 2500;
    expect(vol("Wall 1")).toBeCloseTo(wallVol(4000) - 900 * WALL * 2000, -3);
    expect(vol("Wall 2")).toBeCloseTo(wallVol(3000) - 1200 * WALL * 1000, -3);
    expect(vol("Wall 3")).toBeCloseTo(wallVol(4000), -3);
    expect(vol("Floor")).toBeCloseTo(4000 * 3000 * 100, -3);
    expect(vol("table")).toBeCloseTo(1600 * 800 * 750, -3);

    // The floor's top is at height 0, the walls stand on it and the window sill is at 0.9 m.
    const floor = report.bodies.find((b) => doc.features.find((f) => f.id === b.id)?.name === "Floor")!;
    expect(floor.bbox.max[2]).toBeCloseTo(0, 3);
    expect(doc.partGroups?.[0]?.parts).toHaveLength(1);
  });
});
