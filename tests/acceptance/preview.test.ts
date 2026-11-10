import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const design = (h: number, w = 10): Feature[] => [
  sketch("sk1", { ref: "origin.XY" }, rect("r1", 0, 0, 10, 10)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("sk2", { ref: "origin.XY" }, rect("r2", 20, 0, w, 10)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: h, mode: "new_body" },
];

describe("previews next to the open design", () => {
  it("builds only from the first change and leaves the open design as it was", async () => {
    const s = await newSession();
    const open = doc(design(10));
    const before = s.rebuild(open);
    const p = s.preview(doc(design(30)));
    expect(p.report.firstRecomputed).toBe(3);
    expect(p.report.bodies.find((b) => b.id === "ex2")!.volume).toBeCloseTo(10 * 10 * 30, 3);
    // The unchanged part is the open design's mesh, not built again.
    expect(p.meshes.find((m) => m.bodyId === "ex1")).toBe(before.meshes.find((m) => m.bodyId === "ex1"));
    // The open design is still whole: its state stays and the next rebuild comes from the cache.
    expect(s.state!.bodies.has("ex2")).toBe(true);
    const again = s.rebuild(open);
    expect(again.report.firstRecomputed).toBe(-1);
    expect(again.report.bodies.find((b) => b.id === "ex2")!.volume).toBeCloseTo(10 * 10 * 10, 3);
    // And a preview of something else entirely works too (thumbnails of other projects).
    expect(s.preview(doc(design(5, 4))).report.bodies.find((b) => b.id === "ex2")!.volume).toBeCloseTo(4 * 10 * 5, 3);
    expect(s.rebuild(open).report.firstRecomputed).toBe(-1);
  });
});
