import { describe, expect, it } from "vitest";
import { clearances, type RebuildReport } from "@meercad/kernel";
import { GRIDFINITY as G } from "@meercad/model";
import { validateDocument, type Feature, type GridfinityFeature, type SketchEntity } from "@meercad/schema";
import { doc, getOcct, newSession, sketch } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const plate = (p: Partial<GridfinityFeature> = {}): GridfinityFeature => ({ id: "bp1", op: "gridfinity", kind: "baseplate", units: [1, 1], ...p });
const size = (b: RebuildReport["bodies"][number]) => [0, 1, 2].map((i) => b.bbox.max[i]! - b.bbox.min[i]!);

async function build(features: Feature[]) {
  const d = doc(features);
  const v = validateDocument(d);
  expect(v.ok ? [] : v.errors).toEqual([]);
  const s = await newSession();
  return { ...s.rebuild(d), session: s };
}

/** A closed polygon as sketch lines. */
function polygon(prefix: string, pts: [number, number][]): SketchEntity[] {
  return [
    ...pts.map(([x, y], i): SketchEntity => ({ id: `${prefix}p${i}`, type: "point", x, y })),
    ...pts.map((_, i): SketchEntity => ({ id: `${prefix}${i}`, type: "line", p1: `${prefix}p${i}`, p2: `${prefix}p${(i + 1) % pts.length}` })),
  ];
}

