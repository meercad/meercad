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

/** Points along an arc round `center` from angle a0 to a1 (degrees), every 3°. */
const arcPoints = (center: [number, number], r: number, a0: number, a1: number): [number, number][] => {
  const n = Math.max(2, Math.round(Math.abs(a1 - a0) / 3));

  return Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;

    return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)];
  });
};

/** Points along a line, ends included. */
const linePoints = (a: [number, number], b: [number, number], n = 8): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
const empty = { entities: [], constraints: [] };

describe("tracing chains", () => {
  it("traces a slot as lines and arcs held tangent where they join smoothly", () => {
    const slot = [
      ...linePoints([0, 0], [40, 0]).slice(0, -1),
      ...arcPoints([40, 10], 10, -90, 90).slice(0, -1),
      ...linePoints([40, 20], [0, 20]).slice(0, -1),
      ...arcPoints([0, 10], 10, 90, 270).slice(0, -1),
    ];
    const { draft, curves } = traceSections(empty, [{ points: slot, closed: true }], 0.05, false);
    const kinds = draft.entities.filter((e) => e.type !== "point").map((e) => e.type);

    expect(curves).toBe(4);
    expect(kinds.sort()).toEqual(["arc", "arc", "line", "line"]);
    expect(draft.constraints.filter((c) => c.type === "tangent")).toHaveLength(4);
    expect(draft.constraints.filter((c) => c.type === "horizontal")).toHaveLength(2);
  });

  it("traces open arcs either way round, slanted lines and corners without tangency", () => {
    const ccw = traceSections(empty, [{ points: arcPoints([0, 0], 10, 0, 90), closed: false }], 0.05, false);
    const cw = traceSections(empty, [{ points: arcPoints([0, 0], 10, 90, 0), closed: false }], 0.05, false);
    const arcOf = (draft: { entities: { type: string }[] }) =>
      draft.entities.find((e) => e.type === "arc") as unknown as { start: string; end: string };
    const at = (draft: { entities: { id: string; type: string }[] }, id: string) =>
      draft.entities.find((e) => e.id === id) as unknown as { x: number; y: number };

    expect(at(ccw.draft, arcOf(ccw.draft).start).x).toBeCloseTo(10);
    expect(at(cw.draft, arcOf(cw.draft).start).x).toBeCloseTo(10);

    // A slanted line, then a vertical one, then an arc meeting it at a corner.
    const corner = [
      ...linePoints([0, 0], [10, 10]).slice(0, -1),
      ...linePoints([10, 10], [10, 30]).slice(0, -1),
      ...arcPoints([20, 30], 10, 180, 360),
    ];
    const traced = traceSections(empty, [{ points: corner, closed: false }], 0.05, true);

    expect(traced.curves).toBe(3);
    expect(traced.draft.constraints.map((c) => c.type)).toEqual(["vertical"]);

    // Up a line into a clockwise arc that leaves upwards too: tangent.
    const hook = [...linePoints([0, 0], [0, 10]).slice(0, -1), ...arcPoints([10, 10], 10, 180, 90)];

    expect(
      traceSections(empty, [{ points: hook, closed: false }], 0.05, false).draft.constraints.map(
        (c) => c.type,
      ),
    ).toEqual(["vertical", "tangent"]);
  });

  it("skips chains too short to trace", () => {
    expect(traceSections(empty, [{ points: [[0, 0]], closed: false }], 0.05, false).curves).toBe(0);
  });

  it("finds open chains under the pointer", () => {
    expect(chainAt([{ points: linePoints([0, 0], [10, 0]), closed: false }], [5, 0.5], 1)).toBe(0);
    expect(
      chainAt(
        [
          {
            points: [
              [0, 0],
              [0, 0],
            ],
            closed: false,
          },
        ],
        [0, 0.5],
        1,
      ),
    ).toBe(0);
  });

  it("cuts each mesh at a plane once, forgetting old cuts after a while", () => {
    const block = meshOf(
      "im1",
      prism(
        [
          [0, 0],
          [4, 0],
          [4, 2],
          [0, 2],
        ],
        30,
      ),
    );

    for (let z = 1; z < 26; z++) {
      const cut = { ...frame, origin: [0, 0, z] as [number, number, number] };

      expect(meshSections(imports(["im1"]), [block], cut)).toHaveLength(1);
    }
  });
});
