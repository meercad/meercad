/**
 * Moving parts by hand and in closed loops (mechanism.ts) with the real kernel. A lid turned by
 * dragging it lands at the angle the pointer went round its hinge; a slider dragged along its axis
 * moves the distance the pointer went. A four-bar linkage (a part hanging in two joints) stays
 * closed when its crank turns: the joints still meet, the crank turned exactly as asked, and the
 * rocker's swing is found by driving it to its ends.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocOp, Feature, Joint, JointAnchor, SketchEntity } from "@meercad/schema";
import { apply, newProject, rebuildNow } from "../store";
import { currentMechanism, currentPoses, jointValues, openForCheck, partDrag, playJoint, restPose, setJointValue, stopPlaying, swingRanges, useMotion } from "./mechanism";

const rect = (p: string, x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y },
  { id: `${p}2`, type: "point", x: x + w, y },
  { id: `${p}3`, type: "point", x: x + w, y: y + h },
  { id: `${p}4`, type: "point", x, y: y + h },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const part = (id: string, x: number, y: number, w: number, h: number, z = 0): Feature[] => [
  { id: `s_${id}`, op: "sketch", plane: z ? { ref: `pl_${id}` } : { ref: "origin.XY" }, entities: rect("r", x, y, w, h), constraints: [] },
  { id, op: "extrude", profile: { sketch: `s_${id}` }, extent: "blind", distance: 3, mode: "new_body" },
];
/** The vertical edge of part `id` at its sketch corner between sides `s1` and `s2` (a, b, c, d). */
const corner = (id: string, s1: string, s2: string): JointAnchor => ({ edge: { edge: [`${id}.side[s_${id}.r${s1}]`, `${id}.side[s_${id}.r${s2}]`] } });
const at = (part: string, p: [number, number, number]) => {
  const m = currentPoses().get(part);
  if (!m) return p;
  return [0, 1, 2].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!);
};
const ray = (origin: [number, number, number], dir: [number, number, number]) => ({ origin, dir });

describe("dragging parts by hand", () => {
  beforeAll(async () => {
    await newProject(undefined, "Drag");
    const lid: Feature[] = [
      { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
      { id: "lid", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 4, mode: "new_body" },
      { id: "sk3", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 60, 0, 10, 10), constraints: [] },
      { id: "cube", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 10, mode: "new_body" },
    ];
    const hinge: Joint = { id: "j1", type: "revolute", a: "lid", b: "ground", anchor: { axis: { ref: "origin.X" } }, limits: [-120, 120] };
    const slide: Joint = { id: "j2", type: "slider", a: "cube", b: "ground", anchor: { axis: { ref: "origin.X" } }, limits: ["-30 mm", "20 mm"] };
    apply({ type: "add_features", features: lid }, { type: "set_joint", joint: hinge }, { type: "set_joint", joint: slide } as DocOp);
    await rebuildNow();
  });
  beforeEach(() => {
    openForCheck();
    restPose();
  });

  it("turns the lid by the angle the pointer goes round its hinge: a quarter turn", () => {
    // Grabbed at (20, 20, 4); the pointer then meets the plane across the hinge at (20, −4, 20):
    // the arm (20, 4) from the axis turned a quarter round to (−4, 20).
    expect(partDrag.start({ kind: "face", bodyId: "lid", face: 0, tags: [], point: [20, 20, 4], normal: [0, 0, 1] } as never, ray([20, 20, 50], [0, 0, -1]))).toBe(true);
    partDrag.move(ray([100, -4, 20], [-1, 0, 0]));
    partDrag.end();
    expect(jointValues()["j1"]).toBeCloseTo(90, 6);
    at("lid", [20, 20, 4]).forEach((v, i) => expect(v).toBeCloseTo([20, -4, 20][i]!, 6));
  });

  it("slides the cube the distance the pointer goes along the axis, held at its limit", () => {
    expect(partDrag.start({ kind: "face", bodyId: "cube", face: 0, tags: [], point: [65, 5, 10], normal: [0, 0, 1] } as never, ray([65, 5, 50], [0, 0, -1]))).toBe(true);
    partDrag.move(ray([52.5, 5, 50], [0, 0, -1]));
    expect(jointValues()["j2"]).toBeCloseTo(-12.5, 6);
    partDrag.move(ray([20, 5, 50], [0, 0, -1]));
    partDrag.end();
    expect(jointValues()["j2"]).toBe(-30);
  });

  it("turns a joint from its symbol, and grabs nothing on a part that cannot move", () => {
    expect(partDrag.startJoint("j1", ray([10, 30, 0], [-1, 0, 0]))).toBe(true);
    partDrag.move(ray([10, 0, 30], [-1, 0, 0]));
    partDrag.end();
    expect(jointValues()["j1"]).toBeCloseTo(90, 6);
    expect(partDrag.startJoint("zz", ray([0, 0, 0], [1, 0, 0]))).toBe(false);
    expect(partDrag.start({ kind: "face", bodyId: "nope", face: 0, tags: [], point: [0, 0, 0], normal: null } as never, ray([0, 0, 9], [0, 0, -1]))).toBe(false);
  });
});

