import { describe, expect, it } from "vitest";
import { billOfMaterials, bomCsv } from "./materials.js";

describe("parts list", () => {
  it("counts equal parts together and weighs them", () => {
    const names: Record<string, string> = { ex1: "Plate", np1: "M4×16 ISO 4762", np1_2: "M4×16 ISO 4762 (2)", np2: "608 8×22×7", ex2: "Plate" };
    const rows = billOfMaterials(
      [
        { id: "ex1", volume: 12000 },
        { id: "np1", volume: 339 },
        { id: "np1_2", volume: 339 },
        { id: "np2", volume: 2308 },
        // Same name, other size: its own line.
        { id: "ex2", volume: 8000 },
      ],
      (id) => names[id]!,
      { ex1: "petg", np1: "steel", np1_2: "steel" },
    );
    expect(rows.map((r) => [r.pos, r.qty, r.name, r.material ?? ""])).toEqual([
      [1, 1, "Plate", "PETG"],
      [2, 2, "M4×16 ISO 4762", "Steel"],
      [3, 1, "608 8×22×7", ""],
      [4, 1, "Plate", ""],
    ]);
    expect(rows[1]!.mass).toBeCloseTo(0.339 * 7.85, 6);
    const csv = bomCsv(rows);
    expect(csv.split("\n")[0]).toBe("Pos;Qty;Name;Material;Mass each (g);Volume each (cm³)");
    expect(csv).toContain("2;2;M4×16 ISO 4762;Steel;2.66;0.339");
  });
});

import { emptyDocument } from "@meercad/schema";
import { applyOp } from "./store.js";
import { documentMaterials, materialById, MATERIALS, newMaterialId, partMaterial } from "./materials.js";

describe("material library", () => {
  it("has the print materials with their data and a finish for each", () => {
    for (const id of ["pla", "plamatte", "plasilk", "petg", "abs", "asa", "tpu", "tpu85a", "pa12", "pc", "placf", "petgcf", "woodfill", "metalfill", "resin"]) expect(materialById(id), id).toBeDefined();
    expect(new Set(MATERIALS.map((m) => m.id)).size).toBe(MATERIALS.length);
    for (const m of MATERIALS) {
      expect(m.id).toMatch(/^[a-z0-9]{1,32}$/);
      expect(m.look.roughness).toBeGreaterThanOrEqual(0);
      expect(m.look.roughness).toBeLessThanOrEqual(1);
      if (m.look.color) expect(m.look.color).toMatch(/^#[0-9a-f]{6}$/);
      if (m.kind === "print" && m.filament) expect(m.nozzle![0]).toBeLessThan(m.nozzle![1]);
    }
    expect(materialById("tpu")!.shore).toBe("95A");
    expect(materialById("tpu85a")!.shore).toBe("85A");
  });

  it("keeps the ids older documents use", () => {
    for (const id of ["pla", "petg", "abs", "asa", "tpu", "pa12", "pc", "resin", "aluminium", "steel", "stainless", "brass", "copper", "wood", "plywood", "acrylic"]) expect(materialById(id), id).toBeDefined();
  });
});

describe("own materials", () => {
  const box = { ...emptyDocument(), partMaterials: { ex1: "petg" } };

  it("are a library material under an own name, colour and density", () => {
    let doc = applyOp(box, { type: "define_material", material: { id: "own1", name: "Galaxy black", base: "petg", color: "#1a1a1f" } });
    doc = applyOp(doc, { type: "set_material", part: "ex2", material: "own1" });
    const m = partMaterial(doc, "ex2")!;
    expect(m).toMatchObject({ id: "own1", name: "Galaxy black", density: 1.27, filament: "PETG", base: "petg" });
    expect(m.look).toMatchObject({ color: "#1a1a1f", roughness: materialById("petg")!.look.roughness });
    expect(documentMaterials(doc)[0]!.id).toBe("own1");
    expect(newMaterialId(doc)).toBe("own2");
    // Changing it keeps its id; deleting it leaves its parts on the base material.
    doc = applyOp(doc, { type: "define_material", material: { id: "own1", name: "Galaxy black", base: "petg", color: "#000000", density: 1.3 } });
    expect(partMaterial(doc, "ex2")!.density).toBe(1.3);
    doc = applyOp(doc, { type: "delete_material", id: "own1" });
    expect(doc.materials).toBeUndefined();
    expect(doc.partMaterials).toEqual({ ex1: "petg", ex2: "petg" });
  });

  it("refuses library ids, unknown bases and unknown materials", () => {
    expect(() => applyOp(box, { type: "define_material", material: { id: "pla", name: "Mine", base: "pla" } })).toThrow(/library material/);
    expect(() => applyOp(box, { type: "define_material", material: { id: "own1", name: "Mine", base: "unobtainium" } })).toThrow(/unknown base/);
    expect(() => applyOp(box, { type: "set_material", part: "ex1", material: "own9" })).toThrow(/unknown material/);
    expect(() => applyOp(box, { type: "delete_material", id: "own9" })).toThrow(/no own material/);
  });
});
