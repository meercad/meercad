/**
 * Where the app puts its handles and what numbers its dialogs show, on real meshes from the
 * kernel: face and edge anchors, a hole's axis and radius, a profile's centre, gear centre
 * distances and ratios, a bend's defaults and sizes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { RebuildOutput } from "@meercad/kernel";
import type { Feature, GearFeature, SketchEntity } from "@meercad/schema";
import { apply, newProject, rebuildNow } from "../store";
import { cylinderAnchor, edgeSelectorAnchor, faceAnchor, faceSelectorAnchor, isCylinderFace, profileAnchor, profileTriangles } from "./anchors";
import { bendDefaults, describeBend, gapProblem, partsBox, unbentBox } from "./bend";
import { gearParams, pairInfo } from "./gears";
import { meshTopology } from "./topology";

const rect = (w: number, h: number): SketchEntity[] => [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: w, y: 0 },
  { id: "p3", type: "point", x: w, y: h },
  { id: "p4", type: "point", x: 0, y: h },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
/** A 40 × 20 × 10 block with a Ø8 hole through it at (30, 10). */
const block: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: [...rect(40, 20), { id: "hc", type: "point", x: 30, y: 10 }, { id: "h", type: "circle", center: "hc", radius: 4 }], constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];

let out: RebuildOutput;
const close = (a: number[], b: number[], d = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, d));

beforeAll(async () => {
  await newProject(undefined, "Anchors");
  apply({ type: "add_features", features: block });
  out = await rebuildNow();
});

describe("handles on a block with a hole", () => {
  it("puts a face handle in the middle of the face, pointing out", () => {
    const top = faceSelectorAnchor(out, { face: "ex1.end_cap" })!;
    // The top's centroid: the 40 × 20 rectangle less the Ø8 hole at (30, 10).
    const holeArea = Math.PI * 16;
    const x = (800 * 20 - holeArea * 30) / (800 - holeArea);
    close(top.origin, [x, 10, 10], 1);
    close(top.normal, [0, 0, 1]);
    expect(faceSelectorAnchor(out, { face: "ex1.nope" })).toBeNull();
    const m = out.meshes[0]!;
    expect(faceAnchor(m, 999)).toBeNull();
  });

  it("puts an edge handle at the edge's middle, between its two faces", () => {
    const e = edgeSelectorAnchor(out, { edge: ["ex1.end_cap", "ex1.side[sk1.l1]"] })!;
    close(e.origin, [20, 0, 10]);
    close(e.dir, [0, -Math.SQRT1_2, Math.SQRT1_2]);
    expect(edgeSelectorAnchor(out, { edge: ["ex1.end_cap", "ex1.nope"] })).toBeNull();
  });

  it("finds the hole's axis, top and radius on the mesh", () => {
    const m = out.meshes[0]!;
    const topo = meshTopology(m);
    const wall = topo.faceTags.findIndex((t) => t.includes("ex1.side[sk1.h]"));
    expect(isCylinderFace(m, wall)).toBe(true);
    expect(isCylinderFace(m, topo.faceTags.findIndex((t) => t.includes("ex1.end_cap")))).toBe(false);
    const c = cylinderAnchor(m, wall, [0, 0, 1], [1, 0, 0])!;
    close(c.dir, [1, 0, 0]);
    expect(c.radius).toBeCloseTo(4, 2);
    expect(c.top[2]).toBeCloseTo(10, 6);
    expect(Math.hypot(c.top[0] - 30, c.top[1] - 10)).toBeLessThan(0.05);
    // From below the axis turns round.
    expect(cylinderAnchor(m, wall, [0, 0, -1], [0, 0, 1])!.top[2]).toBeCloseTo(0, 6);
    expect(cylinderAnchor(m, 999, [0, 0, 1], [1, 0, 0])).toBeNull();
  });

  it("puts an extrude handle inside the profile, on its plane", () => {
    const a = profileAnchor(out, { sketch: "sk1" })!;
    expect(a.normal).toEqual([0, 0, 1]);
    expect(a.origin[2]).toBe(0);
    expect(profileAnchor(out, { sketch: "zz" })).toBeNull();
    expect(profileAnchor(out, { sketch: "sk1", regions: ["none"] })).toBeNull();
    close(profileAnchor(out, { face: { face: "ex1.end_cap" } })!.normal, [0, 0, 1]);
    // The stand-in base: triangles that cover the region's area.
    const t = profileTriangles(out, { sketch: "sk1" })!;
    let area = 0;
    for (let i = 0; i < t.triangles.length; i += 9) {
      const p = t.triangles;
      const u = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!];
      const v = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!];
      area += Math.abs(u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    }
    expect(area).toBeCloseTo(800 - Math.PI * 16, 0);
    expect(profileTriangles(out, { face: { face: "ex1.end_cap" } })!.triangles.length).toBeGreaterThan(0);
    expect(profileTriangles(out, { face: { face: "ex1.nope" } })).toBeNull();
  });
});

