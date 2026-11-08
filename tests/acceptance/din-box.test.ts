import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clearances } from "@meercad/kernel";
import { resolveParams } from "@meercad/model";
import type { Feature, MeercadDocument } from "@meercad/schema";
import { getOcct, newSession, rect, sketch } from "./helpers.js";

/**
 * The stackable box in the examples is sized by DIN A: its inside takes paper of that size with
 * play, and two boxes of the next smaller size stand exactly on one (outside, rim bead included).
 */
const box = (): MeercadDocument =>
  JSON.parse(readFileSync(new URL("../../apps/web/src/examples/40-stackable-ribbed-box.meercad", import.meta.url), "utf8")) as MeercadDocument;

/** Paper as cut, long × short in mm (DIN EN ISO 216). */
const PAPER: Record<number, [number, number]> = { 3: [420, 297], 4: [297, 210], 5: [210, 148], 6: [148, 105], 7: [105, 74] };

const sizes = (din: number, extra: Record<string, string> = {}) => {
  const { values, errors } = resolveParams({ ...box().params, din: String(din), ...extra });
  expect([...errors]).toEqual([]);
  const v = (n: string) => values.get(n)!;
  return {
    outside: [v("width") + 2 * v("band"), v("depth") + 2 * v("band")] as const,
    inside: [v("width") - 2 * v("wall"), v("depth") - 2 * v("wall")] as const,
    // A sheet's corner meets the rounded inner corner before its edges meet the walls.
    cornerGap: (v("corner") - v("wall")) * (1 - Math.SQRT1_2),
    play: v("play"),
  };
};

describe("DIN A storage box", () => {
  for (const smallest of [6, 7]) {
    it(`two boxes of the next size fit exactly on one (smallest A${smallest})`, () => {
      for (let din = 3; din < smallest; din++) {
        const big = sizes(din, { smallest: String(smallest) });
        const small = sizes(din + 1, { smallest: String(smallest) });
        // Side by side across their short side they make the big one's outline.
        expect(small.outside[0]).toBeCloseTo(big.outside[1], 6);
        expect(2 * small.outside[1]).toBeCloseTo(big.outside[0], 6);
      }
    });

    it(`A${smallest}…A3 paper lies inside with at least the play all round`, () => {
      for (let din = 3; din <= smallest; din++) {
        const s = sizes(din, { smallest: String(smallest) });
        const [l, w] = PAPER[din]!;
        for (const gap of [(s.inside[0] - l) / 2, (s.inside[1] - w) / 2]) expect(gap - s.cornerGap).toBeGreaterThanOrEqual(s.play - 1e-9);
      }
    });
  }

  it("the smallest size is the snug one; the play there is what was set", () => {
    const s = sizes(6);
    expect((s.inside[1] - 105.11) / 2 - s.cornerGap).toBeCloseTo(s.play, 1);
    expect((s.inside[0] - 148.65) / 2 - s.cornerGap).toBeCloseTo(s.play, 1);
  });

  it("an A5 sheet on the floor clears the walls and the rounded corners", async () => {
    const d = box();
    const floor = 5 + 2.4 + 0.5; // foot + floor + a little
    const sheet: Feature[] = [
      { id: "pl9", op: "plane", base: { ref: "origin.XY" }, offset: floor } as Feature,
      sketch("sk99", { ref: "pl9" }, rect("q", -105, -74, 210, 148)),
      { id: "ex99", op: "extrude", name: "A5 sheet", profile: { sketch: "sk99" }, extent: "blind", distance: 0.5, mode: "new_body" },
    ];
    const s = await newSession();
    s.rebuild({ ...d, features: [...d.features, ...sheet] });
    const pairs = await clearances(await getOcct(), s.state!, ["ex1", "ex99"], {}, 20);
    const pair = pairs.find((p) => [p.a, p.b].includes("ex99"))!;
    expect(pair.overlap).toBeLessThan(1e-3);
    expect(pair.distance).toBeGreaterThan(0.9);
  });
});
