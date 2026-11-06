import { describe, expect, it } from "vitest";
import { clearances, type RebuildReport } from "@meercad/kernel";
import { GRIDFINITY as G, LABEL_SYMBOLS } from "@meercad/model";
import { validateDocument, type Feature, type GridfinityFeature, type LabelFeature } from "@meercad/schema";
import { doc, getOcct, newSession } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const body = (r: RebuildReport, id: string) => r.bodies.find((b) => b.id === id)!;
const bin = (p: Partial<GridfinityFeature> = {}): GridfinityFeature => ({ id: "gf1", op: "gridfinity", kind: "bin", units: [1, 1], height: 3, ...p });
const plate = (p: Partial<GridfinityFeature> = {}): GridfinityFeature => ({ id: "bp1", op: "gridfinity", kind: "baseplate", units: [3, 2], ...p });

/**
 * Exact volumes of the profiles: an outline `d` inside a w × h rectangle with corner radius r has
 * area (w−2d)(h−2d) − (4−π)(r−d)²; along a slope d changes linearly with z, so Simpson's rule is exact.
 */
const area = (w: number, h: number, r: number, d: number) => (w - 2 * d) * (h - 2 * d) - (4 - Math.PI) * (r - d) ** 2;
function profileVolume(w: number, h: number, r: number, profile: [number, number][]): number {
  let v = 0;
  for (let i = 1; i < profile.length; i++) {
    const [z0, d0] = profile[i - 1]!, [z1, d1] = profile[i]!;
    v += ((z1 - z0) / 6) * (area(w, h, r, d0) + 4 * area(w, h, r, (d0 + d1) / 2) + area(w, h, r, d1));
  }
  return v;
}
const footVolume = profileVolume(41.5, 41.5, G.binRadius, G.foot);

async function build(features: Feature[]) {
  const s = await newSession();
  const out = s.rebuild(doc(features));
  return { ...out, session: s };
}

describe("gridfinity bins", () => {
  it("builds a solid bin to the standard's sizes: foot profile and 7 mm units", async () => {
    const { report } = await build([bin({ height: 2, solid: true, lip: false })]);
    ok(report);
    const b = body(report, "gf1");
    expect(b.bbox.min).toEqual([expect.closeTo(-20.75, 6), expect.closeTo(-20.75, 6), expect.closeTo(0, 6)]);
    expect(b.bbox.max).toEqual([expect.closeTo(20.75, 6), expect.closeTo(20.75, 6), expect.closeTo(14, 6)]);
    expect(b.volume).toBeCloseTo(footVolume + area(41.5, 41.5, 3.75, 0) * (14 - 4.75), 1);
  });

  it("hollows a bin with walls, floor and the stacking lip 4.4 mm above the rim", async () => {
    const { report, meshes } = await build([bin({ units: [2, 1], height: 3 })]);
    ok(report);
    const b = body(report, "gf1");
    const [W, D, H, t, floor] = [83.5, 41.5, 21, G.wall, G.binFloor];
    expect(b.bbox.max[0] - b.bbox.min[0]).toBeCloseTo(W, 6);
    expect(b.bbox.max[1] - b.bbox.min[1]).toBeCloseTo(D, 6);
    expect(b.bbox.max[2]).toBeCloseTo(H + 4.4, 6);
    // The inside: straight walls, the 45° support from the wall to the lip, then the lip itself.
    const support = H - (2.6 - t);
    const inside = profileVolume(W, D, 3.75, [[floor, t], [support, t], ...G.lip.map(([z, d]) => [H + z, d] as [number, number])]);
    expect(b.volume).toBeCloseTo(2 * footVolume + area(W, D, 3.75, 0) * (H + 4.4 - 4.75) - inside, 1);
    const tags = new Set(meshes.find((m) => m.bodyId === "gf1")!.faceTags.flat());
    for (const tag of ["gf1.bottom", "gf1.foot", "gf1.floor", "gf1.wall", "gf1.inner", "gf1.lip"]) expect(tags).toContain(tag);
  });

  it("adds dividers, scoops, label tabs and magnet and screw holes", async () => {
    const plain = (await build([bin({ units: [2, 1], height: 4 })])).report;
    const { report, meshes, warnings } = await build([bin({ units: [2, 1], height: 4, dividers: [2, 1], scoop: 8, tab: {}, magnets: true, screws: true })]) as Awaited<ReturnType<typeof build>> & { warnings?: unknown };
    void warnings;
    ok(report);
    const tags = new Set(meshes.find((m) => m.bodyId === "gf1")!.faceTags.flat());
    for (const tag of ["gf1.divider", "gf1.scoop", "gf1.tab", "gf1.hole"]) expect(tags).toContain(tag);
    // Two x dividers and one y divider make six compartments; the extras add material, the holes take some.
    const holes = 8 * (Math.PI * (6.5 / 2) ** 2 * 2.4 + Math.PI * 1.5 ** 2 * (6 - 2.4));
    expect(body(report, "gf1").volume).toBeGreaterThan(body(plain, "gf1").volume - holes + 2 * 25 * 1.2 * 20);
  });

  it("stacks: a bin set 0.35 mm below the rim of another sits on its lip without overlapping", async () => {
    const stack = (offset: number): Feature[] => [
      bin(),
      { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset },
      bin({ id: "gf2", plane: { ref: "pl1" } }),
    ];
    const oc = await getOcct();
    const seated = await build(stack(21 - G.stackDrop));
    ok(seated.report);
    const pair = (await clearances(oc, seated.session.state!, ["gf1", "gf2"], {}, 0)).find((p) => p.a !== p.b)!;
    expect(pair.overlap).toBeLessThan(1e-3);
    expect(pair.distance).toBeLessThan(1e-4);
    const sunk = await build(stack(21 - G.stackDrop - 0.2));
    const deep = (await clearances(oc, sunk.session.state!, ["gf1", "gf2"], {}, 0)).find((p) => p.a !== p.b)!;
    expect(deep.overlap).toBeGreaterThan(1);
  });

  it("refuses a hollow bin too low for its floor", async () => {
    const { report } = await build([bin({ height: 1, floor: 7 })]);
    expect(report.features.find((f) => f.id === "gf1")!.message).toMatch(/floor below/);
  });
});

