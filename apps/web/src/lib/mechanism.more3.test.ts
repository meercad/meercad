/**
 * More of the mechanism (mechanism.ts) with the real kernel: limits or a gear ratio that cannot be
 * worked out are named as the joint's problem, the rest still moves; the wanted gap falls back to
 * the design's fit (at least 0.3 mm) when its own value cannot be worked out; a gap check the kernel
 * cannot do says so; a joint's axis is taken from an edge, and a flat face is refused for it; a
 * motion asking more than a limit allows says where it was held.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DocOp, Feature, Joint, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, kernel, newProject, rebuildNow, useApp } from "../store";
import { checkClearance, currentMechanism, jointPick, openForCheck, showMotionAt, startJoint, useMotion, wantedClearance } from "./mechanism";

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
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
  { id: "base", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 60, 0, 10, 10), constraints: [] },
  { id: "cube", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");

beforeAll(async () => {
  await newProject(undefined, "Mechanism more");
  const slide: Joint = { id: "j1", type: "slider", a: "cube", b: "ground", anchor: { axis: { ref: "origin.X" } }, limits: ["-5 mm", "5 mm"] };
  apply({ type: "add_features", features: design }, { type: "set_joint", joint: slide } as DocOp);
  await rebuildNow();
  openForCheck();
});
afterEach(() => vi.restoreAllMocks());

describe("the mechanism, more", () => {
  it("names limits and a ratio that cannot be worked out, and moves the rest", async () => {
    const bad: Joint = { id: "j2", type: "revolute", a: "base", b: "ground", anchor: { axis: { ref: "origin.Z" } }, limits: ["nope", "10"] };
    apply({ type: "set_joint", joint: bad } as DocOp, { type: "set_coupling", coupling: { id: "c1", driver: "j1", driven: "j2", ratio: "zz * 2" } } as DocOp);
    await rebuildNow();
    const { mech, problems } = currentMechanism();
    expect(problems["j2"]).toMatch(/^limits: /);
    expect(problems["c1"]).toMatch(/^ratio: /);
    expect(mech.joints.map((j) => j.id)).toEqual(["j1"]);
    apply({ type: "delete_joint", id: "j2" } as DocOp, { type: "delete_coupling", id: "c1" } as DocOp);
  });

  it("falls back to the design's fit, at least 0.3 mm, when the wanted gap cannot be worked out", async () => {
    const withGap = (clearance: string) => {
      const d = currentDoc();
      apply({ type: "replace", doc: { ...d, mechanism: { ...d.mechanism!, clearance } } } as DocOp);
    };
    withGap("unknown_gap");
    expect(wantedClearance()).toBeGreaterThanOrEqual(0.3);
    withGap("0.7");
    expect(wantedClearance()).toBeCloseTo(0.7, 9);
  });

  it("says when the kernel cannot check the gaps", async () => {
    vi.spyOn(kernel, "clearances").mockRejectedValueOnce(new Error("kernel busy"));
    await checkClearance();
    expect(useMotion.getState().check?.error).toBe("kernel busy");
  });

  it("takes a joint's axis from an edge, and refuses a flat face for it", async () => {
    startJoint();
    useMotion.setState((s) => ({ draft: { ...s.draft!, field: "anchor" } }));
    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === "base")!;
    expect(jointPick({ kind: "face", bodyId: "base", face: 0, tags: m.faceTags[0]!, point: [0, 0, 10], normal: [0, 0, 1] } as never)).toBe(true);
    expect(toasts()).toMatch(/Pick a round face \(hole or shaft\) or an edge/);
    jointPick({ kind: "edge", bodyId: "base", edge: 0, tags: [], point: [0, 0, 0] } as never);
    expect("edge" in (useMotion.getState().draft!.joint.anchor as object)).toBe(true);
    useMotion.setState({ draft: null });
  });

  it("says where a motion was held at a limit", () => {
    const held = showMotionAt({ id: "m1", duration: 1, keys: [{ at: 0, values: { j1: 0 } }, { at: 1, values: { j1: 9 } }] } as never, 1);
    expect(held).toEqual([{ joint: "j1", wanted: 9, got: 5 }]);
  });
});
