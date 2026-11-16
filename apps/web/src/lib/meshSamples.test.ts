/** Sample points across a part's surface. */
import { describe, expect, it } from "vitest";
import type { BodyMesh } from "@meercad/kernel";
import { refine } from "./meshSamples";

const mesh = (positions: number[], indices: number[]) =>
  ({ positions: new Float32Array(positions), indices: new Uint32Array(indices) }) as unknown as BodyMesh;

/** Area of the corner list's triangles. */
function area(corners: Float32Array): number {
  let sum = 0;

  for (let i = 0; i < corners.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = corners.slice(i, i + 9) as unknown as number[];
    const [ux, uy, uz, vx, vy, vz] = [bx! - ax!, by! - ay!, bz! - az!, cx! - ax!, cy! - ay!, cz! - az!];

    sum += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }

  return sum;
}

/** A 100 × 100 square in two triangles, with each triangle's longest edge in another place. */
const square = mesh([0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0], [0, 1, 2, 2, 3, 0, 1, 2, 0]);

describe("refine", () => {
  it("splits long triangles into small ones covering the same area", () => {
    const corners = refine(square);

    expect(corners.length % 9).toBe(0);
    expect(corners.length / 9).toBeGreaterThan(1000);
    expect(area(corners)).toBeCloseTo(15_000, 0);
  });

  it("stays within the budget", () => {
    const corners = refine(square, 50);

    expect(corners.length / 9).toBeLessThanOrEqual(50);
    expect(area(corners)).toBeCloseTo(15_000, 0);
  });

  it("stops splitting a sliver after a few levels", () => {
    const sliver = mesh([0, 0, 0, 1000, 0, 0, 0, 0.001, 0, 0, 1000, 0], [0, 1, 2, 0, 2, 3]);

    expect(refine(sliver).length).toBeGreaterThan(9);
  });

  it("keeps a mesh of a point as it is", () => {
    expect(Array.from(refine(mesh([1, 1, 1], [0, 0, 0])))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
});
