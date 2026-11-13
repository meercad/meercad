/**
 * The joint form in the joints panel (MotionPanel.tsx) with the real kernel: a joint turning about
 * Z gets limits from 0° to 45°, becomes a turn-and-slide joint with its slide limited to 0–5 mm, is
 * named and saved; it hangs on the ground; a fixed joint has no limits; Cancel keeps nothing. Each
 * saved value is read back from the design.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { openForCheck, useMotion } from "../lib/mechanism";
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
  { id: "arm", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const typeInto = async (label: string, n: number, value: string) => {
  const input = screen.getAllByText(label)[n]!.parentElement!.querySelector("input")!;
  await act(async () => void fireEvent.change(input, { target: { value } }));
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
  await act(async () => void fireEvent.blur(input));
};
const draft = () => useMotion.getState().draft!.joint;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Joint form");
  apply({ type: "add_features", features: design });
  await rebuilt();
  await act(async () => openForCheck());
  renderUi(<MotionPanel />);
  await settle();
});
afterAll(cleanup);

describe("the joint form", () => {
  it("sets limits, the slide's limits, a name and the ground, and saves", async () => {
    await act(async () => useMotion.setState({ draft: { joint: { id: "j1", type: "revolute", a: "arm", b: "base", anchor: { axis: { ref: "origin.X" } } }, isNew: true, field: null } }));
    await settle();
    await act(async () => void fireEvent.click(screen.getByText("Z")));
    expect(draft().anchor).toEqual({ axis: { ref: "origin.Z" } });
    await act(async () => void fireEvent.click(screen.getByText("Ground (stays put)")));
    expect(draft().b).toBe("ground");
    await act(async () => void fireEvent.click(screen.getByRole("checkbox", { name: /Limit/ })));
    expect(draft().limits).toEqual([0, 90]);
    await typeInto("To", 0, "45");
    expect(draft().limits).toEqual([0, 45]);
    // Turn and slide: its slide gets limits of its own.
    const cyl = [...document.querySelectorAll("button")].find((b) => /cylindrical|Turn and slide|Turn \+ slide/i.test(`${b.title} ${b.textContent}`))!;
    await act(async () => void fireEvent.click(cyl));
    expect(draft().type).toBe("cylindrical");
    await act(async () => void fireEvent.click(screen.getByRole("checkbox", { name: /Limits of the slide/ })));
    expect(draft().travel).toEqual([0, 20]);
    await typeInto("To", 1, "5");
    await typeInto("From", 1, "1");
    expect(draft().travel).toEqual([1, 5]);
    const name = screen.getByPlaceholderText("j1");
    await act(async () => void fireEvent.change(name, { target: { value: "Hinge" } }));
    expect(draft().name).toBe("Hinge");
    await act(async () => void fireEvent.click(screen.getByTitle("Save joint")));
    await settle(50);
    const saved = currentDoc().mechanism!.joints.find((x) => x.id === "j1")!;
    expect(saved).toMatchObject({ type: "cylindrical", b: "ground", name: "Hinge", limits: [0, 45], travel: [1, 5] });
  });

  it("has no limits when fixed, and keeps nothing on Cancel", async () => {
    await act(async () => useMotion.setState({ draft: { joint: { id: "j2", type: "slider", a: "arm", b: "base", anchor: { axis: { ref: "origin.Y" } }, limits: [0, 10] }, isNew: true, field: null } }));
    await settle();
    const fixed = [...document.querySelectorAll(".segmented button")].find((b) => /^Fixed$|^Fest$/i.test(b.textContent ?? ""))!;
    await act(async () => void fireEvent.click(fixed));
    expect(draft().type).toBe("fixed");
    expect(draft().limits).toBeUndefined();
    await act(async () => void fireEvent.click(screen.getByTitle("Cancel")));
    expect(useMotion.getState().draft).toBeNull();
    expect(currentDoc().mechanism!.joints.some((x) => x.id === "j2")).toBe(false);
  });
});
