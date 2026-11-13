import { describe, expect, it } from "vitest";
import * as motion from "./motion.js";
import {
  cylindricalJoints,
  IDENTITY,
  isMoved,
  Mechanism,
  placeMesh,
  rotationAbout,
  transformPoint,
  translation,
} from "./motion.js";

describe("cylindrical joints", () => {
  it("turn and slide a part on one axis, each on its own", () => {
    // A sleeve on a shaft along x through (0, 0, 10).
    const joints = cylindricalJoints({
      id: "j1",
      a: "sleeve",
      b: "ground",
      origin: [0, 0, 10],
      axis: [1, 0, 0],
      travel: [0, 30],
    });
    const mech = new Mechanism(joints);
    expect(mech.errors).toEqual([]);

    const at = (turn: number, slide: number) =>
      transformPoint(
        mech.poses(mech.values({ "j1.turn": turn, "j1.slide": slide })).get("sleeve")!,
        [5, 0, 15],
      );
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
    const mesh = {
      positions: new Float32Array([1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([1, 0, 0, 0, 1, 0]),
      id: "x",
    };
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

describe("motions over time", () => {
  const walk: motion.MotionTrack = {
    duration: 2,
    loop: true,
    keys: [
      { at: 0, values: { hip: 0, knee: 10 } },
      { at: 0.5, values: { hip: 20 } },
      { at: 1, values: { hip: 0, knee: 40 } },
      { at: 1.5, values: { hip: -20 } },
    ],
  };
  it("passes through every moment and interpolates in between", () => {
    expect(motion.sampleMotion(walk, 0.5).hip).toBeCloseTo(20, 9);
    expect(motion.sampleMotion(walk, 1.5).hip).toBeCloseTo(-20, 9);
    expect(motion.sampleMotion(walk, 1).knee).toBeCloseTo(40, 9);

    const h = motion.sampleMotion(walk, 0.25).hip!;
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(20);
  });
  it("loops without a jump: the end runs back into the start", () => {
    expect(motion.sampleMotion(walk, 2).hip).toBeCloseTo(motion.sampleMotion(walk, 0).hip!, 9);
    expect(motion.sampleMotion(walk, 1.999).hip).toBeCloseTo(0, 1);
    expect(motion.sampleMotion(walk, 2.5).hip).toBeCloseTo(20, 9);

    // The knee has two moments: it goes back from 40 to 10 between 1 s and 2 s.
    const k = motion.sampleMotion(walk, 1.5).knee!;
    expect(k).toBeGreaterThan(10);
    expect(k).toBeLessThan(40);
  });
  it("goes straight when not smooth, and holds at the ends of an open run", () => {
    const open: motion.MotionTrack = {
      duration: 2,
      smooth: false,
      keys: [
        { at: 0.5, values: { a: 0 } },
        { at: 1.5, values: { a: 10 } },
      ],
    };
    expect(motion.sampleMotion(open, 1).a).toBeCloseTo(5, 9);
    expect(motion.sampleMotion(open, 0).a).toBe(0);
    expect(motion.sampleMotion(open, 2).a).toBe(10);
  });
  it("samples a loop without its repeated end", () => {
    expect(motion.motionTimes({ duration: 2, loop: true }, 4)).toEqual([0, 0.5, 1, 1.5]);
    expect(motion.motionTimes({ duration: 2 }, 3)).toEqual([0, 1, 2]);
  });
});

describe("rigidGroups", () => {
  it("groups parts held together by fixed joints, the ground's ones together", () => {
    const g = motion.rigidGroups([
      { type: "fixed", a: "screw", b: "servo" },
      { type: "fixed", a: "servo", b: "link" },
      { type: "revolute", a: "link", b: "body" },
      { type: "fixed", a: "body", b: "ground" },
      { type: "fixed", a: "stand", b: "ground" },
      { type: "fixed", a: "gone", b: "link", suppressed: true },
    ]);
    expect(g["screw"]).toBe(g["link"]);
    expect(g["servo"]).toBe(g["link"]);
    expect(g["body"]).toBe(g["stand"]);
    expect(g["link"]).not.toBe(g["body"]);
    expect(g["gone"]).toBeUndefined();
    expect(g["ground"]).toBeUndefined();
  });
});
