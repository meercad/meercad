import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature, TextFeature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
/** 80 × 30 × 5 plate, top at z = 5. */
const plate: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 80, 30)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
];
const PLATE = 80 * 30 * 5;
const text = (t: Partial<TextFeature>): TextFeature => ({
  id: "tx1",
  op: "text",
  plane: { face: { face: "ex1.end_cap" } },
  text: "MEER",
  position: [10, 10],
  size: 10,
  depth: 1,
  mode: "join",
  ...t,
});

async function run(features: Feature[]) {
  const s = await newSession();

  return s.rebuild(doc(features));
}

describe("text", () => {
  it("draws capitals exactly as high as the size, from the position", async () => {
    const { report } = await run([...plate, text({ text: "HI", mode: "new_body", depth: 2 })]);
    ok(report);

    const bb = report.bodies.find((b) => b.id === "tx1")!.bbox;
    expect(bb.min[1]).toBeCloseTo(10, 1);
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(10, 1);
    expect(bb.min[2]).toBeCloseTo(5, 6);
    expect(bb.max[2]).toBeCloseTo(7, 6);
    expect(bb.min[0]).toBeGreaterThan(10);
    expect(bb.min[0]).toBeLessThan(12);
  });

  it("raises and engraves text on a face, letters with holes stay open", async () => {
    const raised = await run([...plate, text({ text: "OBA" })]);
    ok(raised.report);

    const up = raised.report.bodies[0]!.volume - PLATE;
    const cut = await run([...plate, text({ text: "OBA", mode: "cut" })]);
    ok(cut.report);

    const down = PLATE - cut.report.bodies[0]!.volume;
    // The same letters: as much material added as taken away.
    expect(down).toBeCloseTo(up, 1);
    // Far less than the letters' boxes (the counters of O, B and A are open).
    expect(up).toBeGreaterThan(20);
    expect(up).toBeLessThan(3 * 7 * 10 * 1 * 0.6);
    expect(cut.meshes[0]!.faceTags.flat()).toContain("tx1.top");
  });

  it("centres, rotates and breaks lines", async () => {
    const { report } = await run([
      ...plate,
      text({ text: "AB\nCD", align: "center", position: [40, 20], angle: 90, mode: "new_body" }),
    ]);
    ok(report);

    const bb = report.bodies.find((b) => b.id === "tx1")!.bbox;
    // Turned a quarter: the lines now run along y, centred on y = 20, the second line further in +x.
    expect((bb.min[1] + bb.max[1]) / 2).toBeCloseTo(20, 0);
    expect(bb.max[0]).toBeGreaterThan(40 + 10);
  });

  it("leaves the face usable for later steps", async () => {
    // Raised "OD" splits the top into pieces (the counters); a later step on that face still works.
    const { report } = await run([
      ...plate,
      text({ text: "OD" }),
      {
        id: "ho1",
        op: "hole",
        plane: { face: { face: "ex1.end_cap" } },
        points: [[70, 15]],
        kind: "simple",
        diameter: 4,
      },
    ]);
    ok(report);
  });

  it("warns about characters the font lacks and explains errors", async () => {
    const { report } = await run([...plate, text({ text: "A☃" })]);
    expect(status(report, "tx1").message).toMatch(/font has no "☃"/);

    const bad = await run([...plate, text({ size: 0 })]);
    expect(status(bad.report, "tx1").message).toMatch(/size must be greater than zero/);
  });
});
