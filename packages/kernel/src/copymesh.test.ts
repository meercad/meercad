import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Body } from "./body.js";
import type { BodyMesh } from "./mesh.js";
import type { OC } from "./occt.js";

const meshed: string[] = [];
vi.mock("./mesh.js", () => ({
  displayTolerance: (diag: number, coarse: number) => ({
    linear: Math.max(0.01, diag * 5e-4) * coarse,
    angular: Math.min(0.3, 0.06 * coarse),
  }),
  // One triangle in the part's own place, its normal along z.
  meshBody: (_oc: unknown, body: { bodyId: string; at: number[]; faceTags: string[][] }): BodyMesh => {
    meshed.push(body.bodyId);

    const [x, y, z] = body.at as [number, number, number];

    return {
      bodyId: body.bodyId,
      positions: Float32Array.from([x, y, z, x + 1, y, z, x, y + 1, z]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2]),
      faceRanges: Int32Array.from([0, 3, 0]),
      edgeLines: Float32Array.from([x, y, z, x + 1, y, z]),
      edgeRanges: Int32Array.from([0, 2, 0]),
      faceTags: body.faceTags.map((t) => [...t]),
      edgeFaces: [[0]],
    };
  },
}));

const { CopyMeshes, composeMoves, invertMove, moveMesh } = await import("./copymesh.js");

