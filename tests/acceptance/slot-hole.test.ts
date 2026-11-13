/**
 * A plate with a slot (two half circles joined by two lines) drawn inside its outline: the slot is
 * a hole, bounded by arcs that run clockwise round it. The volume is that of the plate less the slot.
 */
import { describe, expect, it } from "vitest";
import type { SketchEntity } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** A slot from (10, 10) to (20, 10), 6 wide: its ends are half circles of radius 3. */
const slot: SketchEntity[] = [
  { id: "c1", type: "point", x: 10, y: 10 },
  { id: "c2", type: "point", x: 20, y: 10 },
  { id: "a", type: "point", x: 10, y: 7 },
  { id: "b", type: "point", x: 20, y: 7 },
  { id: "c", type: "point", x: 20, y: 13 },
  { id: "d", type: "point", x: 10, y: 13 },
  { id: "low", type: "line", p1: "a", p2: "b" },
  { id: "right", type: "arc", center: "c2", start: "b", end: "c" },
  { id: "high", type: "line", p1: "c", p2: "d" },
  { id: "left", type: "arc", center: "c1", start: "d", end: "a" },
];

describe("a slot drawn inside a plate", () => {
  it("is cut out of the extruded plate", async () => {
    const { report } = (await newSession()).rebuild(
      doc([
        sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 40, 20), ...slot]),
        {
          id: "ex1",
          op: "extrude",
          profile: { sketch: "sk1" },
          extent: "blind",
          distance: 5,
          mode: "new_body",
        },
      ]),
    );
    const status = report.features.find((feature) => feature.id === "ex1")!;

    expect(status.status, status.message ?? "").toBe("ok");

    const plate = 40 * 20;
    const slotArea = 10 * 6 + Math.PI * 3 ** 2;

    expect(report.bodies.find((body) => body.id === "ex1")!.volume).toBeCloseTo((plate - slotArea) * 5, 6);
  });
});
