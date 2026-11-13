import { describe, expect, it } from "vitest";
import { crop, cutHeight, erase, removeLoosePieces, triangles } from "../apps/web/src/lib/glbEdit.js";
import { glb } from "./glbs.js";

const json = (g: Uint8Array) =>
  JSON.parse(
    new TextDecoder().decode(g.subarray(20, 20 + new DataView(g.buffer, g.byteOffset).getUint32(12, true))),
  ) as Record<string, unknown>;

describe("cleaning up a scanned area", () => {
  // A 10 m lawn of 1 m tiles at height 0, a 1 m roof at 2.5 m over one tile, a 10 cm floater far off.
  const tiles = Array.from({ length: 100 }, (_, i) => ({
    x: (i % 10) * 1000,
    y: Math.floor(i / 10) * 1000,
    z: 0,
    s: 1000,
  }));
  const model = glb([...tiles, { x: 2000, y: 2000, z: 2500, s: 1000 }, { x: 30000, y: 30000, z: 0, s: 100 }]);

  it("crops to an outline, either way, and drops the vertices no longer used", () => {
    const square = [
      [0, 0, 0],
      [3000, 0, 0],
      [3000, 3000, 0],
      [0, 3000, 0],
    ] as [number, number, number][];
    const kept = crop(model, square, true)!;
    expect(kept.before).toBe(204);
    expect(kept.after).toBe(9 * 2 + 2);
    expect((json(kept.glb)["accessors"] as { count: number }[])[0]!.count).toBe(10 * 4);
    // The picture survives.
    expect((json(kept.glb)["images"] as unknown[]).length).toBe(1);
    expect(crop(model, square, false)!.after).toBe(204 - 20);
  });

  it("erases under the brush only near the height it was painted at", () => {
    // A stroke across the lawn under the roof: the roof 2.5 m up stays.
    const r = erase(
      model,
      [
        [0, 2500, 0],
        [10000, 2500, 0],
      ],
      400,
    )!;
    expect(r.after).toBe(204 - 20);

    const left = triangles(r.glb).corners;
    let roof = 0;
    for (let i = 2; i < left.length; i += 3) if (left[i]! > 2000) roof++;
    expect(roof).toBe(6);
  });

  it("cuts above a height and removes loose pieces", () => {
    expect(cutHeight(model, 1000, true)!.after).toBe(202);

    const r = removeLoosePieces(model)!;
    expect(r.after).toBe(200);
    expect(r.pieces).toBe(2);
  });
});
