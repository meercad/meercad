/**
 * The joints panel (MotionPanel.tsx) on a lid and a slider with the real kernel: a slider moves the
 * part, motions are recorded and checked, a joint is drawn up in the panel and saved, the gap
 * check lists the gap between the parts.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, useApp } from "../store";
import { jointValues, openForCheck, restPose, useMotion } from "../lib/mechanism";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
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
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Motion");
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
  );
  await rebuilt();
  await act(async () => openForCheck());
  renderUi(<MotionPanel />);
  await settle();
});
afterAll(cleanup);

describe("the joints panel", () => {
  it("lists the joint and moves the part with its slider", async () => {
    expect(document.body.textContent).toMatch(/Slide/);

    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider).not.toBeNull();
    await act(async () => void fireEvent.change(slider, { target: { value: "-5" } }));
    expect(jointValues()["j1"]).toBe(-5);
    await act(async () => void fireEvent.click(screen.getByTitle("Back to where the parts were drawn")));
    expect(jointValues()["j1"]).toBe(0);
  });

  it("checks the gaps and lists the gap to the base", async () => {
    await act(
      async () =>
        void fireEvent.change(document.querySelector<HTMLInputElement>('input[type="range"]')!, {
          target: { value: "-9" },
        }),
    );

    const btn = screen.getAllByRole("button").find((b) => /gap|clearance|Check/i.test(b.textContent ?? ""))!;
    await act(async () => void fireEvent.click(btn));
    await act(async () => new Promise((r) => setTimeout(r, 300)));

    const check = useMotion.getState().check;
    expect(check?.running).toBe(false);

    // Moved 9 mm back, the cube stands 1 mm from the base's end at x = 40.
    const pair = check!.results.find((c) => [c.a, c.b].sort().join() === "base,cube")!;
    expect(pair.distance).toBeCloseTo(1, 6);
    await act(async () => restPose());
  });

  it("records a motion and plays it", async () => {
    const add = screen.getAllByRole("button").find((b) => /motion/i.test(b.textContent ?? ""))!;
    await act(async () => void fireEvent.click(add));
    await settle();
    expect(currentDoc().mechanism?.motions?.length).toBe(1);

    const m = currentDoc().mechanism!.motions![0]!;
    // Playing runs on animation frames until stopped: started and stopped at once.
    const play = screen.getByTitle("Play the motion");
    fireEvent.click(play);
    expect(useMotion.getState().playingMotion).toBe(m.id);
    fireEvent.click(screen.getByTitle("Stop"));
    expect(useMotion.getState().playingMotion).toBeNull();

    const loop = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1);
    if (loop) await act(async () => void fireEvent.click(loop));

    // Deleting its only moment deletes the motion (it once answered with a schema error).
    await act(async () => void fireEvent.click(screen.getAllByTitle("Delete").at(-1)!));
    expect(currentDoc().mechanism?.motions ?? []).toEqual([]);
    expect(useApp.getState().toasts.filter((t) => t.kind === "error")).toEqual([]);
  });

  it("draws up a joint and saves it", async () => {
    const add = screen
      .getAllByRole("button")
      .find((b) => /joint/i.test(b.textContent ?? "") && !/Hide|Show/.test(b.getAttribute("title") ?? ""))!;
    await act(async () => void fireEvent.click(add));
    await settle();
    expect(useMotion.getState().draft).not.toBeNull();
    await act(async () =>
      useMotion.setState((s) => ({ draft: { ...s.draft!, joint: { ...s.draft!.joint, a: "base" } } })),
    );
    await settle();

    const z = screen.getAllByRole("button").find((b) => b.textContent === "Z");
    if (z) await act(async () => void fireEvent.click(z));

    await act(async () => void fireEvent.click(screen.getByTitle("Save joint")));
    expect(currentDoc().mechanism!.joints.length).toBe(2);
    expect(useApp.getState().toasts.filter((t) => t.kind === "error")).toEqual([]);
  });
});
