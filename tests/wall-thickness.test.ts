import { describe, expect, it } from "vitest";
import type { BodyMesh } from "@meercad/kernel";
import { measureWalls, thinSpots, WALL_SAMPLES } from "../apps/web/src/lib/wallMeasure";

/** A closed box as a body mesh, faces pointing out. */
function box(min: number[], max: number[]): BodyMesh {
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const indices = quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  return { bodyId: "b", positions: Float32Array.from(v.flat()), normals: new Float32Array(24), indices: Uint32Array.from(indices) } as unknown as BodyMesh;
}

describe("wall thickness", () => {
  it("a plate thinner than the wall asked for is one thin spot; a block has none", async () => {
    const plate = await measureWalls(box([0, 0, 0], [20, 20, 0.6]), 1, { samples: WALL_SAMPLES.fast });
    expect(plate!.stats.min).toBeCloseTo(0.6, 1);
    expect(plate!.stats.thin).toBeGreaterThan(0.5);
    expect(plate!.spots.length).toBeGreaterThan(0);
    expect(plate!.spots[0]!.mm).toBeCloseTo(0.6, 1);
    const block = await measureWalls(box([0, 0, 0], [20, 20, 20]), 1, { samples: WALL_SAMPLES.fast });
    expect(block!.spots).toEqual([]);
    expect(block!.stats.thin).toBe(0);
  });

  it("box measures only the surface inside it", async () => {
    const m = await measureWalls(box([0, 0, 0], [20, 20, 0.6]), 1, { samples: WALL_SAMPLES.fast, box: { min: [0, 0, -1], max: [5, 5, 2] } });
    expect(m!.spots.every((p) => p.at[0] <= 5 && p.at[1] <= 5)).toBe(true);
    const measured = [...m!.wall].filter((d) => !Number.isNaN(d)).length;
    expect(measured).toBeGreaterThan(0);
    expect(measured).toBeLessThan(m!.wall.length / 4);
  });

  it("samples close together make one spot, far apart two", () => {
    const s = (d: number, x: number) => ({ d, a: 1, c: [x, 0, 0] });
    const spots = thinSpots([s(0.4, 0), s(0.5, 1), s(0.6, 50), s(2, 80)], 1);
    expect(spots).toEqual([
      { at: [0, 0, 0], mm: 0.4, areaMm2: 2 },
      { at: [50, 0, 0], mm: 0.6, areaMm2: 1 },
    ]);
  });
});

describe("wall thickness on a fine mesh", () => {
  it("a quick check measures a share of the triangles and keeps the areas", async () => {
    const plate = box([0, 0, 0], [20, 20, 0.6]);
    const fine = await measureWalls(plate, 1, { samples: 4000 });
    const quick = await measureWalls(plate, 1, { samples: 1000 });
    const measured = (m: typeof fine) => [...m!.wall].filter((d) => !Number.isNaN(d)).length;
    expect(measured(quick)).toBeLessThan(measured(fine));
    expect(quick!.stats.thin).toBeCloseTo(fine!.stats.thin, 1);
    expect(quick!.stats.min).toBeCloseTo(0.6, 1);
  });
});
