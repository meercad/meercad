/**
 * The expression field (ExprInput.tsx): arrow keys nudge a number by 1, Shift by 10, Alt by 0.1, and
 * an inch length by 1/8 in (Shift 1 in, Alt 1/64 in), whole numbers by 1; Escape puts the value back;
 * an expression that does not evaluate is marked and not taken; typing previews valid values only.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Expr } from "@meercad/schema";
import { newProject, setDesignUnits } from "../store";
import { ExprInput } from "./ExprInput";

beforeAll(async () => {
  await newProject(undefined, "Expressions");
});
afterEach(cleanup);
afterAll(() => setDesignUnits("mm"));

const field = (props: Partial<Parameters<typeof ExprInput>[0]> = {}) => {
  const got: Expr[] = [];
  const live: Expr[] = [];
  const { container } = render(<ExprInput value={5} onCommit={(e) => got.push(e)} {...(props.onLive === null ? {} : { onLive: (e) => live.push(e) })} {...props} />);
  return { input: container.querySelector("input")!, container, got, live };
};
const key = (el: HTMLElement, k: string, mods: Record<string, boolean> = {}) => act(async () => void fireEvent.keyDown(el, { key: k, ...mods }));

describe("the expression field", () => {
  it("nudges numbers with the arrow keys", async () => {
    const { input, live } = field({ unit: "deg" });
    await key(input, "ArrowUp");
    await key(input, "ArrowUp", { shiftKey: true });
    await key(input, "ArrowDown", { altKey: true });
    expect(live).toEqual([6, 16, 15.9]);
    await act(async () => void fireEvent.change(input, { target: { value: "30 deg" } }));
    await key(input, "ArrowDown");
    expect(live.at(-1)).toBe("29 deg");
  });

  it("nudges whole numbers by one, and commits when there is no live preview", async () => {
    const got: Expr[] = [];
    const { container } = render(<ExprInput value={3} unit="" integer onCommit={(e) => got.push(e)} />);
    const input = container.querySelector("input")!;
    await key(input, "ArrowUp", { shiftKey: true });
    expect(got).toEqual([4]);
  });

  it("nudges inch lengths in eighths, inches and sixty-fourths", async () => {
    await act(async () => setDesignUnits("in"));
    const { input, live } = field({ value: 25.4 });
    expect(input.value).toBe("1");
    await key(input, "ArrowUp");
    await key(input, "ArrowUp", { shiftKey: true });
    await key(input, "ArrowUp", { altKey: true });
    expect(live).toEqual(["1.125 in", "2.125 in", "2.1406 in"]);
    await act(async () => setDesignUnits("mm"));
  });

  it("marks what does not evaluate and does not take it; Escape puts the value back", async () => {
    const { input, container, got, live } = field({ unit: "" });
    await act(async () => void fireEvent.change(input, { target: { value: "2 *" } }));
    expect(input.className).toContain("invalid");
    expect(live).toEqual([]);
    await key(input, "Enter");
    expect(got).toEqual([]);
    expect(input.value).toBe("5");
    await act(async () => void fireEvent.change(input, { target: { value: "2 * 4" } }));
    expect(live).toEqual(["2 * 4"]);
    expect(container.querySelector(".computed")!.textContent).toBe("= 8");
    await key(input, "Escape");
    expect(input.value).toBe("5");
  });
});
