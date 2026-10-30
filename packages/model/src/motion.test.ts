import { describe, expect, it } from "vitest";
import { cylindricalJoints, Mechanism, transformPoint } from "./motion.js";

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
