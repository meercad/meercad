import { describe, expect, it } from "vitest";
import type { BodyMesh } from "@meercad/kernel";
import { measureWalls, speckArea, thinSpots, WALL_SAMPLES } from "../apps/web/src/lib/wallMeasure";

/** A closed box as a body mesh, faces pointing out. */
function box(min: number[], max: number[]): BodyMesh {
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  const v = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const indices = quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);

  return {
    bodyId: "b",
    positions: Float32Array.from(v.flat()),
    normals: new Float32Array(24),
    indices: Uint32Array.from(indices),
  } as unknown as BodyMesh;
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

  it("a wall of exactly the minimum is not thin", async () => {
    const m = await measureWalls(box([0, 0, 0], [20, 20, 2.4]), 2.4, { samples: WALL_SAMPLES.fast });
    expect(m!.stats.thin).toBe(0);
    expect(m!.spots).toEqual([]);
  });

  it("box measures only the surface inside it", async () => {
    const m = await measureWalls(box([0, 0, 0], [20, 20, 0.6]), 1, {
      samples: WALL_SAMPLES.fast,
      box: { min: [0, 0, -1], max: [5, 5, 2] },
    });
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

/** A bar along Z with a triangle as its cross-section (corners counter-clockwise in XY), 30 long. */
function bar(a: [number, number], b: [number, number], c: [number, number]): BodyMesh {
  const v = [a, b, c].flatMap(([x, y]) => [x, y, 0]).concat([a, b, c].flatMap(([x, y]) => [x, y, 30]));
  // Bottom, top, and the three sides (a–b, b–c, c–a), wound outwards.
  const indices = [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5];

  return {
    bodyId: "b",
    positions: Float32Array.from(v),
    normals: new Float32Array(18),
    indices: Uint32Array.from(indices),
  } as unknown as BodyMesh;
}

describe("edges are no walls", () => {
  const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

  it("a bar with corners of 80° and a blade of 20° is thin at the blade only", async () => {
    // Base 10 wide on the X axis, both base corners 80°: the two long sides meet in a 20° blade above.
    const height = 5 * tan(80);
    const m = (await measureWalls(bar([-5, 0], [5, 0], [0, height]), 1, { samples: WALL_SAMPLES.fine }))!;

    // Right beside the base corners the material is as thin as one likes, measured round the
    // corner; those rays count for nothing. The blade is thinner than 1 mm in its last 2.8 mm.
    expect(m.spots.length).toBeGreaterThan(0);

    for (const spot of m.spots) expect(spot.at[1]).toBeGreaterThan(height - 1 / tan(20) - 0.2);

    expect(m.stats.absoluteMin!).toBeLessThan(0.2);
    expect(m.spots[0]!.mm).toBeGreaterThan(0.02);
  });

  it("a bar with corners of 70°, 70° and 40° has thin places at the 40° blade, none at the 70° corners", async () => {
    const height = 5 * tan(70);
    const m = (await measureWalls(bar([-5, 0], [5, 0], [0, height]), 1, { samples: WALL_SAMPLES.fine }))!;

    expect(m.spots.length).toBeGreaterThan(0);

    for (const spot of m.spots) expect(spot.at[1]).toBeGreaterThan(height - 1 / tan(40) - 0.2);
  });
});

describe("the wall a thin place is named by", () => {
  const s = (d: number, a: number, x: number, measured?: number) => ({
    d,
    a,
    c: [x, 0, 0],
    ...(measured === undefined ? {} : { measured }),
  });

  it("is the thinnest that covers more than a speck, not a sliver's", () => {
    // 0.005 mm on a strip of 0.01 mm² (a feather edge), then the wall of 1.2 mm round it.
    const spots = thinSpots([s(0.005, 0.01, 0), s(0.008, 0.01, 0.1), s(1.2, 3, 1), s(1.5, 40, 2)], 2.4);

    expect(spots).toEqual([{ at: [1, 0, 0], mm: 1.2, areaMm2: 43.02 }]);
    expect(speckArea(2.4)).toBeCloseTo(1.44, 9);
    expect(speckArea(1)).toBe(0.5);
  });

  it("leaves out a place that is a speck altogether, and lists the thinnest place first", () => {
    const spots = thinSpots(
      [s(0.005, 0.01, 0), s(0.3, 2, 50), s(0.2, 2, 100)].sort((a, b) => a.d - b.d),
      1,
    );

    expect(spots).toEqual([
      { at: [100, 0, 0], mm: 0.2, areaMm2: 2 },
      { at: [50, 0, 0], mm: 0.3, areaMm2: 2 },
    ]);
  });

  it("on a quick check takes two samples to name a place by a small one", () => {
    // Each sample stands for five triangles (area 2.5) but measured only one (0.5).
    expect(thinSpots([s(0.06, 2.5, 0, 0.5), s(1.1, 2.5, 1, 0.5)], 2.4)).toEqual([
      { at: [1, 0, 0], mm: 1.1, areaMm2: 5 },
    ]);
    // One sample that measured more than a speck itself names its place.
    expect(thinSpots([s(0.6, 10, 0, 2)], 2.4)).toEqual([{ at: [0, 0, 0], mm: 0.6, areaMm2: 10 }]);
    // A single small sample: listed by what it stands for, with its own wall.
    expect(thinSpots([s(0.6, 2.5, 0, 0.5)], 2.4)).toEqual([{ at: [0, 0, 0], mm: 0.6, areaMm2: 2.5 }]);
  });

  it("looks at 200 places at most and returns the asked number", () => {
    const many = Array.from({ length: 205 }, (_, i) => s(0.5, 1, i * 10));

    expect(thinSpots(many, 1)).toHaveLength(12);
    expect(thinSpots(many, 1, 500)).toHaveLength(200);
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
