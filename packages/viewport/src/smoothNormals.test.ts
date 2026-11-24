/**
 * Smooth shading of loose triangles (smoothNormals.ts): triangles meeting at a shallow angle share
 * the mean direction at their common corners, a sharp edge stays sharp, and triangles without area
 * change nothing.
 */
import { describe, expect, it } from "vitest";
import { smoothNormals } from "./smoothNormals.js";

/** Two triangles sharing the edge from the origin along y; the second is turned up by `degrees`. */
function roof(degrees: number): { positions: Float32Array; flat: Float32Array } {
  const angle = (degrees * Math.PI) / 180;
  const far = [Math.cos(angle), 0, Math.sin(angle)];
  const tilted = [-Math.sin(angle), 0, Math.cos(angle)];

  return {
    positions: Float32Array.from([0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, ...far, 0, 1, 0]),
    flat: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, ...tilted, ...tilted, ...tilted]),
  };
}

describe("smooth normals", () => {
  it("average the triangles at a shared corner when they meet at a shallow angle", () => {
    const { positions, flat } = roof(20);
    const smooth = smoothNormals(positions, flat);
    const mean = [-Math.sin(Math.PI / 18), 0, Math.cos(Math.PI / 18)];

    // The shared corners (the origin and the end of the edge) of both triangles.
    for (const corner of [0, 3, 9, 15]) {
      mean.forEach((value, axis) => expect(smooth[corner + axis]).toBeCloseTo(value, 5));
    }

    // The corner only one triangle has keeps that triangle's direction.
    expect(Array.from(smooth.subarray(6, 9))).toEqual([0, 0, 1]);
  });

  it("leave a sharp edge sharp, and follow the crease angle asked for", () => {
    const { positions, flat } = roof(90);

    expect(Array.from(smoothNormals(positions, flat))).toEqual(Array.from(flat));
    expect(smoothNormals(positions, flat, undefined, 60)[0]).toBeCloseTo(-Math.SQRT1_2, 5);
  });

  it("work on corners shared through indices, and leave unused corners alone", () => {
    const { positions, flat } = roof(20);
    // The same two triangles, with a seventh corner nothing uses.
    const more = Float32Array.from([...positions, 9, 9, 9]);
    const moreFlat = Float32Array.from([...flat, 1, 0, 0]);
    const smooth = smoothNormals(more, moreFlat, [0, 1, 2, 3, 4, 5]);

    expect(Array.from(smooth.subarray(0, 18))).toEqual(Array.from(smoothNormals(positions, flat)));
    expect(Array.from(smooth.subarray(18))).toEqual([1, 0, 0]);
  });

  it("keep the flat direction where triangles cancel each other out", () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0]);
    const flat = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);

    expect(Array.from(smoothNormals(positions, flat))).toEqual(Array.from(flat));
  });
});
