import { describe, expect, it } from "vitest";
import { cableMesh, cableRig, cableSpec, cableTrouble, checkCable, describeCable, isStretched, isTooTight, layCable, plugSize, restEnds } from "./cable.js";
import { MeshCollider } from "./collide.js";
import { partMaterial } from "./materials.js";
import { rotationAbout, translation, type V3 } from "./motion.js";
import type { ResolvedCable } from "./resolve.js";

const round = (points: ResolvedCable["points"], extra: Partial<ResolvedCable> = {}): ResolvedCable => ({ id: "cab1", op: "cable", points, diameter: 2, ...extra });

/** A closed box mesh from min to max. */
function boxMesh(min: V3, max: V3) {
  const p: number[] = [];
  for (let c = 0; c < 8; c++) p.push(c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]);
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const idx = faces.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  return new MeshCollider(p, idx);
}

describe("cable layout", () => {
  it("runs straight between two points at their distance", () => {
    const spec = cableSpec({ diameter: 2 });
    const pts: V3[] = [[0, 0, 0], [100, 0, 0]];
    const l = layCable(spec, pts, restEnds(pts));
    expect(l.length).toBeCloseTo(100, 6);
    expect(l.minRadius).toBe(Infinity);
    expect(l.line.at(-1)).toEqual([100, 0, 0]);
  });

  it("bends smoothly through a corner and measures the bend", () => {
    const spec = cableSpec({ diameter: 2 });
    const pts: V3[] = [[0, 0, 0], [50, 0, 0], [50, 50, 0]];
    const l = layCable(spec, pts, restEnds(pts));
    // Leaving and arriving straight, it swings a little wide round the corner.
    expect(l.length).toBeLessThan(110);
    expect(l.length).toBeGreaterThan(Math.hypot(50, 50));
    expect(l.minRadius).toBeGreaterThan(1);
    expect(l.minRadius).toBeLessThan(50);
    // It passes through the middle point.
    expect(l.line.some((p) => Math.hypot(p[0] - 50, p[1], p[2]) < 1e-9)).toBe(true);
  });

  it("fills in defaults from the material and checks numbers", () => {
    expect(cableSpec({ diameter: 2 }).bendRadius).toBe(6);
    expect(cableSpec({ diameter: 2, material: "pvc" }).bendRadius).toBe(12);
    expect(cableSpec({ shape: "ribbon" })).toMatchObject({ width: 12.7, thickness: 0.9, conductors: 10, material: "cableribbon" });
    expect(() => cableSpec({})).toThrow(/diameter/);
    expect(() => cableSpec({ shape: "ribbon", conductors: 1 })).toThrow(/2 to 80/);
  });

  it("sizes plugs by their contacts", () => {
    expect(plugSize({ kind: "jst_xh", pins: 3 })).toMatchObject({ width: 9.9, pins: 3 });
    expect(plugSize({ kind: "idc" }, 16)).toMatchObject({ pins: 16 });
    expect(() => plugSize({ kind: "idc", pins: 9 })).toThrow(/even/);
    expect(() => plugSize({ kind: "xt30", pins: 3 })).toThrow(/2 contacts/);
  });

  it("starts the cable at the back of a plug", () => {
    const spec = cableSpec({ diameter: 3, start: { kind: "xt30" } });
    const pts: V3[] = [[0, 0, 0], [100, 0, 0]];
    const l = layCable(spec, pts, restEnds(pts));
    expect(l.plugs).toHaveLength(1);
    // The housing is 15.5 long; the cable reaches 1 mm into it.
    expect(l.line[0]![0]).toBeCloseTo(14.5, 6);
    expect(l.length).toBeCloseTo(86.5, 6);
    expect(() => layCable(spec, [[0, 0, 0], [10, 0, 0]], restEnds([[0, 0, 0], [10, 0, 0]]))).toThrow(/plug reaches past/);
  });

  it("meshes a closed tube with plugs", () => {
    const spec = cableSpec({ diameter: 2, start: { kind: "jst_ph" }, end: { kind: "jst_ph" } });
    const pts: V3[] = [[0, 0, 0], [40, 10, 5], [80, 0, 0]];
    const m = cableMesh(layCable(spec, pts, restEnds(pts)), spec);
    expect(m.indices.length % 3).toBe(0);
    expect(m.positions.length).toBe(m.normals.length);
    expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
    // Closed: every edge is shared by exactly two triangles (per piece: tube with caps, boxes).
    const edges = new Map<string, number>();
    const key = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!].map((v) => v.toFixed(4)).join(",");
    for (let t = 0; t < m.indices.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const a = key(m.indices[t + k]!);
        const b = key(m.indices[t + ((k + 1) % 3)]!);
        if (a === b) continue;
        const e = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    expect([...edges.values()].filter((n) => n % 2).length).toBe(0);
  });
});

describe("cable while parts move", () => {
  // A cable from the ground to a part 100 mm away that slides along X.
  const rig = cableRig(round([{ at: [0, 0, 0] }, { at: [50, 0, 10] }, { at: [100, 0, 0], on: "arm" }], { slack: 5 }));

  it("is fine at rest and stretched once the part moves too far", () => {
    const rest = checkCable(rig, new Map());
    expect(rest.state.stretch).toBeCloseTo(-5, 6);
    expect(cableTrouble(rest.state)).toBe(false);
    const near = checkCable(rig, new Map([["arm", translation([4, 0, 0])]]));
    expect(isStretched(near.state)).toBe(false);
    const far = checkCable(rig, new Map([["arm", translation([20, 0, 0])]]));
    expect(isStretched(far.state)).toBe(true);
    expect(far.state.stretch).toBeGreaterThan(10);
    expect(describeCable(far.state)).toMatch(/stretched by/);
  });

  it("turns its end with the part and reports bends tighter than allowed", () => {
    // The arm swings the end round so the cable doubles back.
    const swung = checkCable(rig, new Map([["arm", rotationAbout([100, 0, 0], [0, 0, 1], 170)]]));
    expect(swung.layout!.line.at(-1)![0]).toBeCloseTo(100, 6);
    const r = rig.rest.minRadius;
    expect(swung.state.minRadius).toBeLessThan(r);
    const tight = checkCable(cableRig(round([{ at: [0, 0, 0] }, { at: [10, 0, 0] }, { at: [10, 3, 0] }, { at: [0, 3, 0] }], { bendRadius: 20 })), new Map());
    expect(isTooTight(tight.state)).toBe(true);
  });

  it("finds parts it runs into, but not the part it is fixed to", () => {
    // A block in the way of the cable, another one the end is fixed in.
    const wall = { id: "wall", collider: boxMesh([40, -5, -5], [45, 5, 20]), still: true };
    const socket = { id: "arm", collider: boxMesh([97, -5, -5], [110, 5, 5]), still: false };
    const { state } = checkCable(rig, new Map(), [wall, socket]);
    expect(state.hits).toEqual(["wall"]);
    const clear = checkCable(rig, new Map(), [{ ...wall, pose: translation([0, 50, 0]) }, socket]);
    expect(clear.state.hits).toEqual([]);
  });

  it("gives the cable its cable material", () => {
    const doc = { features: [{ id: "cab1", op: "cable" as const, points: [{ at: [0, 0, 0] as [number, number, number] }, { at: [1, 0, 0] as [number, number, number] }], diameter: 2, material: "pvc" as const }] };
    expect(partMaterial(doc, "cab1")?.id).toBe("cablepvc");
    expect(partMaterial({ ...doc, partMaterials: { cab1: "copper" } }, "cab1")?.id).toBe("copper");
  });
});
