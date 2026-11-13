/**
 * `reconstruct` on meshes of known parts: each rebuilt model is built by the kernel and must have
 * the mesh's volume; the measured sizes are the drawn ones.
 */
import { describe, expect, it } from "vitest";
import { fitMesh, reconstruct, type Reconstruction } from "@meercad/kernel";
import { newSession } from "./helpers.js";
import { arc, half, prism, turned, turnedAboutX } from "./meshes.js";

async function volumeOf(rb: Reconstruction) {
  const r = (await newSession()).rebuild({
    format: "meercad/1",
    params: rb.params,
    features: rb.features,
    rollback: null,
  }).report;
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);

  return { volume: r.bodies.reduce((v, b) => v + b.volume, 0), bodies: r.bodies };
}

describe("reconstruct shapes", () => {
  it("rebuilds a slot-shaped plate with its arcs", async () => {
    const mesh = prism([...half(40, 6, -Math.PI / 2), ...half(0, 6, Math.PI / 2)], 4);
    const fit = fitMesh(mesh);
    const rb = reconstruct(fit);
    expect(rb.plane).toBe("origin.XY");
    expect(rb.params["h1"]).toBe("4 mm");

    const { volume } = await volumeOf(rb);
    expect(volume / fit.volume).toBeCloseTo(1, 2);
  });

  it("stacks a disc with a groove in layers", async () => {
    const profile: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [8, 5],
      [8, 3],
      [6, 3],
      [6, 5],
      [0, 5],
    ];
    const fit = fitMesh(turned(profile, 96));
    const rb = reconstruct(fit);
    expect(rb.features.filter((f) => f.op === "extrude").length).toBeGreaterThanOrEqual(2);

    const ds = rb.measurements.filter((m) => m.kind === "diameter").map((m) => m.value);
    for (const d of ds) expect([12, 16, 20].some((x) => Math.abs(x - d) < 0.05)).toBe(true);

    const { volume } = await volumeOf(rb);
    expect(volume / fit.volume).toBeCloseTo(1, 2);
  });

  it("stands a plate lying on its side on another plane", async () => {
    // The slot plate turned by 90° about X: its flat faces now face along Y.
    const fit = fitMesh(
      turnedAboutX(prism([...half(40, 6, -Math.PI / 2), ...half(0, 6, Math.PI / 2)], 4), 90),
    );
    const rb = reconstruct(fit);
    expect(rb.plane).toBe("origin.XZ");

    const { volume } = await volumeOf(rb);
    expect(volume / fit.volume).toBeCloseTo(1, 2);
  });

  it("turns a plate tilted by 30° upright and back", async () => {
    const fit = fitMesh(
      turnedAboutX(
        prism(
          [
            [0, 0],
            [30, 0],
            [30, 20],
            [0, 20],
          ],
          5,
        ),
        30,
      ),
    );
    const rb = reconstruct(fit);
    expect(rb.features.some((f) => f.op === "transform")).toBe(true);

    const { volume, bodies } = await volumeOf(rb);
    expect(volume).toBeCloseTo(3000, 0);
    // Back in place: the box of the tilted plate.
    expect(bodies[0]!.bbox.max[2]).toBeCloseTo(20 * Math.sin(Math.PI / 6) + 5 * Math.cos(Math.PI / 6), 2);
  });

  it("refuses a part with no flat face", () => {
    expect(() => reconstruct(fitMesh(turned(arc(0, 10, -Math.PI / 2, Math.PI / 2, 24))))).toThrow(
      /no flat face to build on/,
    );
  });

  it("steps a cone frustum in layers, as many as it is allowed", async () => {
    // Ø20 at the bottom, Ø10 at the top, 10 high: V = πh(R² + Rr + r²)/3.
    const fit = fitMesh(
      turned(
        [
          [0, 0],
          [10, 0],
          [5, 10],
          [0, 10],
        ],
        96,
      ),
    );
    const exact = (Math.PI * 10 * (100 + 50 + 25)) / 3;
    const fine = reconstruct(fit);
    const layers = fine.features.filter((f) => f.op === "extrude").length;
    expect(layers).toBeGreaterThan(3);
    expect(Math.abs((await volumeOf(fine)).volume / exact - 1)).toBeLessThan(0.05);

    const coarse = reconstruct(fit, { maxLayers: 3, prefix: "tw" });
    expect(coarse.features.filter((f) => f.op === "extrude").length).toBe(3);
    expect(coarse.features.every((f) => f.id.startsWith("tw"))).toBe(true);
    expect(Math.abs((await volumeOf(coarse)).volume / exact - 1)).toBeLessThan(0.15);
  });

  it("builds a domed top as a straight layer and says so", async () => {
    const fit = fitMesh(turned([[0, 0], [5, 0], [5, 10], ...arc(10, 5, 0, Math.PI / 2, 12).slice(1)], 64));
    const rb = reconstruct(fit);
    expect(rb.warnings).toContain("the top of the part is not flat; it is built as a straight layer");

    const upside = fitMesh(
      turnedAboutX(turned([[0, 0], [5, 0], [5, 10], ...arc(10, 5, 0, Math.PI / 2, 12).slice(1)], 64), 180),
    );
    expect(reconstruct(upside).warnings).toContain(
      "the bottom of the part is not flat; it is built as a straight layer",
    );
  });
});
