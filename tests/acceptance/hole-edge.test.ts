import { describe, expect, it } from "vitest";
import type { Feature, HoleFeature } from "@meercad/schema";
import { frameFromPlane, toSketch } from "@meercad/sketch";
import { edgeInset, holeBesideEdge } from "../../apps/web/src/lib/holes";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** 40 × 30 × 10 block, top face at z = 10. */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 30)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
const hole = (h: Partial<HoleFeature>): HoleFeature => ({
  id: "ho1",
  op: "hole",
  plane: { face: { face: "ex1.end_cap" } },
  points: [[20, 15]],
  kind: "insert",
  size: "M3",
  ...h,
});

describe("holes beside a tapped edge", () => {
  it("go in by the wall the hole needs", () => {
    // M3 insert: Ø4 hole and 1.6 mm wall.
    expect(edgeInset(hole({}))).toBeCloseTo(3.6, 6);
    // M3 clearance Ø3.4: centre 1½ diameters from the edge.
    expect(edgeInset(hole({ kind: "clearance" }))).toBeCloseTo(1.7 + 3.4, 6);
    // Counterbore Ø6: its rim, then the hole's diameter of wall.
    expect(edgeInset(hole({ kind: "counterbore" }))).toBeCloseTo(3 + 3.4, 6);
    expect(edgeInset(hole({ size: "M7" }))).toBeUndefined();
  });

  it("land on the face next to the edge, at the point nearest the tap, and build without a warning", async () => {
    const s = await newSession();
    const { meshes } = s.rebuild(doc(block));
    const m = meshes[0]!;
    // The top's edge along y = 0 (between the top and the front side).
    const top = m.faceTags.findIndex((t) => t.includes("ex1.end_cap"));
    let edge = -1;

    for (let g = 0; g < m.edgeRanges.length; g += 3) {
      const e = m.edgeRanges[g + 2]!;
      const st = m.edgeRanges[g]!,
        n = m.edgeRanges[g + 1]!;
      const ys = Array.from({ length: n }, (_, k) => m.edgeLines[(st + k) * 3 + 1]!);
      const zs = Array.from({ length: n }, (_, k) => m.edgeLines[(st + k) * 3 + 2]!);

      if (
        m.edgeFaces[e]?.includes(top) &&
        ys.every((y) => Math.abs(y) < 1e-6) &&
        zs.every((z) => Math.abs(z - 10) < 1e-6)
      ) {
        edge = e;
      }
    }

    expect(edge).toBeGreaterThanOrEqual(0);

    const f = hole({});
    const at = holeBesideEdge(m, edge, [12, -0.3, 10.2], edgeInset(f)!, "ex1.end_cap")!;
    expect(at.normal[2]).toBeCloseTo(1, 6);
    expect(at.point[0]).toBeCloseTo(12, 4);
    expect(at.point[1]).toBeCloseTo(3.6, 4);
    expect(at.point[2]).toBeCloseTo(10, 4);

    // Without the face's tag it still finds a flat face: the top or the front, both 3.6 mm in.
    const any = holeBesideEdge(m, edge, [12, 0, 10], 3.6)!;
    expect(Math.abs(any.point[1]) + Math.abs(any.point[2] - 10)).toBeCloseTo(3.6, 4);

    // The point in the plane's own coordinates, as the dialog stores it: the wall is just enough.
    const [u, v] = toSketch(frameFromPlane(at.point, at.normal), at.point);
    const { report } = s.rebuild(doc([...block, hole({ points: [[u, v]] })]));
    expect(report.features.find((x) => x.id === "ho1")).toMatchObject({ status: "ok" });
  });
});
