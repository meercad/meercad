/** Fine meshes made lighter to fit the import budget. */
import { describe, expect, it } from "vitest";
import { IMPORT_TRIANGLES, withinBudget } from "./importBudget";

/** A flat grid of n × n squares (2n² triangles). */
function grid(n: number, name: string) {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.push(x, y, 0);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;

      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  }

  return { name, positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

describe("withinBudget", () => {
  it("leaves meshes within the budget alone", () => {
    const meshes = [grid(4, "a"), grid(4, "b")];
    const result = withinBudget(meshes);

    expect(result.lightened).toEqual([]);
    expect(result.meshes[0]).toBe(meshes[0]);
    expect(IMPORT_TRIANGLES).toBe(100_000);
  });

  it("makes only the meshes above their share lighter, never below the floor", () => {
    const meshes = [grid(60, "fine"), grid(20, "coarse")];
    const result = withinBudget(meshes, 4000);

    expect(result.meshes[1]).toBe(meshes[1]);
    expect(result.lightened).toHaveLength(1);
    expect(result.lightened[0]).toMatchObject({ index: 0, from: 7200 });
    expect(result.lightened[0]!.to).toBeLessThan(7200);
    expect(result.meshes[0]!.name).toBe("fine");
    expect(result.meshes[0]!.indices.length / 3).toBe(result.lightened[0]!.to);
  });
});
