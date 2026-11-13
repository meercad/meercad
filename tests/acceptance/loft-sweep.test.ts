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

/** Closed spline through n points of an ellipse rx × ry. */
function ellipse(prefix: string, n: number, rx: number, ry: number): SketchEntity[] {
  const pts: SketchEntity[] = Array.from({ length: n }, (_, k) => ({ id: `${prefix}p${k}`, type: "point", x: rx * Math.cos((2 * PI * k) / n), y: ry * Math.sin((2 * PI * k) / n) }));
  return [...pts, { id: `${prefix}s`, type: "spline", points: pts.map((p) => p.id), closed: true }];
}
/** A dome: an open spline over the top (13 points), closed below with three lines. */
function dome(prefix: string, w: number, h: number): SketchEntity[] {
  const p = (k: number) => `${prefix}p${k}`;
  const pts: SketchEntity[] = Array.from({ length: 13 }, (_, k) => ({ id: p(k), type: "point", x: w * Math.cos((PI * k) / 12), y: h * Math.sin((PI * k) / 12) }));
  return [
    ...pts,
    { id: `${prefix}q1`, type: "point", x: -w, y: -5 },
    { id: `${prefix}q2`, type: "point", x: w, y: -5 },
    { id: `${prefix}s`, type: "spline", points: pts.map((x) => x.id) },
    { id: `${prefix}l1`, type: "line", p1: p(12), p2: `${prefix}q1` },
    { id: `${prefix}l2`, type: "line", p1: `${prefix}q1`, p2: `${prefix}q2` },
    { id: `${prefix}l3`, type: "line", p1: `${prefix}q2`, p2: p(0) },
  ];
}
/** A loft through the given profiles, `step` apart along Z. */
function loftThrough(sections: SketchEntity[][], step: number): Feature[] {
  const f: Feature[] = [];
  sections.forEach((e, i) => {
    if (i) f.push(at(`pl${i}`, i * step));
    f.push(sketch(`sk${i}`, { ref: i ? `pl${i}` : "origin.XY" }, e));
  });
  f.push({ id: "lo1", op: "loft", profiles: sections.map((_, i) => ({ sketch: `sk${i}` })), mode: "new_body" });
  return f;
}

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

  it("lofts closed splines with many points into a whole solid", async () => {
    const r = await run(loftThrough([ellipse("a", 14, 20, 10), ellipse("b", 14, 15, 8)], 30));
    ok(r);
    const b = r.bodies[0]!;
    // Close to the frustum between the two ellipses; the broken loft lost a third of it.
    expect(b.volume).toBeGreaterThan(0.99 * frustum(PI * 200, PI * 120, 30));
    expect(b.volume).toBeLessThan(1.01 * frustum(PI * 200, PI * 120, 30));
    expect(Math.abs(b.centroid![0])).toBeLessThan(1e-3);
  });

  it("lofts open splines closed with lines, and the part can be split", async () => {
    const r = await run([...loftThrough([dome("a", 20, 15), dome("b", 18, 14), dome("c", 15, 12)], 20), { id: "sp1", op: "split", plane: { ref: "origin.YZ" }, bodies: [] }]);
    ok(r);
    expect(r.bodies).toHaveLength(2);
    expect(Math.abs(r.bodies[0]!.volume / r.bodies[1]!.volume - 1)).toBeLessThan(1e-3);
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