describe("gridfinity baseplates", () => {
  it("builds an open baseplate: 42 mm cells with the pocket profile, 4.65 mm high", async () => {
    const { report } = await build([plate()]);
    ok(report);
    const b = body(report, "bp1");
    expect(b.bbox.max[0] - b.bbox.min[0]).toBeCloseTo(126, 6);
    expect(b.bbox.max[1] - b.bbox.min[1]).toBeCloseTo(84, 6);
    expect(b.bbox.max[2]).toBeCloseTo(4.65, 6);
    const pocket = profileVolume(42, 42, 4, G.pocket);
    expect(b.volume).toBeCloseTo(area(126, 84, 4, 0) * 4.65 - 6 * pocket, 1);
  });

  it("adds a floor with magnet and countersunk screw holes", async () => {
    const { report, meshes } = await build([plate({ magnets: true, screws: true })]);
    ok(report);
    const b = body(report, "bp1");
    expect(b.bbox.max[2]).toBeCloseTo(3.4 + 4.65, 6);
    const tags = new Set(meshes.find((m) => m.bodyId === "bp1")!.faceTags.flat());
    for (const tag of ["bp1.hole", "bp1.floor", "bp1.pocket", "bp1.top", "bp1.bottom"]) expect(tags).toContain(tag);
  });

  it("fills a drawer: whole cells centred, the rest as border", async () => {
    const { report } = await build([plate({ drawer: [300, 200] })]);
    ok(report);
    const b = body(report, "bp1");
    expect(b.bbox.max[0] - b.bbox.min[0]).toBeCloseTo(299, 6);
    expect(b.bbox.max[1] - b.bbox.min[1]).toBeCloseTo(199, 6);
    const pocket = profileVolume(42, 42, 4, G.pocket);
    expect(b.volume).toBeCloseTo(area(299, 199, 4, 0) * 4.65 - 7 * 4 * pocket, 0);
  });

  it("holds a bin in a cell without overlap, and a bin pushed 0.4 mm sideways collides", async () => {
    const oc = await getOcct();
    const features: Feature[] = [plate({ magnets: true }), bin({ units: [2, 1], baseplate: "bp1", cell: [1, 1], magnets: true })];
    const { report, session } = await build(features);
    ok(report);
    const b = body(report, "gf1");
    // Cell [1, 1] of a 3 × 2 grid: x from -21 to 63, y from 0 to 42; standing on the 3.4 mm floor.
    expect((b.bbox.min[0] + b.bbox.max[0]) / 2).toBeCloseTo(21, 6);
    expect((b.bbox.min[1] + b.bbox.max[1]) / 2).toBeCloseTo(21, 6);
    expect(b.bbox.min[2]).toBeCloseTo(3.4, 6);
    const fit = (await clearances(oc, session.state!, ["gf1", "bp1"], {}, 0)).find((p) => p.a !== p.b)!;
    expect(fit.overlap).toBeLessThan(1e-3);
    const pushed = await build([...features, { id: "mv1", op: "transform", bodies: ["gf1"], translate: [0.4, 0, 0] }]);
    const clash = (await clearances(oc, pushed.session.state!, ["gf1", "bp1"], {}, 0)).find((p) => p.a !== p.b)!;
    expect(clash.overlap).toBeGreaterThan(0.01);
  });
});

