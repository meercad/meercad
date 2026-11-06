import { describe, expect, it } from "vitest";
import { clearances, type RebuildReport } from "@meercad/kernel";
import { OPENGRID, PEGBOARDS, openGridOpening } from "@meercad/model";
import { validateDocument, type Feature, type WallFeature } from "@meercad/schema";
import { doc, getOcct, newSession } from "./helpers.js";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const failed = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id && f.status === "error")?.message ?? "";
const body = (r: RebuildReport, id: string) => r.bodies.find((b) => b.id === id)!;
const board = (p: Partial<WallFeature> = {}): WallFeature => ({ id: "wl1", op: "wall", system: "opengrid", kind: "board", units: [2, 2], ...p });
const holder = (p: Partial<WallFeature> = {}): WallFeature => ({ id: "wl2", op: "wall", system: "opengrid", kind: "holder", units: [1, 1], board: "wl1", ...p });

async function build(features: Feature[]) {
  const s = await newSession();
  const out = s.rebuild(doc(features));
  return { ...out, session: s };
}

/** Volume of one opening: the octagons' areas change quadratically between sections, so Simpson's rule is exact. */
function openingVolume(variant: "full" | "lite"): number {
  const area = (l: [number, number][]) => {
    let a = 0;
    for (let i = 0; i < l.length; i++) a += l[i]![0] * l[(i + 1) % l.length]![1] - l[(i + 1) % l.length]![0] * l[i]![1];
    return a / 2;
  };
  const s = openGridOpening(variant);
  let v = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!, b = s[i]!;
    const mid = a.loop.map(([x, y], k) => [(x + b.loop[k]![0]) / 2, (y + b.loop[k]![1]) / 2] as [number, number]);
    v += ((b.z - a.z) / 6) * (area(a.loop) + 4 * area(mid) + area(b.loop));
  }
  return v;
}

async function overlap(session: Awaited<ReturnType<typeof build>>["session"], a: string, b: string) {
  const oc = await getOcct();
  return (await clearances(oc, session.state!, [a, b], {}, 0)).find((p) => p.a !== p.b)!;
}

describe("openGrid boards", () => {
  it("builds a full board: 28 mm cells, 6.8 mm thick, the openings' profile and cut corners", async () => {
    const { report, meshes } = await build([board({ units: [3, 2] })]);
    ok(report);
    const b = body(report, "wl1");
    expect(b.bbox.min).toEqual([expect.closeTo(-42, 6), expect.closeTo(-28, 6), expect.closeTo(0, 6)]);
    expect(b.bbox.max).toEqual([expect.closeTo(42, 6), expect.closeTo(28, 6), expect.closeTo(6.8, 6)]);
    const c = OPENGRID.cornerCut;
    expect(b.volume).toBeCloseTo(84 * 56 * 6.8 - 6 * openingVolume("full") - 4 * (c * c / 2) * 6.8, 1);
    const tags = new Set(meshes.find((m) => m.bodyId === "wl1")!.faceTags.flat());
    for (const tag of ["wl1.back", "wl1.front", "wl1.side", "wl1.opening"]) expect(tags).toContain(tag);
  });

  it("builds a lite board 4 mm thick with countersunk screw holes at the inner crossings", async () => {
    const plain = (await build([board({ variant: "lite", units: [3, 3] })])).report;
    const { report, meshes } = await build([board({ variant: "lite", units: [3, 3], screws: true })]);
    ok(plain);
    ok(report);
    expect(body(plain, "wl1").bbox.max[2]).toBeCloseTo(4, 6);
    const c = OPENGRID.cornerCut;
    expect(body(plain, "wl1").volume).toBeCloseTo(84 * 84 * 4 - 9 * openingVolume("lite") - 4 * (c * c / 2) * 4, 1);
    // Four holes, each at least the 4.1 mm shank through the board.
    expect(body(report, "wl1").volume).toBeLessThan(body(plain, "wl1").volume - 4 * Math.PI * 2.05 ** 2 * 4 + 1e-3);
    expect(new Set(meshes.find((m) => m.bodyId === "wl1")!.faceTags.flat())).toContain("wl1.hole");
  });

  it("wants room for screw holes", async () => {
    const { report } = await build([board({ units: [1, 3], screws: true })]);
    expect(failed(report, "wl1")).toMatch(/2 × 2/);
  });
});

