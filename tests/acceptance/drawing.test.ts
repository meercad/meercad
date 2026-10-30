import { describe, expect, it } from "vitest";
import { drawingViews } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

/** 60 × 40 × 20 block with a Ø10 hole through it from the top, at (20, 20). */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 60, 40), ...circle("h", 20, 20, 5)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
];

async function views(names: Parameters<typeof drawingViews>[2]) {
  const s = await newSession();
  s.rebuild(doc(block));
  return drawingViews(await getOcct(), s.state!, names);
}
const size = (v: { min: [number, number]; max: [number, number] }) => [v.max[0] - v.min[0], v.max[1] - v.min[1]].map((n) => Math.round(n * 1000) / 1000);

describe("drawing views", () => {
  it("projects the part: front shows width and height, top width and depth, left depth and height", async () => {
    const [front, top, left] = await views(["front", "top", "left"]);
    expect(size(front!)).toEqual([60, 20]);
    expect(size(top!)).toEqual([60, 40]);
    expect(size(left!)).toEqual([40, 20]);
  });

  it("draws the hole as a circle from the top and as hidden lines from the front", async () => {
    const [front, top] = await views(["front", "top"]);
    // The circle: a curved polyline 10 across around x = 20.
    const round = top!.visible.filter((l) => l.length > 2);
    expect(round.length).toBeGreaterThan(0);
    const xs = round.flat().map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 3);
    // From the front the hole is hidden: two vertical dashed lines at x = 15 and 25, the full height.
    const verticals = front!.hidden.filter((l) => Math.abs(l[0]![0] - l[l.length - 1]![0]) < 1e-6 && Math.abs(l[0]![1] - l[l.length - 1]![1]) > 19);
    expect(verticals.map((l) => Math.round(l[0]![0] * 1000) / 1000).sort((a, b) => a - b)).toEqual([15, 25]);
    expect(front!.visible.length).toBe(4);
  });

  it("cuts the part in half for section A-A: the hole shows as a gap in the cut face", async () => {
    const [sec] = await views(["section"]);
    // Cut at y = 20, through the hole's middle: seen from the front, 60 × 20 like the front view.
    expect(sec!.cutAt).toBeCloseTo(20, 6);
    expect(size(sec!)).toEqual([60, 20]);
    expect(sec!.hidden).toEqual([]);
    // The cut face: the block's 60 × 20 section with the hole's 10 mm gap, i.e. edges at x = 15 and 25.
    const xs = sec!.sections!.flat().flat().map((p) => Math.round(p[0] * 1000) / 1000);
    expect(new Set(xs)).toEqual(new Set([0, 15, 25, 60]));
    // From the front, the hole's walls are now visible lines.
    expect(sec!.visible.some((l) => Math.abs(l[0]![0] - 15) < 1e-6 && Math.abs(l[l.length - 1]![0] - 15) < 1e-6)).toBe(true);
  });

  it("cuts several parts, also overlapping ones, for the section", async () => {
    const s = await newSession();
    s.rebuild(doc([...block, { id: "np1", op: "standard_part", kind: "socket_screw", size: "M8", length: 16, plane: { face: { face: "ex1.end_cap" } }, points: [[20, 20]] }]));
    const [sec] = drawingViews(await getOcct(), s.state!, ["section"]);
    // The block's cut face and the screw's, through its middle.
    expect(sec!.sections!.length).toBeGreaterThanOrEqual(2);
    expect(sec!.visible.length).toBeGreaterThan(4);
  });

  it("finds the hole as a circle seen end-on from above", async () => {
    const [top, front] = await views(["top", "front"]);
    expect(top!.circles).toEqual([{ c: [expect.closeTo(20, 6), expect.closeTo(20, 6)], r: expect.closeTo(5, 6), hole: true }]);
    expect(front!.circles).toEqual([]);
  });

  it("tells holes from bosses", async () => {
    const s = await newSession();
    s.rebuild(doc([...block, { id: "np1", op: "standard_part", kind: "magnet", diameter: 6, height: 3, plane: { face: { face: "ex1.end_cap" } }, points: [[45, 20]] }]));
    const [top] = drawingViews(await getOcct(), s.state!, ["top"]);
    expect(top!.circles!.map((c) => [Math.round(c.r * 100) / 100, c.hole]).sort()).toEqual([[3, false], [5, true]]);
  });

  it("draws an isometric view", async () => {
    const [iso] = await views(["iso"]);
    expect(iso!.visible.length).toBeGreaterThan(9);
    expect(iso!.hidden.length).toBeGreaterThan(0);
  });
});

describe("drawing document", () => {
  it("draws threads as plain holes, quickly", async () => {
    const { drawingDocument } = await import("@meercad/model");
    const threaded = doc([
      ...block,
      { id: "ho1", op: "hole", plane: { face: { face: "ex1.end_cap" } }, points: [[45, 20]], kind: "tapped", size: "M5", depth: 8 },
      { id: "th1", op: "thread", face: { face: "ex1.side[sk1.h]" }, size: "M10" },
    ]);
    const simple = drawingDocument(threaded);
    expect(simple.features.find((f) => f.id === "th1")).toMatchObject({ suppressed: true });
    // M5 tap drill: 5 − 0.8.
    expect(simple.features.find((f) => f.id === "ho1")).toMatchObject({ kind: "simple", diameter: 4.2, depth: 8 });
    const s = await newSession();
    s.rebuild(simple);
    const t = Date.now();
    const [top] = drawingViews(await getOcct(), s.state!, ["top"]);
    expect(Date.now() - t).toBeLessThan(5000);
    // Two round holes from above.
    expect(top!.visible.filter((l) => l.length > 2).length).toBeGreaterThanOrEqual(2);
  });
});
