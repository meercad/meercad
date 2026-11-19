/** Handle positions and directions on synthetic meshes: a flat cap on a cylinder of radius 5. */
import { describe, expect, it } from "vitest";
import type { BodyMesh, RebuildOutput } from "@meercad/kernel";
import {
  cylinderAnchor,
  edgeAnchor,
  edgeSelectorAnchor,
  faceAnchor,
  faceSelectorAnchor,
  isCylinderFace,
  profileAnchor,
  profileTriangles,
} from "./anchors";

type Vec3 = [number, number, number];

const SEGMENTS = 12;
const ring = (z: number) =>
  Array.from({ length: SEGMENTS }, (_, i): Vec3 => {
    const a = (2 * Math.PI * i) / SEGMENTS;

    return [5 * Math.cos(a), 5 * Math.sin(a), z];
  });

/**
 * Face 0 "ex1.end_cap": the top at z = 10 (a fan round its centre); face 1 "ex1.side": the
 * cylinder wall; face 2 "ex1.cone": a cone from the bottom ring to a tip; face 3: one triangle.
 * Faces 3 to 5: a single triangle, one of no area, a triangle of the bottom facing down. Edge 0: the
 * top rim (faces 0 and 1); edge 1: bordering face 1 only; edge 2: faces 1 and 9 (none); edge 3:
 * between top and bottom, which face opposite ways.
 */
function cylinder(bodyId = "ex1"): BodyMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: number[] = [];

  const vertex = (p: Vec3, n: Vec3) => {
    positions.push(...p);
    normals.push(...n);

    return positions.length / 3 - 1;
  };

  const face = (id: number, triangles: number[]) => {
    faceRanges.push(indices.length, triangles.length, id);
    indices.push(...triangles);
  };

  // Top cap.
  const centre = vertex([0, 0, 10], [0, 0, 1]);
  const top = ring(10).map((p) => vertex(p, [0, 0, 1]));
  face(
    0,
    top.flatMap((v, i) => [centre, v, top[(i + 1) % SEGMENTS]!]),
  );

  // Wall: normals point out from the axis.
  const radial = (p: Vec3): Vec3 => [p[0] / 5, p[1] / 5, 0];
  const lower = ring(0).map((p) => vertex(p, radial(p)));
  const upper = ring(10).map((p) => vertex(p, radial(p)));
  face(
    1,
    lower.flatMap((v, i) => {
      const next = (i + 1) % SEGMENTS;

      return [v, lower[next]!, upper[next]!, v, upper[next]!, upper[i]!];
    }),
  );

  // Cone: normals lean up.
  const tip = vertex([0, 0, -5], [0, 0, -1]);
  const coneRing = ring(0).map((p) => vertex(p, [(p[0] / 5) * 0.7, (p[1] / 5) * 0.7, -0.7]));
  face(
    2,
    coneRing.flatMap((v, i) => [tip, coneRing[(i + 1) % SEGMENTS]!, v]),
  );

  // A face of a single triangle, one of no area, and the bottom (facing down).
  face(3, [centre, top[0]!, top[1]!]);
  face(4, [centre, centre, top[0]!]);

  const bottom = ring(0).map((p) => vertex(p, [0, 0, -1]));

  face(5, [bottom[0]!, bottom[2]!, bottom[1]!]);

  const rim = ring(10);

  return {
    bodyId,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceRanges: new Int32Array(faceRanges),
    faceTags: [["ex1.end_cap"], ["ex1.side"], ["ex1.cone"], ["ex1.bit"], ["ex1.flat"], ["ex1.bottom"]],
    edgeLines: new Float32Array([...rim.flat(), ...rim[0]!, 5, 0, 0, 5, 0, 5]),
    edgeRanges: new Int32Array([0, SEGMENTS + 1, 0, SEGMENTS + 1, 2, 1, SEGMENTS + 3, 0, 2, 0, 2, 3]),
    edgeFaces: [[0, 1], [1], [1, 9], [0, 5]],
  } as unknown as BodyMesh;
}

const mesh = cylinder();

