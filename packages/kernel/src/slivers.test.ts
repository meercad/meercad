import { describe, expect, it } from "vitest";
import { meshPieces } from "./backend.js";
import { withoutSlivers } from "./slivers.js";

type V3 = [number, number, number];

/** A tetrahedron with corners o, x, y, z (wound outwards), as corners. */
const tetra = (size = 10): V3[][] => {
  const [o, x, y, z] = [
    [0, 0, 0],
    [size, 0, 0],
    [0, size, 0],
    [0, 0, size],
  ] as [V3, V3, V3, V3];

  return [
    [o, y, x],
    [o, x, z],
    [o, z, y],
    [x, y, z],
  ];
};

const flatten = (tris: V3[][]) => tris.flat(2);
const check = (corners: ArrayLike<number>) =>
  meshPieces(
    corners,
    Array.from({ length: corners.length / 3 }, (_, i) => i),
  );

describe("withoutSlivers", () => {
  it("leaves a mesh without such triangles alone", () => {
    expect(withoutSlivers(flatten(tetra()))).toBeNull();
    expect(withoutSlivers([])).toBeNull();
  });

  it("takes out a triangle whose corner lies on its long edge and splits the neighbour there", () => {
    // The bottom's edge o → x gets a point m in its middle on the side face's side only: the side
    // face is split at m, and a triangle without area (o, m, x) closes the gap to the bottom.
    const [o, x, y, z, m] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
      [5, 0, 0],
    ] as [V3, V3, V3, V3, V3];
    const mesh = [
      [o, y, x],
      [o, m, z],
      [m, x, z],
      [x, m, o],
      [o, z, y],
      [x, y, z],
    ];
    const before = check(flatten(mesh));
    expect(before).toHaveLength(1);
    expect(before[0]!.closed).toBe(true);

    const out = withoutSlivers(flatten(mesh))!;
    expect(out.length / 9).toBe(6);

    const [piece] = check(out);
    expect(piece!.closed).toBe(true);
    expect(piece!.volume).toBeCloseTo(1000 / 6, 4);
    // No triangle of the result has its three corners on one line.
    expect(withoutSlivers(out)).toBeNull();
  });

  it("works whichever corner the triangle starts with", () => {
    const [o, x, y, z, m] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
      [5, 0, 0],
    ] as [V3, V3, V3, V3, V3];

    for (const sliver of [
      [x, m, o],
      [m, o, x],
      [o, x, m],
    ]) {
      const out = withoutSlivers(flatten([[o, y, x], [o, m, z], [m, x, z], sliver, [o, z, y], [x, y, z]]))!;
      expect(check(out)[0]!.closed).toBe(true);
      expect(check(out)[0]!.volume).toBeCloseTo(1000 / 6, 4);
    }
  });

  it("drops two triangles folded onto each other", () => {
    const [o, x, m] = [
      [0, 0, 0],
      [10, 0, 0],
      [5, 0, 0],
    ] as [V3, V3, V3];
    const out = withoutSlivers(flatten([...tetra(), [o, m, x], [x, m, o]]))!;

    expect(out.length / 9).toBe(4);
    expect(check(out)[0]!.volume).toBeCloseTo(1000 / 6, 4);
  });

  it("gives up on a triangle with all corners in one place", () => {
    const p: V3 = [3, 3, 3];
    // Nothing runs the edges of such a triangle the other way: it cannot be taken out cleanly.
    expect(withoutSlivers(flatten([...tetra(), [p, p, p]]))).toBeNull();
  });

  it("gives up on an open mesh", () => {
    const [o, x, m] = [
      [0, 0, 0],
      [10, 0, 0],
      [5, 0, 0],
    ] as [V3, V3, V3];

    expect(withoutSlivers(flatten([[o, m, x]]))).toBeNull();
  });

  it("gives up when splitting never ends", () => {
    // Every corner on one line: each split makes two more triangles without area.
    const line = (a: number, b: number, c: number): V3[] => [
      [a, 0, 0],
      [b, 0, 0],
      [c, 0, 0],
    ];

    expect(
      withoutSlivers(flatten([line(0, 10, 5), line(10, 0, 7), line(0, 7, 3), line(7, 10, 8)])),
    ).toBeNull();
  });
});
