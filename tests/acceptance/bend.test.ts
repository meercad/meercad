import { describe, expect, it } from "vitest";
import { exportMeshes, type RebuildReport } from "@meercad/kernel";
import { writeStl } from "@meercad/io";
import { weldClosed } from "@meercad/model";
import type { Feature } from "@meercad/schema";
import { doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);

const size = (r: RebuildReport, i = 0) => {
  const b = r.bodies[i]!.bbox;

  return [0, 1, 2].map((k) => b.max[k]! - b.min[k]!);
};

/** A strip lying flat on XY: `len` along X, `w` along Y, `t` thick. */
const strip = (len: number, w: number, t: number): Feature[] => [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, len, w)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: t, mode: "new_body" },
];

async function build(features: Feature[]) {
  const s = await newSession();
  const out = s.rebuild(doc(features));

  return { ...out, session: s };
}

/** Every triangle edge of the exported mesh has exactly two triangles (closed, manifold). */
async function watertight(s: Awaited<ReturnType<typeof newSession>>) {
  const [m] = exportMeshes(await getOcct(), s.state!);
  const corners = new Float32Array(m!.indices.length * 3);

  for (let i = 0; i < m!.indices.length; i++) {
    corners.set(m!.positions.subarray(m!.indices[i]! * 3, m!.indices[i]! * 3 + 3), i * 3);
  }

  expect(() => weldClosed(corners, 1e-4)).not.toThrow();
}

describe("bend", () => {
  it("rolls a 1 m strip into a flat spiral that fits a print bed", async () => {
    const t0 = performance.now();
    const { report, session } = await build([
      ...strip(1000, 20, 3),
      {
        id: "bd1",
        op: "bend",
        bodies: ["ex1"],
        mode: "spiral",
        axis: { ref: "origin.Z" },
        radius: 20,
        gap: 1,
      },
    ]);
    ok(report);

    const ms = performance.now() - t0;
    const [dx, dy, dz] = size(report);
    // Lies flat: still 3 mm high, about 2 × (20 + 2.7 turns × 21 mm + 20) across.
    expect(dz).toBeCloseTo(3, 3);
    expect(Math.max(dx!, dy!)).toBeLessThan(200);
    expect(Math.max(dx!, dy!)).toBeGreaterThan(170);
    // Bending about the middle keeps the volume.
    expect(report.bodies[0]!.volume / 60000).toBeCloseTo(1, 2);
    expect(report.bodies[0]!.id).toBe("ex1");
    await watertight(session);
    expect(ms).toBeLessThan(30000);
  });

  it("wraps a strip with raised text into a closed bracelet", async () => {
    const len = 2 * Math.PI * 30;
    const { report, session } = await build([
      ...strip(len, 12, 2),
      {
        id: "tx1",
        op: "text",
        plane: { face: { face: "ex1.end_cap" } },
        text: "MEER",
        position: [20, 3],
        size: 6,
        depth: 0.8,
        mode: "join",
      },
      { id: "bd1", op: "bend", bodies: ["ex1"], mode: "wrap", axis: { ref: "origin.Y" }, radius: 30 },
    ]);
    ok(report);
    expect(status(report, "bd1").info?.["closed"]).toBe(1);

    const [dx, dy, dz] = size(report);
    // A ring round Y: inner radius 30, 2 mm wall plus the letters; 12 mm wide.
    expect(dy).toBeCloseTo(12, 3);
    expect(dx).toBeGreaterThan(2 * 32 - 0.1);
    expect(dx).toBeLessThan(2 * 32.8 + 0.1);
    expect(dz).toBeGreaterThan(2 * 32 - 0.1);
    await watertight(session);
  });

  it("bends an imported mesh part, which keeps its id", async () => {
    // 60 × 8 × 2 box as an STL file.
    const p = [0, 0, 0, 60, 0, 0, 60, 8, 0, 0, 8, 0, 0, 0, 2, 60, 0, 2, 60, 8, 2, 0, 8, 2];
    const idx = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4,
      7,
    ];
    const bytes = writeStl([{ positions: Float32Array.from(p), indices: Uint32Array.from(idx) }]);
    const data = btoa(String.fromCharCode(...bytes));
    const { report } = await build([
      { id: "im1", op: "import", format: "stl", fileName: "bar.stl", data },
      { id: "bd1", op: "bend", bodies: ["im1"], mode: "bend", axis: { ref: "origin.Y" }, angle: 90 },
    ]);
    ok(report);
    expect(report.bodies.map((b) => b.id)).toEqual(["im1"]);
    expect(report.bodies[0]!.volume).toBeCloseTo(960, -1);
    expect(size(report)[2]).toBeGreaterThan(10);
  });

  it("bends by an angle", async () => {
    const { report } = await build([
      ...strip(100, 10, 2),
      { id: "bd1", op: "bend", bodies: ["ex1"], mode: "bend", axis: { ref: "origin.Y" }, angle: 180 },
    ]);
    ok(report);

    const R = 100 / Math.PI;
    const [dx, , dz] = size(report);
    // A half ring: across it the outer diameter, up it the outer radius.
    expect(dx).toBeCloseTo(2 * (R + 1), 1);
    expect(dz).toBeCloseTo(R + 1, 1);
    expect(report.bodies[0]!.volume).toBeCloseTo(2000, -1);
  });

  it("explains what is wrong", async () => {
    const r1 = (
      await build([
        ...strip(1000, 20, 3),
        {
          id: "bd1",
          op: "bend",
          bodies: ["ex1"],
          mode: "spiral",
          axis: { ref: "origin.Z" },
          radius: 20,
          gap: 0,
        },
      ])
    ).report;
    expect(status(r1, "bd1").message).toMatch(/turns would touch/);

    const r2 = (
      await build([
        ...strip(1000, 20, 3),
        { id: "bd1", op: "bend", bodies: ["ex1"], mode: "wrap", axis: { ref: "origin.Y" }, radius: 50 },
      ])
    ).report;
    expect(status(r2, "bd1").message).toMatch(/overlap itself/);

    const r3 = (
      await build([
        ...strip(1000, 20, 3),
        {
          id: "bd1",
          op: "bend",
          bodies: ["ex1"],
          mode: "spiral",
          axis: { ref: "origin.Z" },
          radius: 20,
          gap: 0.1,
        },
      ])
    ).report;
    expect(status(r3, "bd1").message).toMatch(/may fuse/);
  });
});
