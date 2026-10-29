import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature, SketchEntity } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const PI = Math.PI;
/** Frustum volume between two similar areas `h` apart. */
const frustum = (a1: number, a2: number, h: number) => (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
const at = (id: string, z: number): Feature => ({ id, op: "plane", base: { ref: "origin.XY" }, offset: z });
const square = (prefix: string, size: number) => rect(prefix, -size / 2, -size / 2, size, size);

async function run(features: Feature[]) {
  const s = await newSession();
  return s.rebuild(doc(features)).report;
}

describe("loft", () => {
  it("joins two profiles with straight sides", async () => {
    const r = await run([
      sketch("sk1", { ref: "origin.XY" }, square("a", 20)),
      at("pl1", 30),
      sketch("sk2", { ref: "pl1" }, square("b", 10)),
      { id: "lo1", op: "loft", profiles: [{ sketch: "sk1" }, { sketch: "sk2" }], ruled: true, mode: "new_body" },
    ]);
    ok(r);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(frustum(400, 100, 30), 3);
    expect(r.bodies[0]!.bbox.max[2]).toBeCloseTo(30, 6);
  });

  it("goes from square to round", async () => {
    const r = await run([
      sketch("sk1", { ref: "origin.XY" }, square("a", 40)),
      at("pl1", 30),
      sketch("sk2", { ref: "pl1" }, circle("c", 0, 0, 10)),
      { id: "lo1", op: "loft", profiles: [{ sketch: "sk1" }, { sketch: "sk2" }], mode: "new_body" },
    ]);
    ok(r);
    const v = r.bodies[0]!.volume;
    // Between the cylinder over the circle and the prism over the square.
    expect(v).toBeGreaterThan(PI * 100 * 30);
    expect(v).toBeLessThan(1600 * 30);
  });

  it("makes a hollow loft when every profile has a hole", async () => {
    const r = await run([
      sketch("sk1", { ref: "origin.XY" }, [...square("a", 40), ...circle("h1", 0, 0, 5)]),
      at("pl1", 30),
      sketch("sk2", { ref: "pl1" }, [...square("b", 20), ...circle("h2", 0, 0, 5)]),
      { id: "lo1", op: "loft", profiles: [{ sketch: "sk1" }, { sketch: "sk2" }], ruled: true, mode: "new_body" },
    ]);
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(frustum(1600, 400, 30) - PI * 25 * 30, 2);
  });

  it("starts on a face of a part", async () => {
    const r = await run([
      sketch("sk1", { ref: "origin.XY" }, square("a", 40)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
      at("pl1", 40),
      sketch("sk2", { ref: "pl1" }, square("b", 20)),
      { id: "lo1", op: "loft", profiles: [{ face: { face: "ex1.end_cap" } }, { sketch: "sk2" }], ruled: true, mode: "join" },
    ]);
    ok(r);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(40 * 40 * 10 + frustum(1600, 400, 30), 2);
  });

  it("explains what is wrong", async () => {
    const r = await run([
      sketch("sk1", { ref: "origin.XY" }, [...square("a", 40), ...circle("h1", 0, 0, 5)]),
      at("pl1", 30),
      sketch("sk2", { ref: "pl1" }, square("b", 20)),
      { id: "lo1", op: "loft", profiles: [{ sketch: "sk1" }, { sketch: "sk2" }], mode: "new_body" },
    ]);
    expect(status(r, "lo1").message).toMatch(/same number of holes/);
  });
});

/** Path on the XZ plane: up 30, a quarter bend of radius 20, then 20 along x. */
const path: SketchEntity[] = [
  { id: "q0", type: "point", x: 0, y: 0 },
  { id: "q1", type: "point", x: 0, y: 30 },
  { id: "q2", type: "point", x: 20, y: 50 },
  { id: "q3", type: "point", x: 40, y: 50 },
  { id: "qc", type: "point", x: 20, y: 30 },
  { id: "l1", type: "line", p1: "q0", p2: "q1" },
  { id: "a1", type: "arc", center: "qc", start: "q2", end: "q1" },
  { id: "l2", type: "line", p1: "q2", p2: "q3" },
];

describe("sweep", () => {
  it("moves a profile along lines and arcs", async () => {
    const r = await run([
      sketch("sk1", { ref: "origin.XY" }, circle("c", 0, 0, 3)),
      sketch("sk2", { ref: "origin.XZ" }, path),
      { id: "sw1", op: "sweep", profile: { sketch: "sk1" }, path: { sketch: "sk2" }, mode: "new_body" },
    ]);
    ok(r);
    // A round profile swept along a path: its area times the path's length.
    expect(r.bodies[0]!.volume).toBeCloseTo(PI * 9 * (30 + (PI / 2) * 20 + 20), 1);
    const bb = r.bodies[0]!.bbox;
    expect(bb.max[0]).toBeCloseTo(40, 3);
    expect(bb.max[2]).toBeCloseTo(53, 3);
  });

  it("follows only the listed curves, and cuts", async () => {
    const r = await run([
      sketch("sk0", { ref: "origin.XY" }, rect("b", -20, -20, 80, 40)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk0" }, extent: "blind", distance: 60, mode: "new_body" },
      sketch("sk1", { ref: "origin.XY" }, circle("c", 0, 0, 3)),
      sketch("sk2", { ref: "origin.XZ" }, path),
      { id: "sw1", op: "sweep", profile: { sketch: "sk1" }, path: { sketch: "sk2", curves: ["l1"] }, mode: "cut" },
    ]);
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(80 * 40 * 60 - PI * 9 * 30, 1);
  });

  it("explains what is wrong", async () => {
    const branch: SketchEntity[] = [...path, { id: "q4", type: "point", x: 0, y: 60 }, { id: "l3", type: "line", p1: "q1", p2: "q4" }];
    const r = await run([
      sketch("sk1", { ref: "origin.XY" }, circle("c", 0, 0, 3)),
      sketch("sk2", { ref: "origin.XZ" }, branch),
      { id: "sw1", op: "sweep", profile: { sketch: "sk1" }, path: { sketch: "sk2" }, mode: "new_body" },
    ]);
    expect(status(r, "sw1").message).toMatch(/branches/);
  });
});
