import { describe, expect, it } from "vitest";
import { exportMeshes } from "@meercad/kernel";
import { readStl, writeStl } from "@meercad/io";
import type { Feature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, sketch } from "./helpers.js";

/** A Ø40 × 10 disc: one round face, two flat ones. */
const disc: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, circle("c1", 0, 0, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];

describe("round faces", () => {
  it("export STL triangles within 0.01 mm of the exact circle", async () => {
    const s = await newSession();
    s.rebuild(doc(disc));

    const stl = readStl(writeStl(exportMeshes(await getOcct(), s.state!)));
    let worst = 0;

    for (let i = 0; i < stl.vertices.length; i += 3) {
      const r = Math.hypot(stl.vertices[i]!, stl.vertices[i + 1]!);
      if (r > 1) worst = Math.max(worst, Math.abs(r - 20));
    }

    // Vertices lie on the circle; the chord between two of them sags at most the linear tolerance.
    expect(worst).toBeLessThan(1e-3);

    const segments = new Set<string>();

    for (let i = 0; i < stl.vertices.length; i += 3) {
      if (Math.hypot(stl.vertices[i]!, stl.vertices[i + 1]!) > 1) {
        segments.add(Math.atan2(stl.vertices[i + 1]!, stl.vertices[i]!).toFixed(4));
      }
    }

    const sag = 20 * (1 - Math.cos(Math.PI / segments.size));
    expect(sag).toBeLessThanOrEqual(0.0101);
  });

  it("draws no seam line on a round face", async () => {
    const s = await newSession();
    const { meshes } = s.rebuild(doc(disc));
    const m = meshes[0]!;
    const drawn = new Set<number>();
    for (let i = 2; i < m.edgeRanges.length; i += 3) drawn.add(m.edgeRanges[i]!);
    // Just the two rims: the line where the cylinder closes on itself is not an edge to show.
    expect(drawn.size).toBe(2);
    expect([...drawn].every((e) => m.edgeFaces[e]!.length === 2)).toBe(true);
  });
});
