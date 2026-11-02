import { describe, expect, it } from "vitest";
import { exportMeshes, fitMesh, reconstruct } from "@meercad/kernel";
import { parseStl, writeStl } from "@meercad/io";
import type { Feature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

async function meshOf(features: Feature[]): Promise<{ corners: Float32Array; volume: number }> {
  const s = await newSession();
  const r = s.rebuild(doc(features)).report;
  expect(r.features.filter((f) => f.status === "error")).toEqual([]);
  return { corners: parseStl(writeStl(exportMeshes(await getOcct(), s.state!))).positions, volume: r.bodies.reduce((v, b) => v + b.volume, 0) };
}

/** 55 × 40 × 12 plate with a Ø10 and a Ø6 hole, away from the origin. */
const plate: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 100, 110, 55, 40), ...circle("c1", 115, 130, 5), ...circle("c2", 140, 125, 3)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 12, mode: "new_body" },
];
/** 20 × 20 × 5 base with a Ø10 × 15 boss, standing on the XY plane. */
const pin: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 20, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
  sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 10, 10, 5)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 15, mode: "join" },
];

describe("reconstruct", () => {
  it("rebuilds a plate with holes as one dimensioned sketch and an extrude", async () => {
    const { corners, volume } = await meshOf(plate);
    const rb = reconstruct(fitMesh(corners));
    expect(rb.warnings).toEqual([]);
    expect(rb.features.map((f) => f.op)).toEqual(["sketch", "extrude"]);
    expect(rb.params).toMatchObject({ h1: "12 mm", width1: "55 mm", depth1: "40 mm", hole_d1: "10 mm", hole_d2: "6 mm" });
    expect(rb.measurements.map((m) => m.param)).toEqual(["width1", "depth1", "h1", "hole_d1", "hole_d2"]);
    const s = await newSession();
    const r = s.rebuild({ format: "meercad/1", params: rb.params, features: rb.features, rollback: null }).report;
    expect(r.features.map((f) => `${f.id}: ${f.status} ${f.message ?? ""}`).filter((x) => !/ ok $/.test(x))).toEqual([]);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(volume, 0);
    expect(r.bodies[0]!.bbox.min).toEqual([100, 110, 0].map((v) => expect.closeTo(v, 3)));
    // Fully constrained: no free degrees of freedom left.
    expect(r.sketches[0]!.diagnostics.dof).toBe(0);
    // Changing a parameter changes the part.
    const bigger = s.rebuild({ format: "meercad/1", params: { ...rb.params, hole_d1: "12 mm" }, features: rb.features, rollback: null }).report;
    expect(bigger.bodies[0]!.volume).toBeCloseTo(volume - Math.PI * (36 - 25) * 12, 0);
  });

  it("stacks a boss on a base as two layers", async () => {
    const { corners, volume } = await meshOf(pin);
    const rb = reconstruct(fitMesh(corners));
    // Layers are bodies of their own, fused in one boolean at the end.
    expect(rb.features.map((f) => f.op)).toEqual(["sketch", "extrude", "plane", "sketch", "extrude", "boolean"]);
    expect(rb.params).toMatchObject({ h1: "5 mm", h2: "15 mm", width1: "20 mm", depth1: "20 mm", hole_d1: "10 mm" });
    const s = await newSession();
    const r = s.rebuild({ format: "meercad/1", params: rb.params, features: rb.features, rollback: null }).report;
    expect(r.features.map((f) => `${f.id}: ${f.status} ${f.message ?? ""}`).filter((x) => !/ ok $/.test(x))).toEqual([]);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(volume, 0);
  });

  it("rebuilds a part lying at an angle upright and turns it back into place", async () => {
    const { corners, volume } = await meshOf(pin);
    // Tilted by 30° about X and 20° about Y, so no face is square to X, Y or Z.
    const [a, b] = [(30 * Math.PI) / 180, (20 * Math.PI) / 180];
    const tilted = new Float32Array(corners.length);
    for (let i = 0; i < corners.length; i += 3) {
      const [x, y0, z0] = [corners[i]!, corners[i + 1]!, corners[i + 2]!];
      const [y, z] = [y0 * Math.cos(a) - z0 * Math.sin(a), y0 * Math.sin(a) + z0 * Math.cos(a)];
      tilted.set([x * Math.cos(b) + z * Math.sin(b), y, -x * Math.sin(b) + z * Math.cos(b)], i);
    }
    const fit = fitMesh(tilted);
    const rb = reconstruct(fit);
    expect(rb.params).toMatchObject({ h1: "5 mm", h2: "15 mm", width1: "20 mm", depth1: "20 mm", hole_d1: "10 mm" });
    expect(rb.features.filter((f) => f.op === "transform").length).toBeGreaterThan(0);
    const s = await newSession();
    const r = s.rebuild({ format: "meercad/1", params: rb.params, features: rb.features, rollback: null }).report;
    expect(r.features.map((f) => `${f.id}: ${f.status} ${f.message ?? ""}`).filter((x) => !/ ok $/.test(x))).toEqual([]);
    expect(r.bodies.map((x) => x.id)).toEqual([rb.body]);
    expect(r.bodies[0]!.volume).toBeCloseTo(volume, 0);
    // Back where the mesh is.
    for (const k of [0, 1, 2]) {
      expect(r.bodies[0]!.bbox.min[k]).toBeCloseTo(fit.bbox.min[k]!, 1);
      expect(r.bodies[0]!.bbox.max[k]).toBeCloseTo(fit.bbox.max[k]!, 1);
    }
  });
});
