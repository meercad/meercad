import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature, SketchEntity } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const line = (id: string, a: [number, number], b: [number, number]): SketchEntity[] => [
  { id: `${id}a`, type: "point", x: a[0], y: a[1] },
  { id: `${id}b`, type: "point", x: b[0], y: b[1] },
  { id, type: "line", p1: `${id}a`, p2: `${id}b` },
];
/** L-bracket: 60 × 40 × 5 base, 5 mm wall at x = 0 up to z = 40; a plane across it at y = 20. */
const bracket: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("b", 0, 0, 60, 40)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
  sketch("sk2", { ref: "origin.XY" }, rect("w", 0, 0, 5, 40)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 40, mode: "join" },
  { id: "pl1", op: "plane", base: { ref: "origin.XZ" }, offset: -20 },
];
const BRACKET = 60 * 40 * 5 + 5 * 40 * 35;

async function run(features: Feature[]) {
  const s = await newSession();
  return s.rebuild(doc(features)).report;
}

describe("rib", () => {
  it("fills from a line across the corner to the walls", async () => {
    const r = await run([...bracket, sketch("sk3", { ref: "pl1" }, line("l1", [5, 30], [35, 5])), { id: "rb1", op: "rib", sketch: "sk3", thickness: 4 }]);
    ok(r);
    expect(r.bodies).toHaveLength(1);
    // A triangle with legs 25 (up the wall) and 30 (along the base), 4 thick.
    expect(r.bodies[0]!.volume).toBeCloseTo(BRACKET + 0.5 * 25 * 30 * 4, 2);
  });

  it("reaches the walls from a line that stops short of them", async () => {
    // From (10, 25) to (25, 10): on the same diagonal as x + z = 35, but shorter.
    const r = await run([...bracket, sketch("sk3", { ref: "pl1" }, line("l1", [10, 25], [25, 10])), { id: "rb1", op: "rib", sketch: "sk3", thickness: 4 }]);
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(BRACKET + 0.5 * 25 * 25 * 4, 2);
  });

  it("explains what is wrong", async () => {
    // A flipped rib opens away from the corner, towards nothing.
    const r = await run([...bracket, sketch("sk3", { ref: "pl1" }, line("l1", [5, 30], [35, 5])), { id: "rb1", op: "rib", sketch: "sk3", thickness: 4, flip: true }]);
    expect(status(r, "rb1").message).toMatch(/does not meet a wall/);
  });
});
