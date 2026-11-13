import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import { validateDocument, type Feature, type SketchEntity } from "@meercad/schema";
import { splinePoints, type Vec2 } from "@meercad/sketch";
import { circle, doc, newSession, sketch } from "./helpers.js";

const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const area = (pts: Vec2[]) =>
  Math.abs(
    pts.reduce(
      (a, p, i) => a + p[0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * p[1],
      0,
    ),
  ) / 2;
const points = (ps: Vec2[], prefix = "q"): SketchEntity[] =>
  ps.map(([x, y], i) => ({ id: `${prefix}${i}`, type: "point", x, y }));

async function run(features: Feature[]) {
  const s = await newSession();

  return s.rebuild(doc(features));
}

describe("splines", () => {
  const blob: Vec2[] = [
    [0, 0],
    [30, -5],
    [40, 20],
    [10, 30],
  ];

  it("extrude a closed spline into a smooth part", async () => {
    const { report, meshes } = await run([
      sketch("sk1", { ref: "origin.XY" }, [
        ...points(blob),
        { id: "s1", type: "spline", points: ["q0", "q1", "q2", "q3"], closed: true },
      ]),
      {
        id: "ex1",
        op: "extrude",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: 5,
        mode: "new_body",
      },
    ]);
    ok(report);
    // The smooth curve bulges a hair beyond the samples' chords.
    expect(Math.abs(report.bodies[0]!.volume / (area(splinePoints(blob, true)) * 5) - 1)).toBeLessThan(0.002);

    // One smooth side face, named after the spline.
    const tags = meshes[0]!.faceTags.flat();
    expect(new Set(tags)).toEqual(new Set(["ex1.side[sk1.s1]", "ex1.start_cap", "ex1.end_cap"]));
    expect(tags.some((t) => t.includes("~"))).toBe(false);
  });

  it("joins a spline and a line into one region", async () => {
    const { report, meshes } = await run([
      sketch("sk1", { ref: "origin.XY" }, [
        ...points([
          [0, 0],
          [10, 8],
          [20, 0],
        ]),
        { id: "s1", type: "spline", points: ["q0", "q1", "q2"] },
        { id: "l1", type: "line", p1: "q2", p2: "q0" },
      ]),
      {
        id: "ex1",
        op: "extrude",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: 2,
        mode: "new_body",
      },
    ]);
    ok(report);
    expect(report.bodies[0]!.bbox.max[1]).toBeCloseTo(8, 1);

    const tags = new Set(meshes[0]!.faceTags.flat());
    expect(tags.has("ex1.side[sk1.s1]")).toBe(true);
    expect(tags.has("ex1.side[sk1.l1]")).toBe(true);
  });

  it("sweeps a profile along a spline", async () => {
    // Leaves the profile straight up (the first point's tangent points at the second), then bends.
    const path: Vec2[] = [
      [0, 0],
      [0, 15],
      [15, 30],
      [35, 35],
    ];
    const { report } = await run([
      sketch("sk1", { ref: "origin.XY" }, circle("c", 0, 0, 2)),
      sketch("sk2", { ref: "origin.XZ" }, [
        ...points(path),
        { id: "s1", type: "spline", points: ["q0", "q1", "q2", "q3"] },
      ]),
      { id: "sw1", op: "sweep", profile: { sketch: "sk1" }, path: { sketch: "sk2" }, mode: "new_body" },
    ]);
    ok(report);

    const pts = splinePoints(path);
    const length = pts.slice(1).reduce((l, p, k) => l + Math.hypot(p[0] - pts[k]![0], p[1] - pts[k]![1]), 0);
    expect(report.bodies[0]!.volume / (Math.PI * 4 * length)).toBeCloseTo(1, 2);
  });

  it("checks splines in documents", () => {
    const bad = doc([
      sketch("sk1", { ref: "origin.XY" }, [
        ...points([
          [0, 0],
          [1, 1],
        ]),
        { id: "s1", type: "spline", points: ["q0", "q1"], closed: true },
      ]),
    ]);
    const r = validateDocument(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/closed spline s1 needs at least 3 points/);
  });
});