describe("a four-bar linkage", () => {
  // Crank 0..20 on x, coupler 20..60, rocker from (60, 0) up to its ground pivot at (62, 30).
  const crankPivot: [number, number, number] = [0, 0, 0];
  const crankEnd: [number, number, number] = [20, 0, 0];
  const couplerEnd: [number, number, number] = [60, 0, 0];
  const rockerPivot: [number, number, number] = [62, 30, 0];

  beforeAll(async () => {
    await newProject(undefined, "Four-bar");
    apply(
      { type: "add_features", features: [...part("crank", 0, 0, 20, 2), ...part("coupler", 20, 0, 40, 2), ...part("rocker", 60, 0, 2, 30)] },
      { type: "set_joint", joint: { id: "j1", type: "revolute", a: "crank", b: "ground", anchor: corner("crank", "a", "d") } },
      { type: "set_joint", joint: { id: "j2", type: "revolute", a: "coupler", b: "crank", anchor: corner("crank", "a", "b") } },
      { type: "set_joint", joint: { id: "j3", type: "revolute", a: "rocker", b: "coupler", anchor: corner("coupler", "a", "b") } },
      { type: "set_joint", joint: { id: "j4", type: "revolute", a: "rocker", b: "ground", anchor: corner("rocker", "b", "c") } } as DocOp,
    );
    await rebuildNow();
    openForCheck();
    restPose();
  });

  it("finds its joints round the vertical edges", () => {
    const { mech, problems } = currentMechanism();
    expect(problems).toEqual({});
    expect(mech.joints.map((j) => j.axis.map((v) => Math.abs(Math.round(v))))).toEqual([[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]]);
  });

  it("stays closed when the crank turns 10°", () => {
    expect(setJointValue("j1", 10)).toBe(true);
    expect(jointValues()["j1"]).toBeCloseTo(10, 6);
    const end = at("crank", crankEnd);
    expect(end[0]).toBeCloseTo(20 * Math.cos(Math.PI / 18), 6);
    expect(end[1]).toBeCloseTo(20 * Math.sin(Math.PI / 18), 6);
    expect(at("crank", crankPivot)).toEqual(expect.arrayContaining([expect.closeTo(0, 6)]));
    // Every joint still meets: crank and coupler, coupler and rocker, the rocker on its ground pivot.
    const gap = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    expect(gap(at("coupler", crankEnd), end)).toBeLessThan(1e-4);
    expect(gap(at("coupler", couplerEnd), at("rocker", couplerEnd))).toBeLessThan(1e-4);
    expect(gap(at("rocker", rockerPivot), rockerPivot)).toBeLessThan(1e-4);
    // The links keep their lengths.
    expect(gap(at("coupler", crankEnd), at("coupler", couplerEnd))).toBeCloseTo(40, 4);
  });

  it("knows how far the crank can swing either way", () => {
    restPose();
    const r = swingRanges();
    expect(Object.keys(r).sort()).toEqual(["j1", "j2", "j3", "j4"]);
    const crank = r["j1"];
    // Not a full turn: crank 20 + ground 68.9 is longer than coupler 40 + rocker 30.1.
    expect(crank).not.toBeNull();
    expect(crank![0]).toBeLessThan(0);
    expect(crank![1]).toBeGreaterThan(0);
    // Same linkage, same answer without working it out again.
    expect(swingRanges()).toBe(r);
  });

  it("plays the crank, turning back where the loop cannot go further", () => {
    restPose();
    let frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => (frames.push(cb), frames.length));
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => void (frames = []));
    try {
      const t0 = performance.now();
      playJoint("j1");
      expect(useMotion.getState().playing).toBe("j1");
      const seen: number[] = [];
      for (let k = 1; k <= 200 && frames.length; k++) {
        const cb = frames.shift()!;
        cb(t0 + k * 100);
        seen.push(jointValues()["j1"]!);
      }
      // It went up and came back down: the crank cannot turn round.
      const top = Math.max(...seen);
      expect(top).toBeGreaterThan(5);
      expect(seen.at(-1)!).toBeLessThan(top - 1);
    } finally {
      stopPlaying();
      raf.mockRestore();
      caf.mockRestore();
      restPose();
    }
  });

  it("drags the coupler and the loop follows", () => {
    restPose();
    expect(partDrag.start({ kind: "face", bodyId: "coupler", face: 0, tags: [], point: [40, 1, 3], normal: [0, 0, 1] } as never, ray([40, 1, 50], [0, 0, -1]))).toBe(true);
    partDrag.move(ray([40, 4, 50], [0, 0, -1]));
    partDrag.end();
    const gap = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    expect(gap(at("rocker", rockerPivot), rockerPivot)).toBeLessThan(1e-4);
    expect(gap(at("coupler", crankEnd), at("crank", crankEnd))).toBeLessThan(1e-4);
    expect(Math.abs(jointValues()["j1"]!)).toBeGreaterThan(0.1);
  });
});