/** A sketch on the XY plane, lifted to z = 2, with a big and a small region and a hole. */
const frame = { origin: [0, 0, 2], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
const square = (x: number, y: number, size: number): [number, number][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];
const out = {
  meshes: [mesh],
  report: {
    sketches: [
      {
        id: "sk1",
        frame,
        regions: [
          { key: "small", depth: 1, area: 4, sample: [1, 1], polygons: [square(0, 0, 2)] },
          {
            key: "big",
            depth: 1,
            area: 64,
            sample: [14, 14],
            polygons: [square(10, 10, 8), square(12, 12, 2)],
          },
          { key: "hole", depth: 2, area: 4, sample: [13, 13], polygons: [square(12, 12, 2)] },
          { key: "empty", depth: 1, area: 0, sample: [0, 0], polygons: [] },
        ],
      },
    ],
  },
} as unknown as RebuildOutput;

const close = (actual: readonly number[] | undefined, expected: readonly number[], digits = 6) =>
  expected.forEach((value, i) => expect(actual![i]).toBeCloseTo(value, digits));

describe("faceAnchor", () => {
  it("puts a flat face's anchor on its centroid with its normal", () => {
    const anchor = faceAnchor(mesh, 0)!;

    close(anchor.origin, [0, 0, 10]);
    close(anchor.normal, [0, 0, 1]);
  });

  it("takes the vertex nearest the centroid of a curved face", () => {
    const anchor = faceAnchor(mesh, 1)!;

    expect(Math.hypot(anchor.origin[0], anchor.origin[1])).toBeCloseTo(5);
    expect(Math.hypot(anchor.normal[0], anchor.normal[1])).toBeCloseTo(1);
  });

  it("gives null for a face with no triangles", () => {
    expect(faceAnchor(mesh, 7)).toBeNull();
  });
});

describe("edges", () => {
  it("anchors an edge between its faces, pointing out between them", () => {
    const anchor = edgeAnchor(mesh, 0)!;

    expect(anchor.origin[2]).toBeCloseTo(10);
    expect(anchor.dir[2]).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it("has no direction between two faces facing opposite ways", () => {
    expect(edgeAnchor(mesh, 3)!.dir).toEqual([0, 0, 0]);
  });

  it("needs two faces with triangles and a point", () => {
    expect(edgeAnchor(mesh, 1)).toBeNull();
    expect(edgeAnchor(mesh, 2)).toBeNull();
    expect(edgeAnchor(mesh, 5)).toBeNull();
    expect(edgeAnchor({ ...cylinder(), edgeFaces: [[9, 0]] } as BodyMesh, 0)).toBeNull();
  });

  it("finds an edge by its selector", () => {
    expect(edgeSelectorAnchor(out, { edge: ["ex1.end_cap", "ex1.side"] })!.origin[2]).toBeCloseTo(10);
    expect(edgeSelectorAnchor(out, { edge: ["ex1.end_cap", "nope"] })).toBeNull();
  });
});

describe("faces and profiles", () => {
  it("finds a face by its selector", () => {
    close(faceSelectorAnchor(out, { face: "ex1.end_cap" })!.origin, [0, 0, 10]);
    expect(faceSelectorAnchor(out, { face: "nope" })).toBeNull();
    // A selector by properties that matches no face.
    expect(faceSelectorAnchor(out, { select: "faces", where: { normal: "+Z" } })).toBeNull();
  });

  it("puts an extrude handle on the largest region, or on a face", () => {
    expect(profileAnchor(out, { sketch: "sk1" })).toEqual({ origin: [14, 14, 2], normal: [0, 0, 1] });
    expect(profileAnchor(out, { sketch: "sk1", regions: ["small"] })!.origin).toEqual([1, 1, 2]);
    expect(profileAnchor(out, { sketch: "sk1", regions: ["small", "big"] })!.origin).toEqual([14, 14, 2]);
    expect(profileAnchor(out, { sketch: "sk1", regions: ["missing"] })).toBeNull();
    expect(profileAnchor(out, { sketch: "sk9" })).toBeNull();
    close(profileAnchor(out, { face: { face: "ex1.end_cap" } })!.origin, [0, 0, 10]);
  });

  it("triangulates the regions, holes left out", () => {
    const base = profileTriangles(out, { sketch: "sk1" })!;
    let area = 0;

    for (let i = 0; i < base.triangles.length; i += 9) {
      const t = base.triangles;

      area +=
        Math.abs(
          (t[i + 3]! - t[i]!) * (t[i + 7]! - t[i + 1]!) - (t[i + 6]! - t[i]!) * (t[i + 4]! - t[i + 1]!),
        ) / 2;
    }

    expect(area).toBeCloseTo(4 + 60);
    expect(base.normal).toEqual([0, 0, 1]);
    expect(base.triangles[2]).toBe(2);
    expect(profileTriangles(out, { sketch: "sk1", regions: ["empty"] })).toBeNull();
    expect(profileTriangles(out, { sketch: "sk9" })).toBeNull();
  });

  it("takes a face's own triangles and normals for a face profile", () => {
    const base = profileTriangles(out, { face: { face: "ex1.side" } })!;

    expect(base.triangles.length).toBe(SEGMENTS * 6 * 3);
    expect(base.normals!.length).toBe(base.triangles.length);
    expect(profileTriangles(out, { face: { face: "nope" } })).toBeNull();
    expect(profileTriangles(out, { face: { face: "ex1.flat" } })).toBeNull();
    expect(profileTriangles(out, { face: { select: "faces", where: { normal: "-Y" } } })).toBeNull();
  });
});

describe("cylinders", () => {
  it("measures a cylinder's axis, rim and radius, the axis turned the preferred way", () => {
    const up = cylinderAnchor(mesh, 1, [0, 0, 1], [1, 0, 0])!;

    close(up.top, [0, 0, 10], 4);
    close(up.dir, [1, 0, 0]);
    expect(up.radius).toBeCloseTo(5);

    const down = cylinderAnchor(mesh, 1, [0, 0, -1], [1, 0, 0])!;

    close(down.top, [0, 0, 0], 4);
  });

  it("picks some direction across the axis when the one asked for runs along it", () => {
    close(cylinderAnchor(mesh, 1, [0, 0, 1], [0, 0, 1])!.dir, [1, 0, 0]);

    // A cylinder along X: the fallback is Y.
    const turned = cylinder();

    const swap = (a: Float32Array) => {
      for (let i = 0; i < a.length; i += 3) [a[i], a[i + 2]] = [a[i + 2]!, a[i]!];
    };

    swap(turned.positions);
    swap(turned.normals);
    close(cylinderAnchor(turned, 1, [1, 0, 0], [1, 0, 0])!.dir, [0, 1, 0]);
  });

  it("tells cylinders from flat faces, cones and slivers", () => {
    expect(isCylinderFace(mesh, 1)).toBe(true);
    expect(isCylinderFace(mesh, 0)).toBe(false);
    expect(isCylinderFace(mesh, 2)).toBe(false);
    expect(isCylinderFace(mesh, 3)).toBe(false);
    expect(cylinderAnchor(mesh, 0, [0, 0, 1], [1, 0, 0])).toBeNull();
    expect(cylinderAnchor(mesh, 3, [0, 0, 1], [1, 0, 0])).toBeNull();
  });
});
