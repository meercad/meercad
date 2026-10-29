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
