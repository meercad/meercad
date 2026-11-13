/**
 * The joints panel's rows (MotionPanel.tsx) with the real kernel: joint symbols hidden and shown; a
 * joint played and stopped, saved as a GIF (and a video that cannot be made says so), edited and
 * deleted; a coupling whose ratio cannot be worked out and a joint driven in a circle are named;
 * gears get their joints by one button.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DocOp, Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, useApp } from "../store";
import { usePrefs } from "../lib/keymap";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { openForCheck, useMotion } from "../lib/mechanism";
import * as render from "../lib/render";
import { MotionPanel } from "./MotionPanel";

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
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 50, 0, 10, 10), constraints: [] },
  { id: "cube", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "g1", op: "gear", kind: "spur", module: 2, teeth: 20, width: 6, center: [0, 80], mode: "new_body" } as Feature,
  { id: "g2", op: "gear", kind: "spur", module: 2, teeth: 10, width: 6, meshWith: { gear: "g1" }, mode: "new_body" } as Feature,
];
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Joint rows");
  apply(
    { type: "add_features", features: design },
    { type: "set_joint", joint: { id: "j1", name: "Slide", type: "slider", a: "cube", b: "ground", anchor: { axis: { ref: "origin.X" } }, limits: [-20, 20] } } as DocOp,
  );
  await rebuilt();
  await act(async () => openForCheck());
  renderUi(<MotionPanel />);
  await settle();
});
afterAll(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the joints panel's rows", () => {
  it("hides and shows the joint symbols", async () => {
    await act(async () => void fireEvent.click(screen.getByTitle("Hide joint symbols")));
    expect(usePrefs.getState().showJoints).toBe(false);
    await act(async () => void fireEvent.click(screen.getByTitle("Show joint symbols")));
    expect(usePrefs.getState().showJoints).toBe(true);
  });

  it("plays a joint, saves it as a GIF, and says when that fails", async () => {
    fireEvent.click(screen.getByTitle("Play: move it back and forth"));
    expect(useMotion.getState().playing).toBe("j1");
    const { stopPlaying } = await import("../lib/mechanism");
    stopPlaying();
    expect(useMotion.getState().playing).toBeNull();
    const gif = vi.spyOn(render, "renderMotionGif").mockResolvedValueOnce(new Uint8Array([71, 73, 70]));
    await act(async () => void fireEvent.click(screen.getByTitle("Save a video (GIF) of this motion")));
    await settle();
    expect(gif).toHaveBeenCalledWith("j1", -20, 20);
    vi.spyOn(render, "renderMotionGif").mockRejectedValueOnce(new Error("no frames"));
    await act(async () => void fireEvent.click(screen.getByTitle("Save a video (GIF) of this motion")));
    await settle();
    expect(toasts()).toMatch(/Could not make the video: no frames/);
  });

  it("names a coupling it cannot work out and joints driven in a circle", async () => {
    apply(
      { type: "set_joint", joint: { id: "j2", type: "revolute", a: "base", b: "ground", anchor: { axis: { ref: "origin.Z" } } } } as DocOp,
      { type: "set_coupling", coupling: { id: "c1", driver: "j1", driven: "j2", ratio: "nope" } } as DocOp,
    );
    await settle(50);
    expect(screen.getByText(/^c1: ratio: /)).toBeTruthy();
    apply({ type: "set_coupling", coupling: { id: "c1", driver: "j1", driven: "j2", ratio: 2 } } as DocOp, { type: "set_coupling", coupling: { id: "c2", driver: "j2", driven: "j1", ratio: 1 } } as DocOp);
    await settle(50);
    expect(screen.getAllByText(/go round in a circle/).length).toBeGreaterThan(0);
    apply({ type: "delete_coupling", id: "c1" } as DocOp, { type: "delete_coupling", id: "c2" } as DocOp, { type: "delete_joint", id: "j2" } as DocOp);
  });

  it("edits and deletes a joint from its row, and makes joints for the gears", async () => {
    await act(async () => void fireEvent.click(screen.getAllByTitle("Edit")[0]!));
    expect(useMotion.getState().draft?.joint.id).toBe("j1");
    await act(async () => useMotion.setState({ draft: null }));
    await act(async () => void fireEvent.click(screen.getAllByTitle("Delete")[0]!));
    expect(currentDoc().mechanism?.joints.some((j) => j.id === "j1") ?? false).toBe(false);
    await act(async () => void fireEvent.click(screen.getByText(/Joints for 2 gears/)));
    expect(currentDoc().mechanism!.joints.length).toBe(2);
    expect(toasts()).toMatch(/2 gear joints added/);
  });
});
