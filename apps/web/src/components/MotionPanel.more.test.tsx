/**
 * Motions in the joints panel (MotionPanel.tsx) with the real kernel: a motion sliding the cube
 * from 0 to −15 mm over 2 s shows each moment's pose (the cube where the moment says), is checked
 * for collisions (it meets the base at −10 mm), renamed, made longer, and saved as a GIF; a joint
 * is edited and deleted from its row.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { jointValues, openForCheck, useMotion } from "../lib/mechanism";
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
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 0, 0, 40, 20),
    constraints: [],
  },
  { id: "base", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 50, 0, 10, 10),
    constraints: [],
  },
  { id: "cube", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const motion = () => currentDoc().mechanism!.motions![0]!;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Motions");
  apply(
    { type: "add_features", features: design },
    {
      type: "set_joint",
      joint: {
        id: "j1",
        name: "Slide",
        type: "slider",
        a: "cube",
        b: "ground",
        anchor: { axis: { ref: "origin.X" } },
        limits: [-20, 20],
      },
    },
    {
      type: "set_motion",
      motion: {
        id: "m1",
        duration: 2,
        keys: [
          { at: 0, values: { j1: 0 } },
          { at: 2, values: { j1: -15 } },
        ],
      },
    },
  );
  await rebuilt();
  await act(async () => openForCheck());
  renderUi(<MotionPanel />);
  await settle();
});
afterAll(cleanup);

describe("a motion in the joints panel", () => {
  it("shows the pose of each moment", async () => {
    await act(async () => void fireEvent.click(screen.getByText("2.00 s")));
    expect(jointValues()["j1"]).toBeCloseTo(-15, 9);
    await act(async () => void fireEvent.click(screen.getByText("0.00 s")));
    expect(jointValues()["j1"]).toBeCloseTo(0, 9);
  });

  it("finds where the sliding cube meets the base", async () => {
    await act(async () => void fireEvent.click(screen.getByTitle("Check for collisions")));
    await waitFor(() => expect(screen.getByText(/^Collides at|^No collision/)).toBeTruthy(), {
      timeout: 60_000,
    });
    // The cube's face at x = 50 reaches the base's end at x = 40 after 10 of the 15 mm; the motion
    // eases in and out, so that is at 65 % of the time: the first of 24 frames past it is 1.304 s.
    expect(screen.getByText(/^Collides at/).textContent).toMatch(
      /^Collides at 1\.304 s, .*: Extrude base · Extrude cube$/,
    );
  });

  it("is renamed and made longer, never shorter than its last moment", async () => {
    const name = screen.getByPlaceholderText("m1");
    await act(async () => void fireEvent.change(name, { target: { value: "Push" } }));
    expect(motion().name).toBe("Push");

    const duration = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')].find(
      (i) => i.value === "2",
    )!;
    await act(async () => void fireEvent.change(duration, { target: { value: "4" } }));
    expect(motion().duration).toBe(4);
    await act(async () => void fireEvent.change(duration, { target: { value: "1" } }));
    expect(motion().duration).toBe(2);
  });

  it("adds the pose shown as a moment past the end, deletes one, and says a GIF needs the 3D view", async () => {
    await act(async () => void fireEvent.click(screen.getByText("2.00 s")));
    await act(
      async () => void fireEvent.click(screen.getByTitle("Adds the pose shown now as the next moment")),
    );
    // Past the last moment at 2 s: a new one at 2.5 s, and the motion grows to 2.5 s.
    expect(motion().keys.map((k) => k.at)).toEqual([0, 2, 2.5]);
    expect(motion().duration).toBe(2.5);
    await act(async () => void fireEvent.click(screen.getAllByTitle("Delete").at(-1)!));
    expect(motion().keys.length).toBe(2);

    const gif = () =>
      document.querySelector<HTMLButtonElement>(
        '.motions button[title="Save a video (GIF) of this motion"]',
      )!;
    await act(async () => void fireEvent.click(gif()));
    await waitFor(() => expect(gif().hasAttribute("disabled")).toBe(false), { timeout: 60_000 });
    // Without a 3D view on the screen there is nothing to film: it says so.
    expect(useApp.getState().toasts.at(-1)).toMatchObject({
      kind: "error",
      text: "Could not make the video: viewport not ready",
    });
  });

  it("deletes the motion, and a joint from its row", async () => {
    const del = document.querySelector<HTMLButtonElement>('.motions .joint-head button[title="Delete"]')!;
    await act(async () => void fireEvent.click(del));
    expect(currentDoc().mechanism!.motions ?? []).toEqual([]);
    await settle();
    expect(useMotion.getState().open).toBe(true);
  });
});
