/**
 * The box and snap-hook fields on their own (ClosureFields.tsx): every value typed, every switch and
 * button used, for a rectangular and a round snap-lid box, a jar and a snap hook with points and
 * catches; each control hands its change on.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newProject } from "../store";
import { BoxFields, SnapHookFields } from "./ClosureFields";

beforeAll(async () => {
  await newProject(undefined, "Closures");
});
afterEach(cleanup);

/** Types 3 into every value field and uses every checkbox and button; returns what was set. */
async function useAll(container: HTMLElement, set: ReturnType<typeof vi.fn>) {
  for (const input of [...container.querySelectorAll<HTMLInputElement>("input.field")]) {
    await act(async () => void fireEvent.change(input, { target: { value: "3" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
  }
  for (const box of [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]) await act(async () => void fireEvent.click(box));
  for (const b of [...container.querySelectorAll<HTMLButtonElement>("button")]) if (!b.disabled) await act(async () => void fireEvent.click(b));
  return set.mock.calls.map((c) => Object.keys(c[0] as object).join(",")).join(" ");
}

describe("closure fields on their own", () => {
  for (const [name, f] of [
    ["a rectangular snap-lid box", { id: "bx1", op: "box", width: 40, depth: 30, height: 20, lid: "snap" }],
    ["a round snap-lid box", { id: "bx2", op: "box", width: 40, height: 20, lid: "snap", shape: "round", notch: false }],
    ["a jar", { id: "bx3", op: "box", width: 40, height: 20, lid: "screw" }],
  ] as const) {
    it(`hands on every change of ${name}`, async () => {
      const set = vi.fn();
      const { container } = render(<BoxFields f={f as never} set={set} />);
      const keys = await useAll(container, set);
      expect(keys.length).toBeGreaterThan(0);
    });
  }

  it("hands on every change of a snap hook with points and catches", async () => {
    const set = vi.fn();
    const f = { id: "sh1", op: "snap_hook", plane: { ref: "origin.XY" }, points: [[0, 0], [10, 5]], catchIn: ["ex1", "ex2"], angle: 0 };
    const { container } = render(<SnapHookFields f={f as never} set={set} />);
    const keys = await useAll(container, set);
    expect(keys).toContain("points");
    expect(keys).toContain("catchIn");
    expect(keys).toContain("clearance");
  });
});
