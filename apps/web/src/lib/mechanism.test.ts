/**
 * Moving parts in the app (mechanism.ts) with the real kernel: a lid on a hinge, a slider with
 * limits, a gear pair coupled by its teeth and a motion over time. Angles, positions and the
 * gaps the kernel measures between the parts are checked by number.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { DocOp, Feature, Joint, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import {
  addPoseToMotion,
  checkMotion,
  checkMotionRun,
  clearanceNow,
  currentMechanism,
  currentPoses,
  deleteJoint,
  designedContacts,
  joinedParts,
  jointsFromGears,
  jointValues,
  motionById,
  openForCheck,
  restPose,
  saveJoint,
  setJointValue,
  setPose,
  showMotionAt,
  startJoint,
  sweepCheck,
  updateJointDraft,
  useMotion,
  wantedClearance,
} from "./mechanism";

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
/** A 40 × 20 × 4 base, a lid of the same size 1 mm above it, and a 10 mm cube beside them. */
const parts: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 0, 0, 40, 20),
    constraints: [],
  },
  { id: "base", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 4, mode: "new_body" },
  { id: "pl", op: "plane", base: { ref: "origin.XY" }, offset: 5 },
  { id: "sk2", op: "sketch", plane: { ref: "pl" }, entities: rect("l", 0, 0, 40, 20), constraints: [] },
  { id: "lid", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 4, mode: "new_body" },
  {
    id: "sk3",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 60, 0, 10, 10),
    constraints: [],
  },
  { id: "cube", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 10, mode: "new_body" },
];
/** The lid turns about the X axis (its front edge's line through the origin, 5 mm below it). */
const hinge: Joint = {
  id: "j1",
  type: "revolute",
  a: "lid",
  b: "base",
  anchor: { axis: { ref: "origin.X" } },
  limits: [-90, 90],
};
/** The cube slides along X, −30…20 mm. */
const slide: Joint = {
  id: "j2",
  type: "slider",
  a: "cube",
  b: "ground",
  anchor: { axis: { ref: "origin.X" } },
  limits: ["-30 mm", "20 mm"],
};

/** Where a point of a part goes with the shown pose. */
function moved(part: string, p: [number, number, number]): number[] {
  const m = currentPoses().get(part);
  if (!m) return p;

  return [0, 1, 2].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!);
}

beforeAll(async () => {
  await newProject(undefined, "Hinge");
  apply({ type: "add_features", features: parts }, { type: "set_joint", joint: hinge }, {
    type: "set_joint",
    joint: slide,
  } as DocOp);
  await rebuildNow();
});

