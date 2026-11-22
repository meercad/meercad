/**
 * From a part's triangles to the answer (job.ts): a beam held at one end is safe by the factor the
 * textbook gives, its worst spot lies at the hold, and printing it with the layers across the beam
 * makes it weaker; the lighter suggestion keeps the faces it is held and pushed at, weighs about the
 * wanted share and is checked too; jobs without a hold or a load are refused.
 */
import { describe, expect, it } from "vitest";
import {
  answerStrength,
  checkStrength,
  strengthColors,
  STRENGTH_SCALE,
  StrengthError,
  suggestTopology,
  type StrengthJob,
} from "./job.js";
import { STRENGTHS } from "./strength.js";
import { boxMesh } from "./testParts.js";

const mesh = boxMesh([32, 4, 8]);
const face = (index: number) => mesh.indices.subarray(index * 6, index * 6 + 6);
const beam: StrengthJob = {
  ...mesh,
  holds: face(0),
  loads: [{ triangles: face(1), force: [0, 0, -20] }],
  material: STRENGTHS.pla!,
  up: [0, 1, 0],
  cells: 32 * 4 * 8,
};

describe("the strength check of a beam", () => {
  const report = checkStrength(beam);

  it("finds about the bending stress of the textbook, worst near the hold", () => {
    // σ = M / W with W = b·h² / 6, a cube away from the hold (the cubes at it are left out).
    const sigma = (20 * 30) / ((4 * 8 ** 2) / 6);

    expect(report.converged).toBe(true);
    expect(50 / report.safety / sigma).toBeGreaterThan(0.6);
    expect(50 / report.safety / sigma).toBeLessThan(1.2);
    expect(report.worstAt![0]).toBeLessThan(4);
    expect(report.deflection).toBeGreaterThan(0.2);
    expect(report.deflection).toBeLessThan(0.5);
  });

  it("is weaker with the layers stacked along the beam", () => {
    expect(checkStrength({ ...beam, up: [1, 0, 0] }).safety).toBeLessThan(report.safety * 0.75);
  });

  it("colours the surface: red at the hold's edge, green at the free end and off the part", () => {
    const peak = { grid: report.grid, used: report.used.map((used) => used * report.safety) };
    const colors = strengthColors(peak, [report.worstAt![0], 2, report.worstAt![2], 31.5, 2, 4, 99, 99, 99]);

    expect(colors[0]).toBeGreaterThan(0.5);
    expect(colors[1]).toBeLessThan(0.2);
    expect(colors[4]).toBeGreaterThan(colors[3]!);
    expect(Array.from(colors.subarray(6, 9))).toEqual(
      Array.from(colors.subarray(3, 6)).map((_, c) => colors[6 + c]),
    );
    expect(colors[7]).toBeGreaterThan(colors[6]!);
    expect(STRENGTH_SCALE).toEqual(["rgb(77,184,115)", "rgb(242,199,64)", "rgb(219,56,51)"]);
  });

  it("has no worst spot without stress", () => {
    const idle = checkStrength({ ...beam, loads: [{ triangles: face(1), force: [0, 0, 0] }] });

    expect(idle).toMatchObject({ safety: Infinity, worstAt: null, deflection: 0 });
  });
});

describe("jobs that cannot be calculated", () => {
  const reason = (job: StrengthJob) => {
    try {
      checkStrength(job);
    } catch (error) {
      return (error as StrengthError).reason;
    }
  };

  it("need a hold and a load on the part", () => {
    expect(reason({ ...beam, holds: [] })).toBe("hold");
    expect(reason({ ...beam, loads: [] })).toBe("load");
    expect(reason({ ...beam, loads: [{ triangles: [], force: [0, 0, 1] }] })).toBe("load");
    expect(new StrengthError("hold")).toBeInstanceOf(Error);
  });
});

describe("the lighter suggestion", () => {
  const steps: number[] = [];
  const suggestion = suggestTopology({
    ...beam,
    share: 0.5,
    steps: 12,
    onStep: (step) => void steps.push(step),
  });

  it("weighs about the wanted share and tells its progress", () => {
    expect(suggestion.share).toBeGreaterThan(0.35);
    expect(suggestion.share).toBeLessThan(0.65);
    expect(steps.length).toBeGreaterThan(3);
  });

  it("keeps the faces it is held and pushed at, and is a closed part", () => {
    const xs = suggestion.mesh.positions.filter((_, i) => i % 3 === 0);
    const corners = (x: number) => xs.filter((value) => value === x).length;

    // All 5 × 9 corners of both end faces are where they were.
    expect(corners(0)).toBe(45);
    expect(corners(32)).toBe(45);
    expect(suggestion.mesh.indices.length % 3).toBe(0);
  });

  it("is checked like the part: it still holds, with less to spare", () => {
    expect(suggestion.after.converged).toBe(true);
    expect(suggestion.after.safety).toBeGreaterThan(0.15 * suggestion.before.safety);
    expect(suggestion.after.safety).toBeLessThan(1.05 * suggestion.before.safety);
    expect(suggestion.after.deflection).toBeGreaterThan(suggestion.before.deflection);
  });
});

describe("requests", () => {
  it("are answered with the report, the suggestion and its progress, or the reason why not", () => {
    const progress: number[] = [];

    expect(answerStrength({ kind: "check", job: beam }, () => undefined)).toMatchObject({
      kind: "check",
      report: { converged: true },
    });
    expect(
      answerStrength({ kind: "topology", job: { ...beam, share: 0.5, steps: 2 } }, (share) =>
        progress.push(share),
      ),
    ).toMatchObject({ kind: "topology" });
    expect(progress).toEqual([0.5, 1]);
    expect(answerStrength({ kind: "check", job: { ...beam, holds: [] } }, () => undefined)).toEqual({
      kind: "error",
      reason: "hold",
    });
    expect(
      answerStrength({ kind: "check", job: { ...beam, material: null as never } }, () => undefined),
    ).toEqual({ kind: "error", reason: "failed" });
  });
});