describe("labels", () => {
  const label = (p: Partial<LabelFeature> = {}): LabelFeature => ({ id: "lb1", op: "label", text: "M3×10", symbol: "screw_socket", ...p });
  const plateVolume = (w = 36, h = 11, r = 1, t = 1.2) => area(w, h, r, 0) * t;

  it("raises a symbol and text on a 36 × 11 mm plate", async () => {
    const { report, meshes } = await build([label()]);
    ok(report);
    const b = body(report, "lb1");
    expect(b.bbox.max[0] - b.bbox.min[0]).toBeCloseTo(36, 6);
    expect(b.bbox.max[1] - b.bbox.min[1]).toBeCloseTo(11, 6);
    expect(b.bbox.max[2]).toBeCloseTo(1.8, 6);
    expect(b.volume).toBeGreaterThan(plateVolume() + 5);
    const tags = new Set(meshes.find((m) => m.bodyId === "lb1")!.faceTags.flat());
    for (const tag of ["lb1.top", "lb1.bottom", "lb1.side", "lb1.mark"]) expect(tags).toContain(tag);
  });

  it("makes the marking its own part for a second colour, raised or as a flush inlay", async () => {
    const raised = (await build([label({ separate: true })])).report;
    ok(raised);
    expect(body(raised, "lb1").volume).toBeCloseTo(plateVolume(), 4);
    expect(body(raised, "lb1_mark").bbox.min[2]).toBeCloseTo(1.2, 6);
    const inlay = (await build([label({ separate: true, style: "engraved" })])).report;
    ok(inlay);
    // Plate and inlay together are the whole plate again, flush on top.
    expect(body(inlay, "lb1").volume + body(inlay, "lb1_mark").volume).toBeCloseTo(plateVolume(), 3);
    expect(body(inlay, "lb1_mark").bbox.max[2]).toBeCloseTo(1.2, 6);
    expect(body(inlay, "lb1_mark").volume).toBeCloseTo(body(raised, "lb1_mark").volume, 3);
  });

  it("draws every symbol, alone and with text, raised and engraved", async () => {
    for (const symbol of LABEL_SYMBOLS) {
      const { report } = await build([label({ symbol, text: symbol === "washer" ? "" : "M4", style: symbol === "nut" ? "engraved" : "raised" })]);
      ok(report);
      expect(body(report, "lb1").volume).not.toBeCloseTo(plateVolume(), 1);
    }
  });

  it("goes onto a bin's label tab", async () => {
    const { report } = await build([bin({ tab: {} }), label({ plane: { face: { face: "gf1.tab" } }, width: 30, height: 10, text: "Screws" })]);
    ok(report);
    const lb = body(report, "lb1");
    expect(lb.bbox.min[2]).toBeCloseTo(21, 6);
  });

  it("needs a text or a symbol", () => {
    const v = validateDocument(doc([{ id: "lb1", op: "label", symbol: "none" }]));
    expect(v.ok).toBe(false);
  });
});
