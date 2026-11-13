/**
 * Mesh sections in a sketch (section.ts): where the sketch plane cuts an imported mesh, the chain
 * is found under the pointer and traced into sketch lines and circles of the mesh's sizes; the
 * traced sketch's region has the cut's area.
 */
import { describe, expect, it } from "vitest";
import { SketchSolver } from "@meercad/sketch";
import { ORIGIN_FRAMES } from "@meercad/sketch";
import type { Feature } from "@meercad/schema";
import { prism, turned } from "../../../../tests/acceptance/meshes";
import { chainAt, meshSections, traceSections } from "./section";

const frame = { ...ORIGIN_FRAMES["origin.XY"], origin: [0, 0, 2] as [number, number, number] };
const meshOf = (bodyId: string, corners: Float64Array) => ({
  bodyId,
  positions: Float32Array.from(corners),
  indices: Uint32Array.from({ length: corners.length / 3 }, (_, i) => i),
  faceTags: [[`${bodyId}.mesh`]],
});
const imports = (ids: string[]): Feature[] =>
  ids.map((id) => ({ id, op: "import", format: "stl", fileName: `${id}.stl`, data: "" }) as Feature);

describe("mesh sections", () => {
  it("cuts a block and a cylinder at the sketch plane and traces them with their sizes", async () => {
    const block = meshOf(
      "im1",
      prism(
        [
          [0, 0],
          [40, 0],
          [40, 20],
          [0, 20],
        ],
        5,
      ),
    );
    const cyl = meshOf(
      "im2",
      turned(
        [
          [0, 0],
          [8, 0],
          [8, 6],
          [0, 6],
        ],
        96,
      ).map((v, i) => (i % 3 === 0 ? v + 70 : i % 3 === 1 ? v + 10 : v)) as Float64Array,
    );
    const chains = meshSections(imports(["im1", "im2"]), [block, cyl], frame);
    expect(chains.length).toBe(2);
    // The same cut again comes from the cache.
    expect(meshSections(imports(["im1", "im2"]), [block, cyl], frame)).toEqual(chains);
    // Parts that are not meshes are not cut.
    expect(meshSections([], [block], frame)).toEqual([]);
    expect(chainAt(chains, [20, 0.1], 1)).toBeGreaterThanOrEqual(0);
    expect(chainAt(chains, [200, 200], 1)).toBe(-1);

    const { draft, curves } = traceSections({ entities: [], constraints: [] }, chains, 0.05, false);
    expect(curves).toBe(5);

    const circle = draft.entities.find((e) => e.type === "circle") as { radius: number };
    expect(circle.radius).toBeCloseTo(8, 1);

    const solver = await SketchSolver.create();
    // Traced constraints carry no expressions: they go to the solver as they are.
    const solved = solver.solve({ entities: draft.entities, constraints: draft.constraints as never });
    expect(solved.diagnostics.ok).toBe(true);

    const lines = solved.curves.filter((c) => c.kind === "line") as {
      a: [number, number];
      b: [number, number];
    }[];
    const lengths = lines
      .map((l) => Math.round(Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1])))
      .sort((a, b) => a - b);
    expect(lengths).toEqual([20, 20, 40, 40]);

    const asGuides = traceSections({ entities: [], constraints: [] }, chains, 0.05, true);
    expect(
      asGuides.draft.entities
        .filter((e) => e.type !== "point")
        .every((e) => (e as { construction?: boolean }).construction),
    ).toBe(true);
  });
});