const shift = (x: number, y: number, z: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
/** A quarter turn about z. */
const turn = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
/** Mirrored at the plane x = 0. */
const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const apply = (m: number[], p: number[]) =>
  [0, 1, 2].map((r) => m[r * 4]! * p[0]! + m[r * 4 + 1]! * p[1]! + m[r * 4 + 2]! * p[2]! + m[r * 4 + 3]!);

interface Fake {
  bodyId: string;
  at: number[];
  faces: unknown[];
  faceTags: string[][];
  displayCoarse: number;
  sourceMesh: Float32Array | null;
  copyOf: { root: Fake; matrix: number[] } | null;
}

const fake = (bodyId: string, over: Partial<Fake> = {}): Fake => ({
  bodyId,
  at: [0, 0, 0],
  faces: [0],
  faceTags: [[`${bodyId}.f`]],
  displayCoarse: 1,
  sourceMesh: null,
  copyOf: null,
  ...over,
});
const box = (size: number) => ({
  min: [0, 0, 0] as [number, number, number],
  max: [size, 0, 0] as [number, number, number],
});
const mesh = (c: InstanceType<typeof CopyMeshes>, b: Fake, size = 100, coarse = 1) =>
  c.mesh(b as unknown as Body, box(size), coarse);

beforeEach(() => void (meshed.length = 0));

describe("moves", () => {
  it("follow one another in order, and lead back", () => {
    const both = composeMoves(shift(10, 0, 0), turn);
    expect(apply(both, [1, 0, 0])).toEqual([10, 1, 0]);
    expect(apply(composeMoves(turn, shift(10, 0, 0)), [1, 0, 0])).toEqual([0, 11, 0]);

    for (const m of [both, mirror, composeMoves(mirror, both)]) {
      const back = composeMoves(invertMove(m), m);
      back.forEach((v, i) => expect(v).toBeCloseTo(i % 5 === 0 ? 1 : 0, 12));
    }
  });

  it("move a mesh: points and edges with the shift, normals without, names from the part itself", () => {
    const src = mesh(new CopyMeshes({} as OC), fake("a"));
    const out = moveMesh(
      src,
      fake("b", { faceTags: [["b.f"]] }) as unknown as Body,
      composeMoves(shift(5, 0, 2), turn),
    );
    expect([...out.positions]).toEqual([5, 0, 2, 5, 1, 2, 4, 0, 2]);
    expect([...out.normals]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect([...out.edgeLines]).toEqual([5, 0, 2, 5, 1, 2]);
    expect([...out.indices]).toEqual([0, 1, 2]);
    expect(out.bodyId).toBe("b");
    expect(out.faceTags).toEqual([["b.f"]]);
    // Arrays of its own.
    for (const k of ["indices", "faceRanges", "edgeRanges"] as const) expect(out[k]).not.toBe(src[k]);
    expect(out.edgeFaces).toEqual(src.edgeFaces);
    expect(out.edgeFaces).not.toBe(src.edgeFaces);
  });

  it("a mirrored mesh has its triangles the other way round, so they still face outwards", () => {
    const src = mesh(new CopyMeshes({} as OC), fake("a"));
    const out = moveMesh(src, fake("b") as unknown as Body, mirror);
    expect([...out.positions].map((v) => v + 0)).toEqual([0, 0, 0, -1, 0, 0, 0, 1, 0]);
    expect([...out.indices]).toEqual([0, 2, 1]);
    expect([...src.indices]).toEqual([0, 1, 2]);
  });
});

describe("meshes shared between copies", () => {
  it("a copy takes the mesh of its first part, moved its way", () => {
    const c = new CopyMeshes({} as OC);
    const a = fake("a");
    mesh(c, a);

    const b = fake("b", { copyOf: { root: a, matrix: shift(7, 0, 0) } });
    const out = mesh(c, b);
    expect(meshed).toEqual(["a"]);
    expect([...out.positions]).toEqual([7, 0, 0, 8, 0, 0, 7, 1, 0]);
    expect(out.bodyId).toBe("b");
  });

  it("copies of a part that is not shown itself share the mesh of the first of them", () => {
    const c = new CopyMeshes({} as OC);
    const gone = fake("gone");
    // The first one meshed stands turned and shifted; the second is the first part only shifted.
    const first = fake("first", {
      at: [0, 0, 0],
      copyOf: { root: gone, matrix: composeMoves(shift(3, 0, 0), turn) },
    });
    const second = fake("second", { copyOf: { root: gone, matrix: shift(0, 5, 9) } });
    const m1 = mesh(c, first);
    const m2 = mesh(c, second);
    expect(meshed).toEqual(["first"]);

    // Back along the first one's way, then the second one's: (x, y, z) → (y, 8 − x, z + 9).
    const want = [0, 1, 2].flatMap((i) => {
      const [x, y, z] = [m1.positions[i * 3]!, m1.positions[i * 3 + 1]!, m1.positions[i * 3 + 2]!];

      return [y, 8 - x, z + 9];
    });
    [...m2.positions].forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
  });

  it("a copy whose own mesh would be finer is meshed itself, and then serves the others", () => {
    const c = new CopyMeshes({} as OC);
    const a = fake("a");
    const b = fake("b", { copyOf: { root: a, matrix: shift(1, 0, 0) } });
    const d = fake("d", { copyOf: { root: a, matrix: shift(2, 0, 0) } });
    mesh(c, a, 400);
    // Its box is smaller (it stands turned): finer alone than the mesh there is.
    mesh(c, b, 200);
    expect(meshed).toEqual(["a", "b"]);

    // As coarse as the first: takes the finer one, from b's place.
    const out = mesh(c, d, 400);
    expect(meshed).toEqual(["a", "b"]);
    expect([...out.positions]).toEqual([1, 0, 0, 2, 0, 0, 1, 1, 0]);
    // A coarser mesh never replaces a finer one.
    mesh(c, fake("e", { copyOf: { root: a, matrix: shift(3, 0, 0) } }), 100);
    mesh(c, fake("f", { copyOf: { root: a, matrix: shift(4, 0, 0) } }), 150);
    expect(meshed).toEqual(["a", "b", "e"]);
    expect(c.tolerance(a as unknown as Body, box(400), 2)).toEqual({ linear: 0.4, angular: 0.12 });
  });

  it("a part with a looser display of its own, with other faces or made from a file's triangles is meshed itself", () => {
    const c = new CopyMeshes({} as OC);
    const a = fake("a", { displayCoarse: 4 });
    mesh(c, a);
    // The copy shows at the usual fineness: the looser mesh will not do.
    mesh(c, fake("b", { copyOf: { root: a, matrix: shift(1, 0, 0) } }));
    mesh(
      c,
      fake("faces", { faces: [0, 1], faceTags: [["x"], ["y"]], copyOf: { root: a, matrix: shift(1, 0, 0) } }),
    );

    const file = fake("file", {
      sourceMesh: new Float32Array(9),
      copyOf: { root: a, matrix: shift(1, 0, 0) },
    });
    mesh(c, file);
    mesh(c, fake("after", { copyOf: { root: file, matrix: shift(1, 0, 0) } }));
    expect(meshed).toEqual(["a", "b", "faces", "file", "after"]);
  });
});
