/**
 * Wall board fields (WallFields.tsx), the controls other tests leave: an openGrid board's thickness
 * and screw holes, and a screw holder's screw diameter.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newProject } from "../store";
import { WallFields } from "./WallFields";

beforeAll(async () => {
  await newProject(undefined, "Wall fields");
});
afterEach(cleanup);

describe("wall board fields", () => {
  it("sets an openGrid board's thickness and screw holes", async () => {
    const set = vi.fn();
    render(<WallFields f={{ id: "wa1", op: "wall", system: "opengrid", kind: "board", units: [4, 4] } as never} set={set} />);
    await act(async () => void fireEvent.click(screen.getByText("Lite (4 mm)")));
    expect(set).toHaveBeenLastCalledWith({ variant: "lite" });
    await act(async () => void fireEvent.click(screen.getByText("Full (6.8 mm)")));
    expect(set).toHaveBeenLastCalledWith({ variant: undefined });
    await act(async () => void fireEvent.click(screen.getByText(/Screw holes next to the corners/).querySelector("input") ?? screen.getByRole("checkbox", { name: /Screw holes/ })));
    expect(set).toHaveBeenLastCalledWith({ screws: true });
  });

  it("sets a screw holder's diameter", async () => {
    const set = vi.fn();
    render(<WallFields f={{ id: "wa2", op: "wall", system: "opengrid", kind: "holder", accessory: "screw", units: [1, 1] } as never} set={set} />);
    const field = screen.getByText("Screw diameter").closest(".field-row, label, div")!.querySelector("input")!;
    await act(async () => void fireEvent.change(field, { target: { value: "5" } }));
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }));
    expect(set).toHaveBeenLastCalledWith({ size: 5 });
  });
});
