import { describe, expect, it } from "vitest";
import { cylindricalJoints, IDENTITY, isMoved, Mechanism, placeMesh, rotationAbout, transformPoint, translation } from "./motion.js";

describe("cylindrical joints", () => {
  it("turn and slide a part on one axis, each on its own", () => {
    // A sleeve on a shaft along x through (0, 0, 10).
    const joints = cylindricalJoints({ id: "j1", a: "sleeve", b: "ground", origin: [0, 0, 10], axis: [1, 0, 0], travel: [0, 30] });
    const mech = new Mechanism(joints);
    expect(mech.errors).toEqual([]);
    const at = (turn: number, slide: number) => transformPoint(mech.poses(mech.values({ "j1.turn": turn, "j1.slide": slide })).get("sleeve")!, [5, 0, 15]);
    // A point 5 mm above the axis: sliding moves it along x, turning swings it round the axis.
    expect(at(0, 12).map((v) => +v.toFixed(9))).toEqual([17, 0, 15]);
    expect(at(90, 0).map((v) => +v.toFixed(9))).toEqual([5, -5, 10]);
    expect(at(90, 12).map((v) => +v.toFixed(9))).toEqual([17, -5, 10]);
    // The slide keeps to its travel.
    expect(at(0, 50)[0]).toBeCloseTo(35, 9);
  });
});

describe("placeMesh", () => {
  it("moves positions and turns normals, leaving the rest", () => {
    const mesh = { positions: new Float32Array([1, 0, 0, 0, 1, 0]), normals: new Float32Array([1, 0, 0, 0, 1, 0]), id: "x" };
    const m = translation([0, 0, 5]);
    const turned = placeMesh(mesh, rotationAbout([0, 0, 0], [0, 0, 1], 90));
    expect([...turned.positions].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0, -1, 0, 0]);
    expect([...turned.normals].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 0, -1, 0, 0]);
    const lifted = placeMesh(mesh, m);
    expect([...lifted.positions]).toEqual([1, 0, 5, 0, 1, 5]);
    expect([...lifted.normals]).toEqual([1, 0, 0, 0, 1, 0]);
    expect(lifted.id).toBe("x");
    expect(isMoved(IDENTITY)).toBe(false);
    expect(isMoved(m)).toBe(true);
  });
});
