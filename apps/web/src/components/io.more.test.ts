/**
 * More of files in and out (io.ts) with the real kernel: every variant exported as a file of its
 * own, each of its own size; a version saved as a file and brought back in as versions (twice
 * brings nothing new); meshes from 3MF and OBJ, a STEP file and a DXF drawing imported at their
 * size; files that cannot be read say why and start no empty design.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readStl, write3mf, writeDxf, writeObj, writeStl } from "@meercad/io";
import type { Feature, SketchEntity } from "@meercad/schema";
import { prism } from "../../../../tests/acceptance/meshes";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import { exportVariants, importFile, importVersionFile, stepFile, variantFiles } from "./io";

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
const block: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "h", mode: "new_body" },
];
const lastToast = () => useApp.getState().toasts.at(-1)?.text ?? "";

/** The volume of a closed mesh from its triangles (divergence theorem). */
function meshVolume(positions: Float32Array, indices?: Uint32Array) {
  let v = 0;
  const n = indices ? indices.length : positions.length / 3;
  const at = (i: number) => (indices ? indices[i]! : i) * 3;

  for (let t = 0; t < n; t += 3) {
    const [a, b, c] = [at(t), at(t + 1), at(t + 2)];
    v +=
      positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!) -
      positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!) +
      positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }

  return v / 6;
}

const mesh = (corners: Float64Array) => ({
  positions: Float32Array.from(corners),
  indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i),
});

const lastVolume = async () => {
  const out = await rebuildNow();

  return out.report.bodies.at(-1)!;
};

beforeAll(async () => {
  await newProject(undefined, "Files");
  apply(
    { type: "set_param", name: "h", expr: "10 mm" },
    { type: "add_features", features: block },
    { type: "set_variant", name: "Thin", params: { h: "5 mm" } },
    { type: "set_variant", name: "Tall/Big", params: { h: "30 mm" } },
  );
  await rebuildNow();
});

describe("variants", () => {
  it("exports each variant as a file of its own size, with a safe name", async () => {
    const files = await variantFiles("stl");
    expect(Object.keys(files).sort()).toEqual(["Files-Tall-Big.stl", "Files-Thin.stl"]);

    const vol = (name: string) => {
      return meshVolume(readStl(files[name]!).vertices);
    };

    expect(vol("Files-Thin.stl")).toBeCloseTo(40 * 20 * 5, 0);
    expect(vol("Files-Tall-Big.stl")).toBeCloseTo(40 * 20 * 30, 0);

    const objs = await variantFiles("obj");
    expect(Object.keys(objs).some((k) => k.endsWith(".obj"))).toBe(true);
    // The design itself is built as it was again.
    expect((await rebuildNow()).report.bodies[0]!.volume).toBeCloseTo(8000, 6);
  });

  it("says when there are none, and when one does not build", async () => {
    apply({ type: "set_variant", name: "Broken", params: { h: "0 mm" } });
    await expect(variantFiles("stl")).rejects.toThrow(/variant “Broken” does not build/);
    await exportVariants("stl");
    expect(lastToast()).toMatch(/STL export failed: variant “Broken” does not build/);
    apply(
      { type: "delete_variant", name: "Broken" },
      { type: "delete_variant", name: "Thin" },
      { type: "delete_variant", name: "Tall/Big" },
    );
    await exportVariants("3mf");
    expect(lastToast()).toBe("This design has no variants");
    await expect(variantFiles("stl")).rejects.toThrow(/no variants/);
  });
});

describe("versions as files", () => {
  it("brings a design file in as a version, and the same file again brings nothing", async () => {
    const other = { ...currentDoc(), params: { h: "12 mm" } };
    const file = new File([JSON.stringify(other)], "Files - Before.meercad", {
      lastModified: 1_700_000_000_000,
    });
    expect(await importVersionFile(file)).toEqual(["Before"]);
    expect(currentDoc().versions!.map((v) => v.name)).toContain("Before");
    // The open design stays as it is.
    expect(currentDoc().params["h"]).toBe("10 mm");
    expect(await importVersionFile(file)).toEqual([]);
    expect(lastToast()).toMatch(/Every version in Files - Before.meercad is here already/);
    expect(await importVersionFile(new File(["{"], "bad.meercad"))).toEqual([]);
    expect(lastToast()).toMatch(/Not a valid meerCAD file/);
  });
});

describe("importing files", () => {
  it("imports 3MF (one part per object) and OBJ meshes at their size", async () => {
    const a = mesh(
      prism(
        [
          [100, 0],
          [110, 0],
          [110, 10],
          [100, 10],
        ],
        10,
      ),
    );
    const b = mesh(
      prism(
        [
          [120, 0],
          [140, 0],
          [140, 10],
          [120, 10],
        ],
        5,
      ),
    );
    const three = write3mf([
      { ...a, name: "a" },
      { ...b, name: "b" },
    ] as never);
    expect(await importFile(new File([three as BlobPart], "pair.3mf"))).toBe(true);

    const names = currentDoc()
      .features.filter((f) => f.op === "import")
      .map((f) => (f as { fileName: string }).fileName);
    expect(names.slice(-2)).toEqual(["pair.3mf › a", "pair.3mf › b"]);

    const out = await rebuildNow();
    expect(out.report.bodies.slice(-2).map((x) => Math.round(x.volume!))).toEqual([1000, 1000]);

    const obj = writeObj([
      {
        ...mesh(
          prism(
            [
              [200, 0],
              [230, 0],
              [230, 30],
              [200, 30],
            ],
            2,
          ),
        ),
        name: "plate",
      },
    ] as never);
    const objText =
      typeof obj === "string"
        ? obj
        : new TextDecoder().decode(
            Object.values(obj as Record<string, Uint8Array>).find((v) =>
              new TextDecoder().decode(v).includes("v "),
            )!,
          );
    expect(await importFile(new File([objText], "plate.obj"))).toBe(true);
    expect((await lastVolume()).volume).toBeCloseTo(1800, 3);
  });

  it("imports a STEP file of the block at its size", async () => {
    const { data } = await stepFile({ parts: ["ex1"] });
    expect(await importFile(new File([data as BlobPart], "block.step"))).toBe(true);
    expect((await lastVolume()).volume).toBeCloseTo(8000, 3);
  });

  it("imports a DXF drawing as a sketch of its size", async () => {
    const dxf = writeDxf([{ kind: "circle", center: [0, 0], radius: 7 }]);
    expect(await importFile(new File([dxf], "round.dxf"))).toBe(true);

    const sk = currentDoc().features.find((f) => f.op === "sketch" && f.name === "round.dxf")!;
    const out = await rebuildNow();
    expect(out.report.sketches.find((s) => s.id === sk.id)!.regions[0]!.area).toBeCloseTo(Math.PI * 49, 6);
  });

  it("says why a file cannot be imported", async () => {
    const before = currentDoc().features.length;
    expect(await importFile(new File(["x"], "notes.txt"))).toBe(false);
    expect(lastToast()).toBe("Unsupported file type .txt");
    expect(await importFile(new File(["<svg/>"], "empty.svg"))).toBe(false);
    expect(lastToast()).toMatch(/Could not import empty.svg: no supported geometry found in the file/);
    expect(await importFile(new File(["not a mesh"], "broken.stl"))).toBe(false);
    expect(currentDoc().features.length).toBe(
      before + (lastToast().startsWith("Import of broken.stl failed") ? 1 : 0),
    );
    expect(await importFile(new File(["{"], "bad.meercad"))).toBe(false);
    expect(lastToast()).toMatch(/Not a valid meerCAD file/);
    void writeStl;
  });
});
