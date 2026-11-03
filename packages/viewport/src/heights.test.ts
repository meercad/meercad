import { describe, expect, it } from "vitest";
import { heightAt, layeredHeights } from "./index.js";

/** Two triangles covering a square from (0,0) to (s,s) at height z. */
const square = (s: number, z: number) => [0, 0, z, s, 0, z, s, s, z, 0, 0, z, s, s, z, 0, s, z];

describe("terrain height grid", () => {
  it("keeps floor and ceiling apart and answers with the one nearest to the asked height", () => {
    // A 4 m room: floor at 0, ceiling at 2.5 m, a table top at 0.75 m over part of it.
    const table = [1000, 1000, 750, 2000, 1000, 750, 2000, 2000, 750, 1000, 1000, 750, 2000, 2000, 750, 1000, 2000, 750];
    const g = layeredHeights(Float32Array.from([...square(4000, 0), ...square(4000, 2500), ...table]), 256)!;
    expect(heightAt(g, 3000, 3000)).toBeCloseTo(2500, 0);
    expect(heightAt(g, 3000, 3000, 100)).toBeCloseTo(0, 0);
    expect(heightAt(g, 1500, 1500, 100)).toBeCloseTo(0, 0);
    expect(heightAt(g, 1500, 1500, 800)).toBeCloseTo(750, 0);
    expect(heightAt(g, 1500, 1500, 2400)).toBeCloseTo(2500, 0);
    expect(heightAt(g, 9000, 9000)).toBeNull();
  });

  it("follows a slope", () => {
    const g = layeredHeights(Float32Array.from([0, 0, 0, 1000, 0, 100, 1000, 1000, 100, 0, 0, 0, 1000, 1000, 100, 0, 1000, 0]), 128)!;
    expect(heightAt(g, 500, 500)).toBeCloseTo(50, 0);
  });
});
