/**
 * The slider with its typed value (SliderValue.tsx): a number, a variable's value or, for an
 * expression that does not work out, the fallback sets the slider; moving it gives a number.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Expr } from "@meercad/schema";
import { apply, newProject, rebuildNow } from "../store";
import { SliderValue } from "./SliderValue";

beforeAll(async () => {
  await newProject(undefined, "Slider");
  apply({ type: "set_param", name: "h", expr: 12 });
  await rebuildNow();
});
afterEach(cleanup);

const slider = (value: Expr | undefined, got: (Expr | undefined)[] = []) => render(<SliderValue value={value} fallback={5} min={0} max={20} step={0.5} unit="" onChange={(v) => got.push(v)} />).container.querySelector<HTMLInputElement>("input[type=range]")!;

describe("the slider", () => {
  it("stands at a number, a variable's value, or the fallback", () => {
    expect(slider(8).value).toBe("8");
    cleanup();
    expect(slider("h + 2").value).toBe("14");
    cleanup();
    expect(slider("nope * 2").value).toBe("5");
    cleanup();
    expect(slider(undefined).value).toBe("5");
  });

  it("gives a number when moved", async () => {
    const got: (Expr | undefined)[] = [];
    const s = slider(8, got);
    await act(async () => void fireEvent.pointerDown(s));
    await act(async () => void fireEvent.change(s, { target: { value: "9.5" } }));
    await act(async () => void fireEvent.pointerUp(s));
    expect(got).toEqual([9.5]);
  });
});
