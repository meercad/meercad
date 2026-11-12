/**
 * Playing joints and picking for a new joint (mechanism.ts) with the real kernel, frame by frame:
 * a slider plays at 15 mm a second and turns back at its limit, a hinge at 60° a second; picks for
 * a new joint take the moving part, then what it hangs on (not itself), then a round face or an
 * edge as its axis (a flat face is refused with a hint).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DocOp, Feature, Joint, SketchEntity } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { apply, newProject, rebuildNow, useApp } from "../store";
import { jointPick, jointValues, openForCheck, playJoint, restPose, saveJoint, setJointField, startJoint, stopPlaying, useMotion } from "./mechanism";

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
const parts: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
  { id: "base", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 4, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 60, 0, 10, 10), constraints: [] },
  { id: "cube", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk3", op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "o", type: "point", x: 20, y: 40 }, { id: "k", type: "circle", center: "o", radius: 5 }], constraints: [] },
  { id: "pin", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 10, mode: "new_body" },
];
const slide: Joint = { id: "j2", type: "slider", a: "cube", b: "ground", anchor: { axis: { ref: "origin.X" } }, limits: ["-30 mm", "20 mm"] };
const hinge: Joint = { id: "j1", type: "revolute", a: "base", b: "ground", anchor: { axis: { ref: "origin.Z" } } };

/** Animation frames run by hand: each call runs the waiting frame at `t` ms. */
let frames: FrameRequestCallback[] = [];
const runFrame = (t: number) => {
  const now = frames;
  frames = [];
  for (const f of now) f(t);
};

beforeAll(async () => {
  await newProject(undefined, "Play");
  apply({ type: "add_features", features: parts }, { type: "set_joint", joint: slide }, { type: "set_joint", joint: hinge } as DocOp);
  await rebuildNow();
  openForCheck();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => (frames.push(cb), frames.length));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => void (frames = []));
});
afterEach(() => {
  stopPlaying();
  restPose();
});

describe("playing a joint", () => {
  it("slides at 15 mm a second and turns back at its limit", () => {
    const t0 = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(t0);
    playJoint("j2");
    expect(useMotion.getState().playing).toBe("j2");
    // Ten frames of 0.1 s: 1 s, 15 mm.
    for (let k = 1; k <= 10; k++) runFrame(t0 + k * 100);
    expect(jointValues()["j2"]).toBeCloseTo(15, 6);
    // Four more: 16.5, 18, 19.5, then held at 20 and turned; the next frame goes back 1.5.
    for (let k = 11; k <= 14; k++) runFrame(t0 + k * 100);
    expect(jointValues()["j2"]).toBeCloseTo(20, 6);
    runFrame(t0 + 1500);
    expect(jointValues()["j2"]).toBeCloseTo(18.5, 6);
    vi.mocked(performance.now).mockRestore();
  });

  it("turns a hinge with no limits at 60° a second, round and round", () => {
    const t0 = 1000;
    vi.spyOn(performance, "now").mockReturnValue(t0);
    playJoint("j1");
    for (let k = 1; k <= 5; k++) runFrame(t0 + k * 100);
    expect(jointValues()["j1"]).toBeCloseTo(30, 6);
    stopPlaying();
    expect(useMotion.getState().playing ?? null).toBeNull();
    vi.mocked(performance.now).mockRestore();
  });
});

describe("picking for a new joint", () => {
  const face = (body: string, tag: string, normal: [number, number, number] | null): Pick => {
    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === body)!;
    const i = m.faceTags.findIndex((t) => t[0]!.startsWith(tag));
    return { kind: "face", bodyId: body, face: i, tags: m.faceTags[i]!, point: [0, 0, 0], normal } as Pick;
  };

  it("takes the part, what it hangs on and a round face as the axis", () => {
    startJoint();
    // A new joint waits for its moving part: a tap on nothing is used up.
    expect(useMotion.getState().draft!.field).toBe("a");
    expect(jointPick(null)).toBe(true);
    setJointField("a");
    expect(jointPick(face("pin", "pin.end_cap", [0, 0, 1]))).toBe(true);
    expect(useMotion.getState().draft!.joint.a).toBe("pin");
    expect(useMotion.getState().draft!.field).toBe("b");
    // Not itself.
    jointPick(face("pin", "pin.end_cap", [0, 0, 1]));
    expect(useApp.getState().toasts.at(-1)!.text).toBe("Pick another part, or Ground");
    jointPick(face("base", "base.end_cap", [0, 0, 1]));
    expect(useMotion.getState().draft!.joint.b).toBe("base");
    expect(useMotion.getState().draft!.field).toBe("anchor");
    // A flat face is no axis.
    jointPick(face("base", "base.end_cap", [0, 0, 1]));
    expect(useApp.getState().toasts.at(-1)!.text).toBe("Pick a round face (hole or shaft) or an edge for the axis");
    jointPick(face("pin", "pin.side", null));
    expect(useMotion.getState().draft!.joint.anchor).toMatchObject({ axisOf: expect.anything() });
    expect(saveJoint()).toBe(true);
    expect(useApp.getState().doc.mechanism!.joints.some((j) => j.a === "pin" && j.b === "base")).toBe(true);
  });

  it("refuses to save a joint without a moving part", () => {
    startJoint();
    expect(saveJoint()).toBe(false);
    expect(useApp.getState().toasts.at(-1)!.text).toBe("Pick the part that moves");
    useMotion.setState({ draft: null });
  });
});