describe("openGrid holders", () => {
  for (const variant of ["full", "lite"] as const)
    it(`clicks a ${variant} snap into the board without overlap`, async () => {
      const fit = await build([board({ variant }), holder({ accessory: "plain" })]);
      ok(fit.report);
      const h = body(fit.report, "wl2");
      // The snap reaches to the board's back (lite: 0.6 mm short of it), the plate stands on the front.
      expect(h.bbox.min[2]).toBeCloseTo(variant === "full" ? 0 : 0.6, 6);
      expect(h.bbox.max[2]).toBeCloseTo((variant === "full" ? 6.8 : 4) + 3, 6);
      const o = await overlap(fit.session, "wl1", "wl2");
      expect(o.overlap).toBeLessThan(1e-3);
      expect(o.distance).toBeLessThan(1e-4);
    });

  it("collides when the snap sits off-centre in its opening", async () => {
    // A free holder stands with its snap's back on the plane: move it onto the board's front.
    const onBoard = await build([board(), { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 0 }, holder({ accessory: "plain", board: undefined, position: [-14 + 0.3, -14] })]);
    ok(onBoard.report);
    expect(body(onBoard.report, "wl2").bbox.min[2]).toBeCloseTo(0, 6);
    const o = await overlap(onBoard.session, "wl1", "wl2");
    expect(o.overlap).toBeGreaterThan(0.01);
  });

  it("puts snaps in the corner cells and builds every accessory", async () => {
    for (const [accessory, extra] of [["hook", {}], ["ring", { size: 18 }], ["shelf", { depth: 50 }], ["bin", { size: 2 }]] as const) {
      const units: [number, number] = accessory === "bin" ? [4, 2] : [2, 2];
      const { report, meshes } = await build([board({ units: [4, 4] }), holder({ units, accessory, ...extra })]);
      ok(report);
      const tags = new Set(meshes.find((m) => m.bodyId === "wl2")!.faceTags.flat());
      for (const tag of ["wl2.snap", "wl2.plate", `wl2.${accessory === "bin" ? "shelf" : accessory}`]) expect(tags, accessory).toContain(tag);
    }
  });

  it("holds Gridfinity bins on a bin shelf, and says how wide the holder must be", async () => {
    const tight = await build([board({ units: [4, 2] }), holder({ units: [3, 2], accessory: "bin", size: 2 })]);
    expect(failed(tight.report, "wl2")).toMatch(/4 cells wide/);
    const { report } = await build([
      board({ units: [4, 2] }),
      holder({ units: [4, 2], accessory: "bin", size: 2 }),
    ]);
    ok(report);
    const h = body(report, "wl2");
    // The shelf reaches 45 mm out from the plate.
    expect(h.bbox.max[2]).toBeCloseTo(6.8 + 3 + 45, 3);
  });

  it("makes a screw snap with a countersunk hole and no plate", async () => {
    const { report, meshes } = await build([board({ units: [2, 2] }), holder({ accessory: "screw" })]);
    ok(report);
    expect(body(report, "wl2").bbox.max[2]).toBeCloseTo(6.8, 6);
    expect(new Set(meshes.find((m) => m.bodyId === "wl2")!.faceTags.flat())).toContain("wl2.hole");
  });
});

describe("pegboards", () => {
  it("builds a board with round or square holes to the preset", async () => {
    for (const grid of ["us_quarter", "metric_25", "square_38"] as const) {
      const p = PEGBOARDS[grid];
      const { report } = await build([board({ system: "pegboard", grid, units: [4, 3] })]);
      ok(report);
      const b = body(report, "wl1");
      expect(b.bbox.max[0] - b.bbox.min[0]).toBeCloseTo(4 * p.pitch, 6);
      expect(b.bbox.max[2]).toBeCloseTo(p.thickness, 6);
      const r = Math.min(3, p.pitch / 4);
      const hole = p.square ? p.hole ** 2 : Math.PI * (p.hole / 2) ** 2;
      expect(b.volume).toBeCloseTo((4 * p.pitch * 3 * p.pitch - (4 - Math.PI) * r * r - 12 * hole) * p.thickness, 0);
    }
  });

  for (const grid of ["us_quarter", "us_eighth", "square_38"] as const)
    it(`hangs a holder on a ${grid} board: pegs through the holes, the top ones hooked behind`, async () => {
      const { report, meshes, session } = await build([board({ system: "pegboard", grid, units: [4, 4] }), holder({ system: "pegboard", units: [2, 2], cell: [1, 1] })]);
      ok(report);
      const p = PEGBOARDS[grid];
      const h = body(report, "wl2");
      expect(h.bbox.min[2]).toBeLessThan(-0.4);
      expect(new Set(meshes.find((m) => m.bodyId === "wl2")!.faceTags.flat())).toContain("wl2.peg");
      const o = await overlap(session, "wl1", "wl2");
      expect(o.overlap).toBeLessThan(1e-3);
      expect(h.bbox.min[2]).toBeCloseTo(-(0.4 + p.hole - 0.6), 6);
    });

  it("keeps the screw snap to openGrid", () => {
    const v = validateDocument(doc([board({ system: "pegboard" }), holder({ system: "pegboard", accessory: "screw" })]));
    const errors = v.ok ? [] : v.errors;
    expect(errors.join("\n")).toMatch(/screw snap/);
  });

  it("refuses a holder on the wrong kind of board", () => {
    const v = validateDocument(doc([board({ system: "pegboard" }), holder()]));
    const errors = v.ok ? [] : v.errors;
    expect(errors.join("\n")).toMatch(/pegboard board/);
  });
});

describe("the tool wall example", () => {
  it("clicks every holder into the board and stands the bin in the bin shelf, all without overlap", async () => {
    const ex = EXAMPLES.find((e) => e.name === "Tool wall on openGrid")!;
    const s = await newSession();
    const { report } = s.rebuild(ex.doc);
    ok(report);
    const bin = body(report, "gf1");
    expect(bin.bbox.min[1]).toBeCloseTo(-68, 3);
    const oc = await getOcct();
    const ids = ["wl1", "wl2", "wl3", "wl4", "wl5", "wl6", "gf1"];
    for (const p of await clearances(oc, s.state!, ids, {}, 0)) if (p.a !== p.b) expect(p.overlap, `${p.a} ${p.b}`).toBeLessThan(1e-3);
    const fit = (await clearances(oc, s.state!, ["wl6", "gf1"], {}, 0)).find((p) => p.a !== p.b)!;
    expect(fit.distance).toBeLessThan(1e-3);
  });
});
