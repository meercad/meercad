/** Where a new sketch goes from the click that starts it (sketchPlane.ts). */
import { describe, expect, it } from "vitest";
import type { Pick } from "@meercad/viewport";
import { choosePlane, GROUND } from "./sketchPlane";

const face: Pick = { kind: "face", bodyId: "b", face: 0, tags: [], point: [0, 0, 5], normal: [0, 0, 1] };
const top = { ref: "b.top" } as never;

describe("the plane of a new sketch", () => {
  it("is the flat face or plane clicked", () => {
    expect(choosePlane(face, false, false, () => top)).toEqual({ kind: "plane", spec: top });
  });

  it("is the ground for a click on nothing, or with Option held over a part", () => {
    expect(choosePlane(null, false, false, () => top)).toEqual({ kind: "plane", spec: GROUND });
    expect(choosePlane(face, false, true, () => top)).toEqual({ kind: "plane", spec: GROUND });
  });

  it("is level on the terrain under a click on nothing else, and none on a curved face", () => {
    expect(choosePlane(null, true, false, () => top)).toEqual({ kind: "terrain" });
    expect(choosePlane(face, false, false, () => null)).toEqual({ kind: "not-flat" });
  });
});
