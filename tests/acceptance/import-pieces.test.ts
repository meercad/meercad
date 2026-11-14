/** STL files of several closed pieces: a part with a hollow inside, and parts side by side. */
import { describe, expect, it } from "vitest";
import { writeStl } from "@meercad/io";
import { meshPieces } from "@meercad/kernel";
import { doc, newSession } from "./helpers.js";
import { insideOut, prism, type P } from "./meshes.js";

const square = (x0: number, y0: number, s: number): P[] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
const lifted = (m: Float64Array, dz: number) => m.map((v, i) => (i % 3 === 2 ? v + dz : v));
const stl = (...parts: Float64Array[]) => {
  const corners = Float32Array.from(parts.flatMap((p) => [...p]));
  return writeStl([{ positions: corners, indices: Uint32Array.from(corners.keys()).subarray(0, corners.length / 3) }]);
};

async function imported(bytes: Uint8Array) {
  const s = await newSession();
  return s.rebuild(doc([{ id: "im1", op: "import", format: "stl", fileName: "p.stl", data: Buffer.from(bytes).toString("base64") }])).report;
}

describe("STL of several closed pieces", () => {
  it("finds the pieces, a hollow by its inward winding", () => {
    const outer = prism(square(0, 0, 20), 20);
    const hollow = insideOut(lifted(prism(square(5, 5, 10), 10), 5));
    const all = Float32Array.from([...outer, ...hollow]);
    const pieces = meshPieces(all, Uint32Array.from({ length: all.length / 3 }, (_, i) => i));
    expect(pieces.map((p) => Math.round(p.volume)).sort((a, b) => a - b)).toEqual([-1000, 8000]);
  });

  it("a block with a hollow inside comes in as one part without the hollow", async () => {
    const r = await imported(stl(prism(square(0, 0, 20), 20), insideOut(lifted(prism(square(5, 5, 10), 10), 5))));
    expect(r.features[0]!.status).toBe("ok");
    expect(r.bodies[0]!.volume).toBeCloseTo(8000 - 1000, 3);
  });

  it("two blocks side by side come in as one part of both", async () => {
    const r = await imported(stl(prism(square(0, 0, 10), 10), prism(square(30, 0, 10), 10)));
    expect(r.features[0]!.status).toBe("ok");
    expect(r.bodies[0]!.volume).toBeCloseTo(2000, 3);
  });
});
