/**
 * The technical drawing (DrawingDialog.tsx), the parts other tests leave: with nothing to draw it
 * says so; a drawing the kernel cannot make says why; two parts offer the parts list on the sheet;
 * the close button and a press beside the dialog close it.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, kernel, newProject, rebuildNow } from "../store";
import { renderUi } from "../../test/ui";
import { DrawingDialog, openDrawing } from "./DrawingDialog";

const square = (x: number): SketchEntity[] => [
  { id: "p1", type: "point", x, y: 0 },
  { id: "p2", type: "point", x: x + 10, y: 0 },
  { id: "p3", type: "point", x: x + 10, y: 10 },
  { id: "p4", type: "point", x, y: 10 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const settle = (ms = 100) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeAll(async () => {
  await newProject(undefined, "Drawing more");
  await rebuildNow();
  renderUi(<DrawingDialog />);
});
afterAll(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the technical drawing", () => {
  it("says when there is nothing to draw, and why the kernel could not", async () => {
    await act(async () => openDrawing());
    await settle();
    expect(screen.getByText("There is no part to draw yet.")).toBeTruthy();
    const drawing = vi.spyOn(kernel, "drawing").mockRejectedValue(new Error("no views today"));
    await act(async () => {
      apply({ type: "add_features", features: [
        { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: square(0), constraints: [] },
        { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
      ] as Feature[] });
      await rebuildNow();
    });
    await settle();
    expect(document.querySelector(".drawing-dialog")!.textContent).toContain("no views today");
    drawing.mockRestore();
  });

  it("offers the parts list for two parts", async () => {
    await act(async () => {
      apply({ type: "add_features", features: [
        { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: square(30), constraints: [] },
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 5, mode: "new_body" },
      ] as Feature[] });
      await rebuildNow();
    });
    await settle(500);
    const box = screen.getByText(/Parts list on the sheet \(2 lines\)/).querySelector("input") ?? screen.getByText(/Parts list on the sheet/).closest("label")!.querySelector("input")!;
    const was = box.checked;
    await act(async () => void fireEvent.click(box));
    expect(box.checked).toBe(!was);
  });

  it("closes by its button and by a press beside it", async () => {
    await act(async () => void fireEvent.pointerDown(screen.getByRole("dialog")));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => void fireEvent.click(screen.getByTitle("Close (Esc)")));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => openDrawing());
    await act(async () => void fireEvent.pointerDown(document.querySelector(".modal-backdrop")!));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
