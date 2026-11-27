import { describe, expect, it } from "vitest";
import { exportMeshes } from "@meercad/kernel";
import { writeStl } from "@meercad/io";
import type { Feature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

/** A part away from the origin (like a slicer plate export): 55 × 40 × 12 mm block with a Ø10 hole. */
const part: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 100, 110, 55, 40), ...circle("c1", 127, 130, 5)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 12, mode: "new_body" },
];

async function stlOf(features: Feature[], drop = 0): Promise<{ data: string; volume: number }> {
  const s = await newSession();
  const r = s.rebuild(doc(features)).report;
  const meshes = exportMeshes(await getOcct(), s.state!);
  if (drop) meshes[0]!.indices = meshes[0]!.indices.slice(0, meshes[0]!.indices.length - drop * 3);

  return { data: Buffer.from(writeStl(meshes)).toString("base64"), volume: r.bodies[0]!.volume };
}

describe("STL import", () => {
  it("turns a closed mesh into a solid body, wherever it sits", async () => {
    const { data, volume } = await stlOf(part);
    const s = await newSession();
    const r = s.rebuild(
      doc([{ id: "im1", op: "import", format: "stl", fileName: "plate.stl", data }]),
    ).report;
    expect(r.features.find((f) => f.id === "im1")?.status).toBe("ok");
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(volume, -1);
    expect(r.bodies[0]!.bbox.min[0]).toBeCloseTo(100, 1);

    // The mesh is shown with the file's own triangles, without meshing it again.
    const m = s.rebuild(doc([{ id: "im1", op: "import", format: "stl", fileName: "plate.stl", data }]))
      .meshes[0]!;
    expect(m.indices.length / 3).toBe(r.bodies[0]!.faces);
    expect(m.edgeRanges.length).toBe(0);
  });

  it("keeps its triangles when moved", async () => {
    const { data } = await stlOf(part);
    const s = await newSession();
    const r = s.rebuild(
      doc([
        { id: "im1", op: "import", format: "stl", fileName: "plate.stl", data },
        { id: "mv1", op: "transform", bodies: ["im1"], translate: [0, 0, 50] },
      ]),
    );
    expect(r.report.features.filter((f) => f.status !== "ok")).toEqual([]);

    const zs = Array.from(r.meshes[0]!.positions).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(50, 3);
    expect(r.meshes[0]!.indices.length / 3).toBe(r.report.bodies[0]!.faces);
  });

  it("can be cut like any other body", async () => {
    const { data, volume } = await stlOf(part);
    const s = await newSession();
    const r = s.rebuild(
      doc([
        { id: "im1", op: "import", format: "stl", fileName: "plate.stl", data },
        sketch("sk2", { ref: "origin.XY" }, rect("q", 140, 115, 10, 10)),
        {
          id: "ex2",
          op: "extrude",
          profile: { sketch: "sk2" },
          extent: "through_all",
          distance: 1,
          mode: "cut",
        },
      ]),
    ).report;
    expect(r.features.filter((f) => f.status !== "ok")).toEqual([]);
    expect(volume - r.bodies[0]!.volume).toBeCloseTo(10 * 10 * 12, -1);
  });

  it("reports an open mesh instead of silently making nothing", async () => {
    const { data } = await stlOf(part, 6);
    const s = await newSession();
    const r = s.rebuild(doc([{ id: "im1", op: "import", format: "stl", fileName: "open.stl", data }])).report;
    const f = r.features.find((x) => x.id === "im1")!;
    expect(f.status).toBe("error");
    expect(f.message).toMatch(/not a closed solid/);
  });

  /** A cube of `size` with each side cut into n × n squares, corner by corner (wound outwards). */
  function cube(size: number, n: number): number[] {
    const out: number[] = [];
    const step = size / n;
    // Each side: where it starts and its two directions, so that u × v points out.
    const sides: [number[], number[], number[]][] = [
      [
        [0, 0, 0],
        [0, 1, 0],
        [1, 0, 0],
      ],
      [
        [0, 0, size],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
      [
        [0, size, 0],
        [0, 0, 1],
        [1, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      [
        [size, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    ];

    for (const [o, u, v] of sides) {
      const at = (i: number, j: number) => o.map((c, k) => c + (u[k]! * i + v[k]! * j) * step);

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          out.push(...at(i, j), ...at(i + 1, j), ...at(i + 1, j + 1));
          out.push(...at(i, j), ...at(i + 1, j + 1), ...at(i, j + 1));
        }
      }
    }

    return out;
  }

  const asStl = (corners: number[]) =>
    Buffer.from(
      writeStl([
        {
          positions: Float32Array.from(corners),
          indices: Uint32Array.from({ length: corners.length / 3 }, (_, i) => i),
        },
      ]),
    ).toString("base64");

  it("takes a closed mesh with a triangle of no area (a point on an edge) as a solid", async () => {
    // The bottom's edge from the origin to (10, 0, 0) has a point in its middle on the front's side
    // only; a triangle without area closes the gap, as mesh tools leave it after reducing a mesh.
    const [o, x, y, z, m] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
      [5, 0, 0],
    ] as [number[], number[], number[], number[], number[]];
    const corners = [
      [o, y, x],
      [o, m, z],
      [m, x, z],
      [x, m, o],
      [o, z, y],
      [x, y, z],
    ].flat(2) as number[];
    const s = await newSession();
    const r = s.rebuild(
      doc([{ id: "im1", op: "import", format: "stl", fileName: "t.stl", data: asStl(corners) }]),
    );

    expect(r.report.features[0]).toMatchObject({ status: "ok" });
    expect(r.report.bodies[0]!.volume).toBeCloseTo(1000 / 6, 3);
    // Shown with its own triangles: six, none of them without area.
    expect(r.report.bodies[0]!.faces).toBe(6);
    expect(r.meshes[0]!.indices.length / 3).toBe(6);
  });

  it("reports a large open mesh at once instead of sewing it for minutes", async () => {
    // 6 × 2 × 80² = 76,800 triangles, one missing.
    const corners = cube(40, 80).slice(9);
    const started = Date.now();
    const r = (await newSession()).rebuild(
      doc([{ id: "im1", op: "import", format: "stl", fileName: "big.stl", data: asStl(corners) }]),
    ).report;

    expect(r.features[0]).toMatchObject({ status: "error" });
    expect(r.features[0]!.message).toMatch(/not a closed solid \(76799 triangles\)/);
    expect(r.features[0]!.hint).toMatch(/repair_mesh/);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);
});
