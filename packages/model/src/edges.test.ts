/**
 * Edge cases of the model's planners and versions: sizes too small for a grid, an empty or too
 * narrow outline, a bed of no size; a lithophane's picture and a terrain kept as blobs in a version
 * and missing again on restore; standard parts with impossible sizes.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, type Feature, type MeercadDocument } from "@meercad/schema";
import { areaPlan, drawerFit, GridfinityError, loopArea } from "./gridfinity.js";
import { restored, snapshot, versionChanges, pruneBlobs } from "./versions.js";
import { wallFit } from "./wall.js";
import { leadOf, standardShape } from "./standardParts.js";

const big = "x".repeat(10_000);

describe("grids that do not fit", () => {
  it("refuses a drawer, an area or an outline too small for one cell, and a bed of no size", () => {
    expect(() => drawerFit([30, 30])).toThrow(/the drawer must be at least/);
    expect(() => areaPlan({ rect: [20, 20] } as never)).toThrow(GridfinityError);
    expect(() => areaPlan({ loops: [], gap: 0 } as never)).toThrow(/the outline is empty/);
    expect(() =>
      areaPlan({
        loops: [
          [
            [0, 0],
            [20, 0],
            [20, 20],
            [0, 20],
          ],
        ],
        gap: 0,
      } as never),
    ).toThrow(/no 42 mm cell fits inside the outline/);
    expect(() => areaPlan({ rect: [200, 200] } as never, [0, 100])).toThrow(
      /print bed's usable size must be greater than zero/,
    );
    expect(
      loopArea([
        [0, 0],
        [10, 0],
        [10, 5],
        [0, 5],
      ]),
    ).toBe(50);
    expect(
      loopArea([
        [0, 0],
        [0, 5],
        [10, 5],
        [10, 0],
      ]),
    ).toBe(-50);
  });

  it("refuses a wall board smaller than one hole spacing", () => {
    expect(() => wallFit("opengrid", [10, 10])).toThrow(/the openGrid needs at least/);
    expect(() => wallFit("pegboard", [10, 10], 25.4)).toThrow(/the pegboard needs at least 25.4 mm/);
    // openGrid cells are 28 mm: 100 × 60 mm holds 3 × 2 of them, 8 and 2 mm left at each side.
    expect(wallFit("opengrid", [100, 60])).toEqual({ units: [3, 2], border: [8, 2] });
  });
});

describe("versions with large files", () => {
  const doc = (): MeercadDocument => ({
    ...emptyDocument(),
    features: [
      { id: "li1", op: "lithophane", image: { width: 1, height: 1, pixels: big }, width: 10 } as Feature,
      { id: "im1", op: "import", format: "stl", fileName: "a.stl", data: big } as Feature,
      { id: "im2", op: "import", format: "stl", fileName: "small.stl", data: "abc" } as Feature,
    ],
    references: [
      { id: "rf1", name: "Big", format: "glb", data: big },
      { id: "rf2", name: "Small", format: "glb", data: "xyz" },
    ],
  });

  it("keeps big files once as blobs and puts them back", () => {
    const blobs: Record<string, string> = {};
    const v = snapshot(doc(), "v1", 1, blobs);
    expect(Object.values(blobs)).toEqual([big]);

    const back = restored({ ...doc(), blobs, versions: [v] }, v);
    expect((back.features[0] as { image: { pixels: string } }).image.pixels).toBe(big);
    expect((back.features[1] as { data: string }).data).toBe(big);
    expect(back.references![0]!.data).toBe(big);
    expect(back.references![1]!.data).toBe("xyz");

    // Pruning keeps blobs a version uses.
    const kept = { ...doc(), blobs: { ...blobs, "blob:gone": "z" }, versions: [v] } as MeercadDocument;
    pruneBlobs(kept);
    expect(Object.keys(kept.blobs!)).toEqual(Object.keys(blobs));
  });

  it("says which file is missing when a version cannot be restored", () => {
    const blobs: Record<string, string> = {};
    const v = snapshot(doc(), "v1", 1, blobs);
    expect(() => restored({ ...doc(), blobs: {} }, v)).toThrow(/version "v1": the picture of li1 is missing/);

    const noPicture = {
      ...v,
      state: { ...v.state, features: v.state.features.filter((f) => f.op !== "lithophane") },
    };
    expect(() => restored({ ...doc(), blobs: {} }, noPicture)).toThrow(/the contents of a.stl are missing/);

    const onlyTerrain = { ...v, state: { ...v.state, features: [] } };
    expect(() => restored({ ...doc(), blobs: {} }, onlyTerrain)).toThrow(/the contents of Big are missing/);
  });

  it("tells steps added, removed and changed since a version", () => {
    const blobs: Record<string, string> = {};
    const d = doc();
    const v = snapshot(d, "v1", 1, blobs);
    const now: MeercadDocument = {
      ...d,
      features: [d.features[1]!, { id: "ex9", op: "delete", bodies: ["x"] } as Feature],
    };
    expect(versionChanges(v.state, now)).toMatchObject({ added: ["ex9"], removed: ["li1", "im2"] });
  });
});

describe("standard parts that cannot be made", () => {
  it("refuses lengths of 0, unknown sizes and a magnet of no size", () => {
    expect(leadOf("Tr8x8")).toBe(8);
    expect(leadOf(undefined)).toBeUndefined();
    expect(() => standardShape("socket_screw", { size: "M3", length: 0 })).toThrow(
      /length must be greater than zero/,
    );
    expect(() => standardShape("insert", { size: "M99" })).toThrow(/unknown size "M99"/);
    expect(() => standardShape("insert", { size: "M3", length: 99 })).toThrow(
      /M3 inserts come .* long, not 99 mm/,
    );
    expect(() => standardShape("shaft", { size: "Ø999" })).toThrow(/unknown size "Ø999"/);
    expect(() => standardShape("magnet", { diameter: 0, height: 2 })).toThrow(
      /magnet needs a diameter and a height/,
    );
  });
});
