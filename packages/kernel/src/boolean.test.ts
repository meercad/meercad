import { beforeAll, describe, expect, it } from "vitest";
import { FeatureError } from "@meercad/model";
import { Arena } from "./arena.js";
import { Body } from "./body.js";
import { booleanBodies, joinBodies, joinKeptAll, shapeVolume } from "./boolean.js";
import { loadOcct, type OC } from "./occt.js";

let oc: OC;
const arena = new Arena();

/** A box from (x, y, z) with the given sizes. */
function box(id: string, x: number, y: number, z: number, dx: number, dy: number, dz: number): Body {
  const mk = arena.track(new oc.BRepPrimAPI_MakeBox(arena.track(new oc.gp_Pnt(x, y, z)), dx, dy, dz));

  return new Body(oc, arena, id, arena.track(mk.Shape()));
}

beforeAll(async () => {
  oc = await loadOcct();
});

describe("a join that keeps its material", () => {
  it("measures a shape's volume", () => {
    expect(shapeVolume(oc, arena, box("a", 0, 0, 0, 2, 3, 4).shape)).toBeCloseTo(24, 9);
  });

  it("joins layers lying on each other to the sum of their volumes", () => {
    let part = box("re0", 0, 0, 0, 10, 10, 1);
    for (let i = 1; i < 6; i++) part = joinBodies(oc, arena, part, box(`re${i}`, i, 0, i, 10 - i, 10, 1));

    expect(part.bodyId).toBe("re0");
    expect(shapeVolume(oc, arena, part.shape)).toBeCloseTo(100 + 90 + 80 + 70 + 60 + 50, 6);
  });

  it("notices a result that is smaller than an input or does not reach as far", () => {
    const low = box("a", 0, 0, 0, 10, 10, 1);
    const high = box("b", 0, 0, 1, 10, 10, 1);
    const both = booleanBodies(oc, arena, low, high, "fuse");

    expect(joinKeptAll(oc, arena, both, [low, high])).toBe(true);
    // The upper layer dropped: as much volume as the biggest input, but it ends below the layer.
    expect(joinKeptAll(oc, arena, low, [low, high])).toBe(false);

    // Reaches everywhere, but holds less than the big input.
    const frame = booleanBodies(oc, arena, both, box("c", 1, 1, -1, 8, 8, 4), "cut");
    expect(joinKeptAll(oc, arena, frame, [both])).toBe(false);
  });

  it("runs a lossy fuse once more with tolerance and takes that result", () => {
    const low = box("a", 0, 0, 0, 10, 10, 1);
    const high = box("b", 0, 0, 1, 10, 10, 1);
    const fuzzy: number[] = [];

    const lossyFirst: typeof booleanBodies = (o, a, target, tool, op, id, fz = 0) => {
      fuzzy.push(fz);

      return fz ? booleanBodies(o, a, target, tool, op, id, fz) : low;
    };

    const part = joinBodies(oc, arena, low, high, lossyFirst);
    expect(fuzzy).toEqual([0, 1e-5]);
    expect(shapeVolume(oc, arena, part.shape)).toBeCloseTo(200, 6);
  });

  it("fails rather than dropping material when the second try loses it too", () => {
    const low = box("a", 0, 0, 0, 10, 10, 1);
    const high = box("b", 0, 0, 1, 10, 10, 1);
    const attempt = () => joinBodies(oc, arena, low, high, () => low);

    expect(attempt).toThrow(FeatureError);
    expect(attempt).toThrow(/would lose material/);
  });

  it("does not measure imported meshes", () => {
    const low = box("a", 0, 0, 0, 10, 10, 1);
    const high = box("b", 0, 0, 1, 10, 10, 1);
    high.sourceMesh = new Float32Array(9);

    let calls = 0;
    const once: typeof booleanBodies = () => (calls++, low);

    expect(joinBodies(oc, arena, low, high, once)).toBe(low);
    expect(joinBodies(oc, arena, high, low, once)).toBe(low);
    expect(calls).toBe(2);
  });
});
