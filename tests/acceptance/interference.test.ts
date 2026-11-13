import { describe, expect, it } from "vitest";
import { writeStl } from "@meercad/io";
import { clearances, FINE_MESH_FACES, type ClearanceLimits } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const block = (k: number, x: number, w: number): Feature[] => [
  sketch(`sk${k}`, { ref: "origin.XY" }, rect(`r${k}`, x, 0, w, 10)),
  { id: `ex${k}`, op: "extrude", profile: { sketch: `sk${k}` }, extent: "blind", distance: 10, mode: "new_body" },
];

describe("interference of all parts", () => {
  it("finds overlaps and touching parts among every pair", async () => {
    // ex1 0–10, ex2 8–18 (overlaps ex1 by 2 mm), ex3 18–28 (touches ex2), ex4 40–50 (apart).
    const s = await newSession();
    s.rebuild(doc([...block(1, 0, 10), ...block(2, 8, 10), ...block(3, 18, 10), ...block(4, 40, 10)]));
    const pairs = await clearances(await getOcct(), s.state!, ["ex1", "ex2", "ex3", "ex4"], {}, 0);
    const pair = (a: string, b: string) => pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
    expect(pair("ex1", "ex2")!.overlap).toBeCloseTo(2 * 10 * 10, 6);
    expect(pair("ex2", "ex3")!.overlap).toBeLessThan(1e-3);
    expect(pair("ex2", "ex3")!.distance).toBeLessThan(1e-6);
    // Parts far apart are not even compared.
    expect(pair("ex1", "ex4")).toBeUndefined();
    // Parts held together (fixed joints) are left out: they never move against each other.
    const held = await clearances(await getOcct(), s.state!, ["ex1", "ex2", "ex3", "ex4"], {}, 0, [], { ex1: 0, ex2: 0, ex3: 1 });
    expect(held.map((p) => [p.a, p.b])).toEqual([["ex2", "ex3"]]);
  });

  it("leaves out an imported mesh too fine for the kernel, and names it", async () => {
    // A closed ball of 60 × 40 (4,680 triangles, one face each), r = 6 at (5, 5, 5): inside the block ex1.
    const [nu, nv, r] = [60, 40, 6];
    const positions: number[] = [5, 5, 5 + r];
    for (let j = 1; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const v = (Math.PI * j) / nv;
        const u = (2 * Math.PI * i) / nu;
        positions.push(5 + r * Math.sin(v) * Math.cos(u), 5 + r * Math.sin(v) * Math.sin(u), 5 + r * Math.cos(v));
      }
    positions.push(5, 5, 5 - r);
    const south = positions.length / 3 - 1;
    const ring = (i: number, j: number) => 1 + (j - 1) * nu + (i % nu);
    const welded: number[] = [];
    for (let i = 0; i < nu; i++) {
      welded.push(0, ring(i, 1), ring(i + 1, 1), south, ring(i + 1, nv - 1), ring(i, nv - 1));
      for (let j = 1; j < nv - 1; j++) welded.push(ring(i, j), ring(i, j + 1), ring(i + 1, j + 1), ring(i, j), ring(i + 1, j + 1), ring(i + 1, j));
    }
    const stl = writeStl([{ positions: new Float32Array(positions), indices: new Uint32Array(welded) }]);
    const data = Buffer.from(stl).toString("base64");
    const s = await newSession();
    s.rebuild(doc([...block(1, 0, 10), ...block(2, 30, 10), { id: "ball", op: "import", format: "stl", fileName: "ball.stl", data } as Feature]));
    expect(s.state!.bodies.get("ball")!.faces.length).toBeGreaterThan(FINE_MESH_FACES);
    const limits: ClearanceLimits = {};
    const pairs = await clearances(await getOcct(), s.state!, ["ex1", "ex2", "ball"], {}, 0, [], {}, limits);
    // The ball is not measured against the block it sits in (OCCT broke on such a pair), but said.
    expect(pairs.some((p) => p.a === "ball" || p.b === "ball")).toBe(false);
    expect(limits.fine).toEqual(["ball"]);
  });
});
