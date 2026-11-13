import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const PI = Math.PI;
/** 100 × 40 × 20 bar along x with a Ø10 hole through it at x = 30. */
const bar: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 100, 40), ...circle("h", 30, 20, 5)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
];
const at60: Feature = { id: "pl1", op: "plane", base: { ref: "origin.YZ" }, offset: 60 };
const BAR = 100 * 40 * 20 - PI * 25 * 20;

async function run(features: Feature[]) {
  const s = await newSession();

  return s.rebuild(doc(features)).report;
}

const vol = (r: RebuildReport, id: string) => r.bodies.find((b) => b.id === id)?.volume;

describe("split", () => {
  it("cuts a part in two at a plane; the front piece keeps the part's id", async () => {
    const r = await run([...bar, at60, { id: "sp1", op: "split", plane: { ref: "pl1" }, bodies: ["ex1"] }]);
    ok(r);
    expect(r.bodies.map((b) => b.id).sort()).toEqual(["ex1", "sp1"]);
    // The YZ plane's normal is +x: the piece beyond x = 60 keeps the id.
    expect(vol(r, "ex1")).toBeCloseTo(40 * 40 * 20, 3);
    expect(vol(r, "sp1")).toBeCloseTo(60 * 40 * 20 - PI * 25 * 20, 3);
    expect(r.bodies.find((b) => b.id === "ex1")!.bbox.min[0]).toBeCloseTo(60, 6);
  });

  it("keeps one side only, and tags the cut face", async () => {
    const s = await newSession();
    const { report, meshes } = s.rebuild(
      doc([...bar, at60, { id: "sp1", op: "split", plane: { ref: "pl1" }, bodies: [], keep: "back" }]),
    );
    ok(report);
    expect(report.bodies.map((b) => b.id)).toEqual(["ex1"]);
    expect(vol(report, "ex1")).toBeCloseTo(60 * 40 * 20 - PI * 25 * 20, 3);
    expect(meshes[0]!.faceTags.flat()).toContain("sp1.cut");
  });

  it("splits at a face of another part", async () => {
    const r = await run([
      ...bar,
      sketch("sk2", { ref: "origin.XY" }, rect("m", 0, 50, 10, 10)),
      {
        id: "ex2",
        op: "extrude",
        profile: { sketch: "sk2" },
        extent: "blind",
        distance: 8,
        mode: "new_body",
      },
      // The top of the small block (z = 8) cuts the bar.
      { id: "sp1", op: "split", plane: { face: { face: "ex2.end_cap" } }, bodies: ["ex1"] },
    ]);
    ok(r);
    expect(vol(r, "ex1")! + vol(r, "sp1")!).toBeCloseTo(BAR, 3);
    expect(vol(r, "sp1")).toBeCloseTo((BAR / 20) * 8, 3);
  });

  it("explains what is wrong", async () => {
    const r = await run([
      ...bar,
      { id: "pl1", op: "plane", base: { ref: "origin.YZ" }, offset: 150 },
      { id: "sp1", op: "split", plane: { ref: "pl1" }, bodies: ["ex1"] },
    ]);
    expect(status(r, "sp1").message).toMatch(/does not cross/);
  });

  describe("connectors", () => {
    const solid: Feature[] = [
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 100, 40)),
      {
        id: "ex1",
        op: "extrude",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: 20,
        mode: "new_body",
      },
    ];
    const SOLID = 100 * 40 * 20;
    const splitWith = (connectors: Extract<Feature, { op: "split" }>["connectors"]): Feature[] => [
      ...solid,
      at60,
      { id: "sp1", op: "split", plane: { ref: "pl1" }, bodies: ["ex1"], connectors },
    ];

    it("pins: pegs on the front piece, holes with clearance in the back piece", async () => {
      const r = await run(splitWith({ kind: "pins", size: 5, depth: 8, clearance: 0.2, count: 2 }));
      ok(r);

      const pin = PI * 2.5 ** 2 * 8;
      const hole = PI * 2.7 ** 2 * 8.2;
      expect(vol(r, "ex1")).toBeCloseTo(40 * 40 * 20 + 2 * pin, 1);
      expect(vol(r, "sp1")).toBeCloseTo(60 * 40 * 20 - 2 * hole, 1);
      // The front piece reaches into the back by the pin length.
      expect(r.bodies.find((b) => b.id === "ex1")!.bbox.min[0]).toBeCloseTo(52, 6);
    });

    it("pins sit inside the cut with wall around them, sized from the cut when not given", async () => {
      const s = await newSession();
      const { report } = s.rebuild(doc(splitWith({ kind: "pins" })));
      ok(report);

      // Section 40 × 20: deepest point 10 from the edge, so Ø5 pins, 7.5 long.
      const front = report.bodies.find((b) => b.id === "ex1")!;
      expect(front.volume).toBeCloseTo(40 * 40 * 20 + 2 * PI * 2.5 ** 2 * 7.5, 1);
      expect(front.bbox.min[1]).toBeCloseTo(0, 6);
      expect(front.bbox.max[2]).toBeCloseTo(20, 6);
    });

    it("dowels: holes in both pieces and loose dowels as their own parts", async () => {
      const r = await run(
        splitWith({
          kind: "dowels",
          size: 6,
          depth: 16,
          clearance: 0.25,
          points: [
            [10, 10],
            [30, 10],
          ],
        }),
      );
      ok(r);

      const hole = PI * 3.25 ** 2 * 8.25;
      expect(r.bodies.map((b) => b.id).sort()).toEqual(["ex1", "sp1", "sp1_dowel1", "sp1_dowel2"]);
      expect(vol(r, "ex1")).toBeCloseTo(40 * 40 * 20 - 2 * hole, 1);
      expect(vol(r, "sp1")).toBeCloseTo(60 * 40 * 20 - 2 * hole, 1);
      expect(vol(r, "sp1_dowel1")).toBeCloseTo(PI * 9 * 16, 1);
    });

    it("dovetail: a tongue across the cut, a slot with clearance that slides on it", async () => {
      const r = await run(splitWith({ kind: "dovetail", size: 10, depth: 6, clearance: 0.2 }));
      ok(r);

      const tan = Math.tan((15 * PI) / 180);
      // The cut is 40 long (along y) and 20 high (z): the tongue runs along y, its profile in x–z.
      const tongue = (10 + 6 * tan) * 6 * 40;
      expect(vol(r, "ex1")).toBeCloseTo(40 * 40 * 20 + tongue, 0);
      expect(vol(r, "ex1")! + vol(r, "sp1")!).toBeLessThan(SOLID);
      expect(vol(r, "ex1")! + vol(r, "sp1")!).toBeGreaterThan(SOLID - 0.2 * 2 * (6 + 10) * 40 * 1.2);
      expect(r.bodies.find((b) => b.id === "ex1")!.bbox.min[0]).toBeCloseTo(54, 6);
    });

    it("warns about a pin that would break out, and refuses connectors on a thin wall", async () => {
      const r = await run(
        splitWith({
          kind: "pins",
          size: 5,
          depth: 8,
          points: [
            [2, 10],
            [20, 10],
          ],
        }),
      );
      expect(status(r, "sp1").status).toBe("warning");
      expect(status(r, "sp1").message).toMatch(/pin 1 would come out/);

      const thin = await run([
        sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 100, 2)),
        {
          id: "ex1",
          op: "extrude",
          profile: { sketch: "sk1" },
          extent: "blind",
          distance: 20,
          mode: "new_body",
        },
        at60,
        { id: "sp1", op: "split", plane: { ref: "pl1" }, bodies: ["ex1"], connectors: { kind: "pins" } },
      ]);
      expect(status(thin, "sp1").message).toMatch(/too thin/);
    });
  });
});
