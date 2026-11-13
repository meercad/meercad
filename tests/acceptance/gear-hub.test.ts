/**
 * Gear hubs on either side, a hex bore, and gear values that cannot be built. Volumes against the
 * tooth outline's own area (model/gear), sizes along the axis exactly.
 */
import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import { GEAR_DEFAULTS, gearShape, outlineArea, type GearParams } from "@meercad/model";
import type { GearFeature } from "@meercad/schema";
import { doc, newSession } from "./helpers.js";

const gear = (g: Partial<GearFeature>): GearFeature => ({
  id: "gr1",
  op: "gear",
  kind: "spur",
  module: 2,
  teeth: 20,
  width: 10,
  mode: "new_body",
  ...g,
});
const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const params = (g: Partial<GearParams> = {}): GearParams => ({
  kind: "spur",
  module: 2,
  teeth: 20,
  herringbone: false,
  ...GEAR_DEFAULTS,
  ...g,
});
const toothArea = outlineArea(gearShape(params()).outer);

async function build(g: Partial<GearFeature>) {
  const { report, meshes } = (await newSession()).rebuild(doc([gear(g)]));

  return { report, body: report.bodies[0], tags: new Set(meshes[0]?.faceTags.flat() ?? []) };
}

describe("gear hubs and bores", () => {
  it.each([
    ["front", 0, 15],
    ["back", -5, 10],
    ["both", -5, 15],
  ] as const)("puts a Ø20 × 5 hub on the %s", async (side, lo, hi) => {
    const { report, body, tags } = await build({
      hub: { diameter: 20, length: 5, side },
      bore: { diameter: 8 },
    });
    ok(report);

    const hubs = side === "both" ? 2 : 1;
    const v = (toothArea - Math.PI * 16) * 10 + hubs * Math.PI * (100 - 16) * 5;
    expect(Math.abs(body!.volume / v - 1)).toBeLessThan(0.005);
    expect(body!.bbox.min[2]).toBeCloseTo(lo, 6);
    expect(body!.bbox.max[2]).toBeCloseTo(hi, 6);
    expect(tags).toContain("gr1.hub");
    expect(tags).toContain("gr1.bore");
  });

  it("puts the hub on the front when no side is given", async () => {
    const { report, body } = await build({ hub: { diameter: 20, length: 5 } });
    ok(report);
    expect(body!.bbox.max[2]).toBeCloseTo(15, 6);
    expect(body!.bbox.min[2]).toBeCloseTo(0, 6);
  });

  it("cuts a hex bore 8 mm across the flats", async () => {
    const { report, body, tags } = await build({ bore: { diameter: 8, shape: "hex" } });
    ok(report);
    // A hexagon s across the flats has the area (√3/2)·s².
    expect(Math.abs(body!.volume / ((toothArea - (Math.sqrt(3) / 2) * 64) * 10) - 1)).toBeLessThan(0.005);
    expect(tags).toContain("gr1.bore");
  });

  it.each([
    ["no module", { module: 0 }, /module must be greater than zero/],
    ["no width", { width: 0 }, /width must be greater than zero/],
    ["a pressure angle of 5°", { pressureAngle: 5 }, /pressure angle must be between 10° and 35°/],
    ["a pressure angle of 40°", { pressureAngle: 40 }, /pressure angle must be between 10° and 35°/],
    ["a helix of 45°", { helix: 45 }, /helix angle must be below 45°/],
    ["negative backlash", { backlash: -0.1 }, /backlash must be between 0 and 2 mm/],
    ["backlash above the module", { backlash: 3 }, /backlash must be between 0 and 2 mm/],
    ["a tip clearance of 2", { clearance: 2 }, /tip clearance factor must be between 0 and 1/],
    ["a hub of no length", { hub: { diameter: 20, length: 0 } }, /hub's length must be greater than zero/],
    [
      "a hub bigger than the root circle",
      { hub: { diameter: 40, length: 5 } },
      /hub must be smaller than the root circle \(35\.00 mm\)/,
    ],
    [
      "a D bore with the flat outside it",
      { bore: { diameter: 8, shape: "d_flat", flat: 9 } },
      /flat must be between half the bore and the bore diameter/,
    ],
    ["a tooth chamfer on a rack", { kind: "rack", chamfer: 0.5 }, /racks have no tooth chamfer yet/],
    [
      "a tooth chamfer above the module",
      { chamfer: 2.5 },
      /tooth chamfer must be at most the module \(2 mm\)/,
    ],
    [
      "a tooth chamfer of half the width",
      { width: 3, chamfer: 1.5 },
      /tooth chamfer must be less than half the width/,
    ],
  ] as [string, Partial<GearFeature>, RegExp][])("refuses %s", async (_n, g, msg) => {
    const { report } = await build(g);
    const st = report.features.find((f) => f.id === "gr1")!;
    expect(st.status).toBe("error");
    expect(st.message).toMatch(msg);
  });
});