describe("gear sizes in the dialog", () => {
  const g1: GearFeature = { id: "g1", op: "gear", kind: "spur", module: "m", teeth: 20, width: 5, mode: "new_body" };
  const g2: GearFeature = { id: "g2", op: "gear", kind: "spur", teeth: 40, width: 5, meshWith: { gear: "g1" }, mode: "new_body" };
  const ring: GearFeature = { id: "r", op: "gear", kind: "internal", teeth: 60, width: 5, meshWith: { gear: "g1" }, mode: "new_body" };
  const rack: GearFeature = { id: "k", op: "gear", kind: "rack", teeth: 30, width: 5, meshWith: { gear: "g1" }, mode: "new_body" };
  const all = [g1, g2, ring, rack];

  it("follows the partner's module and gives centre distance and ratio", () => {
    expect(gearParams(g2, all, { m: 2 })).toMatchObject({ module: 2, teeth: 40, pressureAngle: 20 });
    // m (z1 + z2) / 2 = 2 · 60 / 2.
    expect(pairInfo(g2, all, { m: 2 })).toEqual({ distance: 60, ratio: 2 });
    // A ring: m (z2 − z1) / 2.
    expect(pairInfo(ring, all, { m: 2 })).toEqual({ distance: 40, ratio: 3 });
    expect(pairInfo(rack, all, { m: 2 })!.distance).toBeNaN();
    expect(pairInfo(g1, all, { m: 2 })).toBeNull();
  });

  it("gives nothing while a value does not work out", () => {
    expect(gearParams(g1, all, {})).toBeNull();
    expect(gearParams(g2, all, {})).toBeNull();
    expect(pairInfo(g2, all, {})).toBeNull();
    expect(gearParams({ ...g2, meshWith: { gear: "zz" } }, all, { m: 2 })).toBeNull();
  });
});

describe("bend numbers", () => {
  const strip = { min: [0, 0, 0], max: [100, 20, 2] };

  it("bends a strip round its width and rolls a spiral flat", () => {
    expect(bendDefaults("bend", strip)).toEqual({ mode: "bend", axis: { ref: "origin.Y" }, angle: 90, radius: undefined, gap: undefined });
    // A ring of 100 mm: r = 100 / 2π = 15.92 mm.
    expect(bendDefaults("wrap", strip)).toMatchObject({ mode: "wrap", axis: { ref: "origin.Y" }, radius: 15.92 });
    expect(bendDefaults("spiral", strip)).toMatchObject({ mode: "spiral", axis: { ref: "origin.Z" }, radius: 20, gap: 1 });
  });

  it("describes a bend's result and warns about turns that touch", () => {
    expect(describeBend("spiral", { turns: 2.345, outerRadius: 30, length: 100, thickness: 2 })).toMatch(/2\.3 .*60 mm.*100 mm.*2 mm/);
    expect(describeBend("wrap", { closed: 1, radius: 15.92 })).toMatch(/31\.8 mm/);
    expect(describeBend("wrap", { closed: 0, angle: 180, radius: 10 })).toMatch(/180°.*20 mm/);
    expect(describeBend("bend", { closed: 1, radius: 5 })).toMatch(/5 mm/);
    expect(describeBend("bend", { closed: 0, radius: 7.25 })).toMatch(/7\.3 mm/);
    const spiral = { id: "b", op: "bend", mode: "spiral", bodies: [], axis: { ref: "origin.Z" } } as Extract<Feature, { op: "bend" }>;
    expect(gapProblem(spiral, 0)!.error).toBe(true);
    expect(gapProblem(spiral, 0.2)!.error).toBe(false);
    expect(gapProblem(spiral, 1)).toBeNull();
    expect(gapProblem({ ...spiral, mode: "bend" }, 0)).toBeNull();
  });

  it("works out the size before bending and the box of the picked parts", () => {
    // Length along X, thickness along Z, width along Y.
    expect(unbentBox({ ox: 0, oy: 0, oz: 1, ax: 0, ay: 1, az: 0, length: 100, thickness: 2, width: 20 })).toEqual({ min: [0, 0, 0], max: [100, 20, 2] });
    expect(partsBox(out, ["ex1"])).toEqual({ min: [0, 0, 0], max: [40, 20, 10] });
    expect(partsBox(out, ["zz"])).toBeNull();
    expect(partsBox(null, ["ex1"])).toBeNull();
  });
});
