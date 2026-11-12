/**
 * Joints and couplings by the numbers: a gear train's ratios and its limits passed on to the
 * driver, wrong set-ups reported, and the geometry helpers a drag uses.
 */
import { describe, expect, it } from "vitest";
import { angleAbout, Mechanism, rayLineParam, rayPlane, sampleMotion, transformPoint, type MotionJoint } from "./motion.js";

const turn = (id: string, a: string, b: string, limits?: [number, number]): MotionJoint => ({ id, type: "revolute", a, b, origin: [0, 0, 0], axis: [0, 0, 1], ...(limits ? { limits } : {}) });
const slide = (id: string, a: string, b: string, limits?: [number, number]): MotionJoint => ({ id, type: "slider", a, b, origin: [0, 0, 0], axis: [1, 0, 0], ...(limits ? { limits } : {}) });

describe("couplings", () => {
  it("a gear train: each joint follows its driver by the ratio, and the tightest limit holds the driver", () => {
    // Pinion j1 drives j2 at −0.5 (twice the teeth), which drives the rack slider j3 at 3 mm per degree.
    const m = new Mechanism([turn("j1", "pinion", "ground"), turn("j2", "wheel", "ground", [-30, 60]), slide("j3", "rack", "ground", [0, 45])], [
      { driver: "j1", driven: "j2", ratio: -0.5 },
      { driver: "j2", driven: "j3", ratio: 3 },
    ]);
    expect(m.errors).toEqual([]);
    expect(m.rootOf("j3")).toBe("j1");
    // j2 within −30…60 → j1 within −120…60; j3 = −1.5·j1 within 0…45 → j1 within −30…0.
    expect(m.range("j1").map((v) => v + 0)).toEqual([-30, 0]);
    expect(m.values({ j1: -20 })).toEqual({ j1: -20, j2: 10, j3: 30 });
    // Asked past the limit, the driver stops there.
    expect(m.values({ j1: -100 })).toEqual({ j1: -30, j2: 15, j3: 45 });
    expect(m.rootValueFor("j3", 15)).toEqual({ root: "j1", value: -10 });
    expect(m.jointOf("rack")?.id).toBe("j3");
    expect(m.joint("j2")?.type).toBe("revolute");
  });

  it("reports a part in two joints, a joint driven twice and couplings that go round in a circle", () => {
    expect(new Mechanism([turn("j1", "p", "ground"), turn("j2", "p", "ground")]).errors).toEqual(['part "p" moves in two joints']);
    const twice = new Mechanism([turn("j1", "a", "ground"), turn("j2", "b", "ground"), turn("j3", "c", "ground")], [
      { driver: "j1", driven: "j3", ratio: 1 },
      { driver: "j2", driven: "j3", ratio: 1 },
    ]);
    expect(twice.errors).toContain('joint "j3" is driven twice');
    const loop = new Mechanism([turn("j1", "a", "ground"), turn("j2", "b", "ground")], [
      { driver: "j1", driven: "j2", ratio: 1 },
      { driver: "j2", driven: "j1", ratio: 1 },
    ]);
    expect(loop.errors.join()).toMatch(/go round in a circle/);
    expect(loop.rootValueFor("j1", 5)).toBeNull();
    // A coupling to a joint that does not exist is left out.
    expect(new Mechanism([turn("j1", "a", "ground")], [{ driver: "j1", driven: "zz", ratio: 1 }]).errors).toEqual([]);
  });

  it("a fixed joint carries its part along without moving it; a ratio of 0 frees nothing", () => {
    const m = new Mechanism([slide("j1", "carriage", "ground", [0, 100]), { id: "j2", type: "fixed", a: "tool", b: "carriage", origin: [0, 0, 0], axis: [0, 0, 1] }, turn("j3", "knob", "ground")], [{ driver: "j1", driven: "j3", ratio: 0 }]);
    const v = m.values({ j1: 40 });
    expect(v["j2"]).toBe(0);
    expect(v["j3"]).toBe(0);
    expect(m.rootValueFor("j3", 10)).toBeNull();
    const poses = m.poses(v);
    expect(transformPoint(poses.get("tool")!, [1, 2, 3])).toEqual([41, 2, 3]);
  });

  it("reports joints that hang parts on each other in a loop", () => {
    const m = new Mechanism([turn("j1", "a", "b"), turn("j2", "b", "a")]);
    m.poses({ j1: 10, j2: 10 });
    expect(m.errors.join()).toMatch(/form a loop/);
  });
});

describe("dragging helpers", () => {
  it("a ray meets a plane, or runs along it", () => {
    expect(rayPlane([0, 0, 10], [0, 0, -1], [0, 0, 2], [0, 0, 1])).toEqual([0, 0, 2]);
    expect(rayPlane([0, 0, 10], [1, 0, 0], [0, 0, 2], [0, 0, 1])).toBeNull();
  });
  it("angles about an axis are signed, counter-clockwise positive", () => {
    expect(angleAbout([0, 0, 0], [0, 0, 1], [1, 0, 5], [0, 1, -3])).toBeCloseTo(90, 9);
    expect(angleAbout([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, -1, 0])).toBeCloseTo(-90, 9);
  });
  it("the point of a line nearest to a ray, and none for a parallel ray", () => {
    expect(rayLineParam([5, 10, 0], [0, -1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(5, 9);
    expect(rayLineParam([5, 10, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
  });
});

describe("motion tracks", () => {
  it("one moment is held the whole time; two moments at one time, the later wins", () => {
    expect(sampleMotion({ duration: 2, keys: [{ at: 1, values: { j: 7 } }] }, 0.3)).toEqual({ j: 7 });
    const keys = [{ at: 0, values: { j: 0 } }, { at: 1, values: { j: 5 } }, { at: 1, values: { j: 9 } }, { at: 2, values: { j: 9 } }];
    expect(sampleMotion({ duration: 2, smooth: false, keys }, 1.5)).toEqual({ j: 9 });
    // Smooth curves pass through every moment (and may swing a little past a held value between them).
    for (const [t, v] of [[0, 0], [1, 9], [2, 9]] as const) expect(sampleMotion({ duration: 2, keys }, t).j).toBeCloseTo(v, 9);
  });
});