describe("gridfinity baseplate for an area, cut for the print bed", () => {
  it("fills a drawer and cuts it into pieces that each fit the bed, with the border on the edge pieces", async () => {
    const { report, meshes } = await build([plate({ drawer: [500, 300], bed: { size: [256, 256] } })]);
    ok(report);
    const pieces = report.bodies.filter((b) => b.id.startsWith("bp1_"));
    // 11 × 7 cells in 499 × 299 (18.5 and 2.5 mm border): 256 mm takes 6 cells, or 5 with a
    // border, so three columns; two rows.
    expect(pieces.map((b) => b.id).sort()).toEqual(["bp1_A1", "bp1_A2", "bp1_A3", "bp1_B1", "bp1_B2", "bp1_B3"]);
    for (const p of pieces) {
      const [w, d] = size(p);
      expect(w).toBeLessThanOrEqual(256 + 1e-6);
      expect(d).toBeLessThanOrEqual(256 + 1e-6);
    }
    // Together exactly the plate: the drawer less 0.5 mm all round, less 77 pockets.
    const xs = pieces.flatMap((b) => [b.bbox.min[0], b.bbox.max[0]]), ys = pieces.flatMap((b) => [b.bbox.min[1], b.bbox.max[1]]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(499, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(299, 6);
    const whole = await build([plate({ drawer: [500, 300] })]);
    const total = pieces.reduce((s, b) => s + b.volume, 0);
    expect(total).toBeCloseTo(whole.report.bodies[0]!.volume, 0);
    const info = report.features.find((f) => f.id === "bp1")!.info!;
    expect(info).toMatchObject({ cells: 77, cellsX: 11, cellsY: 7, pieces: 6 });
    const tags = new Set(meshes.filter((m) => m.bodyId.startsWith("bp1_")).flatMap((m) => m.faceTags.flat()));
    for (const t of ["bp1.pocket", "bp1.joint", "bp1.side", "bp1.top"]) expect(tags).toContain(t);
  });

  it("takes an unusable margin off the bed (2 cm at the back)", async () => {
    // 329 × 309 fits a 340 × 320 bed in one piece; 300 mm usable depth does not.
    const h2s = await build([plate({ drawer: [330, 310], bed: { size: [340, 320] } })]);
    const less = await build([plate({ drawer: [330, 310], bed: { size: [340, 320], margin: [0, 20] } })]);
    ok(h2s.report);
    ok(less.report);
    expect(h2s.report.bodies.map((b) => b.id)).toEqual(["bp1"]);
    for (const b of less.report.bodies) {
      const [w, d] = size(b);
      expect(Math.min(w!, d!)).toBeLessThanOrEqual(300 + 1e-6);
      expect(Math.max(w!, d!)).toBeLessThanOrEqual(340 + 1e-6);
    }
    expect(less.report.bodies.length).toBeGreaterThan(h2s.report.bodies.length);
  });

  it("fills a drawn L-shaped outline: whole cells inside, the rest solid border", async () => {
    const L: [number, number][] = [[0, 0], [300, 0], [300, 100], [150, 100], [150, 200], [0, 200]];
    const { report } = await build([sketch("sk1", { ref: "origin.XY" }, polygon("l", L)), plate({ outline: { sketch: "sk1" }, gap: 0.5, bed: { size: [180, 180] } })]);
    ok(report);
    const info = report.features.find((f) => f.id === "bp1")!.info!;
    expect(info["cells"]).toBe(20);
    const pieces = report.bodies.filter((b) => b.id.startsWith("bp1"));
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      const [w, d] = size(p);
      expect(Math.max(w!, d!)).toBeLessThanOrEqual(180 + 1e-6);
      // Inside the outline less the gap.
      expect(p.bbox.min[0]).toBeGreaterThanOrEqual(0.5 - 1e-3);
      expect(p.bbox.min[1]).toBeGreaterThanOrEqual(0.5 - 1e-3);
      expect(p.bbox.max[0]).toBeLessThanOrEqual(299.5 + 1e-3);
      expect(p.bbox.max[1]).toBeLessThanOrEqual(199.5 + 1e-3);
    }
    // The L's area less the gap band, at the plate's height, less 20 pockets.
    const pocketFree = (300 * 200 - 150 * 100 - 0.5 * (2 * 300 + 2 * 200)) * G.pocketHeight;
    const total = pieces.reduce((s, b) => s + b.volume, 0);
    expect(total).toBeLessThan(pocketFree);
    expect(total).toBeGreaterThan(pocketFree - 20 * 42 * 42 * G.pocketHeight);
  });

  it("leaves the rest empty without the border: the plate ends at its cells", async () => {
    const { report } = await build([plate({ drawer: [500, 300], fill: false, bed: { size: [256, 256] } })]);
    ok(report);
    const pieces = report.bodies.filter((b) => b.id.startsWith("bp1"));
    const xs = pieces.flatMap((b) => [b.bbox.min[0], b.bbox.max[0]]), ys = pieces.flatMap((b) => [b.bbox.min[1], b.bbox.max[1]]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(11 * 42, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(7 * 42, 6);
    // Without the 18.5 mm borders the 11 columns fit two pieces wide.
    expect(pieces.map((b) => b.id).sort()).toEqual(["bp1_A1", "bp1_A2", "bp1_B1", "bp1_B2"]);
    expect(report.features.find((f) => f.id === "bp1")!.info).toMatchObject({ cells: 77, borderX: 18.5, borderY: 2.5 });
    // The same cells as with the border, less the border's material.
    const filled = await build([plate({ drawer: [500, 300], bed: { size: [256, 256] } })]);
    const vol = (r: RebuildReport) => r.bodies.reduce((n, b) => n + b.volume, 0);
    const border = (499 * 299 - 462 * 294) * G.pocketHeight;
    expect(vol(filled.report) - vol(report)).toBeCloseTo(border, -1);
  });

  it("an outline without the border is just its cells", async () => {
    const L: [number, number][] = [[0, 0], [300, 0], [300, 100], [150, 100], [150, 200], [0, 200]];
    const { report } = await build([sketch("sk1", { ref: "origin.XY" }, polygon("l", L)), plate({ outline: { sketch: "sk1" }, fill: false })]);
    ok(report);
    const one = 42 * 42 * G.pocketHeight;
    const total = report.bodies.reduce((n, b) => n + b.volume, 0);
    expect(report.features.find((f) => f.id === "bp1")!.info!["cells"]).toBe(20);
    // 20 cells' frames: less than 20 solid squares, and nothing outside them.
    expect(total).toBeLessThan(20 * one);
    for (const b of report.bodies) {
      expect(b.bbox.min[0]).toBeGreaterThanOrEqual(0.5 - 1e-3);
      expect(b.bbox.max[0]).toBeLessThanOrEqual(299.5 + 1e-3);
    }
  });

  it("holds a bin in a cell of a cut-up baseplate", async () => {
    const oc = await getOcct();
    const features: Feature[] = [
      plate({ units: [8, 2], bed: { size: [200, 200] }, magnets: true }),
      { id: "gf1", op: "gridfinity", kind: "bin", units: [2, 1], height: 3, baseplate: "bp1", cell: [3, 0] },
    ];
    const { report, session } = await build(features);
    ok(report);
    const bin = report.bodies.find((b) => b.id === "gf1")!;
    // Cells 3 and 4 of 8 straddle the cut between the two pieces (4 cells each).
    expect((bin.bbox.min[0] + bin.bbox.max[0]) / 2).toBeCloseTo(0, 6);
    const ids = report.bodies.filter((b) => b.id.startsWith("bp1_")).map((b) => b.id);
    expect(ids.sort()).toEqual(["bp1_A1", "bp1_A2"]);
    const fit = await clearances(oc, session.state!, ["gf1", ...ids], {}, 0);
    for (const p of fit.filter((x) => x.a === "gf1" || x.b === "gf1")) expect(p.overlap).toBeLessThan(1e-3);
  });

  it("says what is wrong", async () => {
    const small = await build([plate({ drawer: [500, 300], bed: { size: [40, 40] } })]);
    expect(small.report.features[0]!.status).toBe("error");
    expect(small.report.features[0]!.message).toMatch(/too small/);
    const v = validateDocument(doc([plate({ bed: {} as never })]));
    expect(v.ok ? "" : v.errors.join(" ")).toMatch(/size/);
  });
});