describe("moving parts", () => {
  it("knows the joints and their axes from the rebuild", () => {
    const { mech, problems } = currentMechanism();
    expect(problems).toEqual({});
    expect(mech.joints.map((j) => [j.id, j.type, j.axis])).toEqual([
      ["j1", "revolute", [1, 0, 0]],
      ["j2", "slider", [1, 0, 0]],
    ]);
    expect(jointValues()).toEqual({ j1: 0, j2: 0 });
  });

  it("turns the lid and slides the cube, held at their limits", () => {
    openForCheck();
    expect(setJointValue("j1", 90)).toBe(true);
    // The lid's far corner (40, 20, 9) turned 90° about X: y → −z, z → y.
    expect(moved("lid", [40, 20, 9]).map((v) => +v.toFixed(9))).toEqual([40, -9, 20]);
    expect(setJointValue("j2", 35)).toBe(true);
    expect(jointValues()["j2"]).toBe(20);
    expect(useMotion.getState().blocked).toEqual(["cube"]);
    expect(moved("cube", [60, 0, 0])).toEqual([80, 0, 0]);
    expect(setJointValue("zz", 1)).toBe(false);
    restPose();
    expect(jointValues()).toEqual({ j1: 0, j2: 0 });
  });

  it("sets a pose as the assistant does and says what it could not reach", () => {
    const r = setPose({ j1: 30, j2: 50 });
    expect(r.values).toEqual({ j1: 30, j2: 20 });
    expect(r.reached).toBe(false);
    expect(Object.keys(r.problems)).toEqual(["j2"]);
    restPose();
  });

  it("measures the gaps between parts in the pose shown", async () => {
    restPose();

    const rest = await clearanceNow();
    const lidBase = rest.pairs.find((p) => [p.a, p.b].sort().join() === "base,lid")!;
    expect(lidBase.distance).toBeCloseTo(1, 6);
    expect(rest.wanted).toBe(wantedClearance());
    // Gaps of more than twice the wanted one are left out: the cube 20 mm away is not listed.
    expect(rest.pairs.some((p) => p.a === "cube" || p.b === "cube")).toBe(false);
    // Slid 18.5 mm back, it stands 1.5 mm from the base's end at x = 40.
    setJointValue("j2", -18.5);

    const slid = await clearanceNow();
    expect(slid.pairs.find((p) => [p.a, p.b].sort().join() === "base,cube")!.distance).toBeCloseTo(1.5, 6);
    restPose();
  });

  it("finds where the lid turning down first runs into the base", async () => {
    // Turned by −θ about X the lid's back lower edge (y = 20, z = 5) comes down to z = 5cos θ − 20 sin θ,
    // onto the base's top (z = 4) at θ = 2.9°: the first step, −5°, overlaps.
    const r = await checkMotion("j1", 0, -30, 6);
    expect(r.firstContact).toMatchObject({ value: -5, kind: "overlap" });
    expect([r.firstContact!.a, r.firstContact!.b].sort()).toEqual(["base", "lid"]);
    expect(jointValues()["j1"]).toBe(0);

    const sweep = await sweepCheck({ joints: [{ joint: "j1", from: 0, to: -30, steps: 6 }] });
    expect(sweep.collisions.length).toBeGreaterThan(0);
  });

  it("names the parts that move together", () => {
    expect(joinedParts("lid")).toEqual(["lid", "base"]);
    expect(joinedParts("cube")).toEqual(["cube"]);
    expect(
      joinedParts("lid", [
        { id: "f", type: "fixed", a: "lid", b: "cube", anchor: { axis: { ref: "origin.Z" } } },
      ]),
    ).toEqual(["lid", "cube"]);
    expect([...designedContacts()]).toEqual(["base|lid"]);
  });

  it("records a motion from poses and plays it back", async () => {
    setJointValue("j1", 0);
    addPoseToMotion("m1", 0);
    setJointValue("j1", 60);
    addPoseToMotion("m1", 2);

    const m = motionById("m1");
    expect(m.keys.map((k) => [k.at, k.values["j1"]])).toEqual([
      [0, 0],
      [2, 60],
    ]);
    expect(showMotionAt(m, 1)).toEqual([]);
    expect(jointValues()["j1"]).toBeGreaterThan(0);
    expect(jointValues()["j1"]).toBeLessThan(60);

    const run = await checkMotionRun("m1", 4);
    expect(run.frames).toBe(4);
    expect(run.collisions).toEqual([]);
    expect(() => motionById("zz")).toThrow(/no motion "zz": there are m1/);
    restPose();
  });

  it("adds a joint drawn up in the panel and deletes it", () => {
    startJoint();
    expect(saveJoint()).toBe(false);
    updateJointDraft({
      id: "j9",
      type: "revolute",
      a: "cube",
      b: "ground",
      anchor: { axis: { ref: "origin.Z" } },
    });
    expect(saveJoint()).toBe(true);
    expect(currentDoc().mechanism!.joints.map((j) => j.id)).toContain("j9");
    deleteJoint("j9");
    expect(currentDoc().mechanism!.joints.map((j) => j.id)).not.toContain("j9");
  });
});

describe("gears", () => {
  it("adds a joint to each gear and couples the pair by its teeth", async () => {
    await newProject(undefined, "Gears");
    apply({
      type: "add_features",
      features: [
        { id: "g1", op: "gear", kind: "spur", module: 1, teeth: 20, width: 5, mode: "new_body" },
        {
          id: "g2",
          op: "gear",
          kind: "spur",
          teeth: 40,
          width: 5,
          meshWith: { gear: "g1" },
          mode: "new_body",
        },
      ],
    });
    await rebuildNow();
    expect(jointsFromGears()).toBe(2);
    expect(currentDoc().mechanism!.couplings).toEqual([
      { id: "c1", driver: "j1", driven: "j2", ratio: -0.5 },
    ]);
    expect(jointsFromGears()).toBe(0);
    await rebuildNow();
    openForCheck();
    setJointValue("j1", 90);
    expect(jointValues()["j2"]).toBeCloseTo(-45, 9);
    // Driving the driven gear turns the driver.
    setJointValue("j2", -90);
    expect(jointValues()["j1"]).toBeCloseTo(180, 9);
    expect(useApp.getState().output!.report.gears.map((g) => g.radius)).toEqual([10, 20]);
    restPose();
  });
});
