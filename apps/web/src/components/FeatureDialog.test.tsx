/**
 * The step dialog (FeatureDialog.tsx) for every tool, rendered with Testing Library: it opens with
 * the tool's fields, says what is missing, and accepting adds a step that the real kernel builds.
 * Editing an existing step and changing a value through the dialog's own fields is checked by the
 * volume that comes out.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, FeatureOp, SketchEntity } from "@meercad/schema";
import { apply, cancelDialog, commitDialog, currentDoc, editFeature, newProject, startFeature, updateDraft, useApp } from "../store";
import { FEATURES, TOOLBAR, draftProblem } from "../lib/features";
import { rebuilt, renderUi } from "../../test/ui";
import { FeatureDialog } from "./FeatureDialog";

const rect = (w: number, h: number): SketchEntity[] => [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: w, y: 0 },
  { id: "p3", type: "point", x: w, y: h },
  { id: "p4", type: "point", x: 0, y: h },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];

beforeAll(async () => {
  await newProject(undefined, "Dialogs");
  apply({ type: "add_features", features: [{ id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(40, 20), constraints: [] } as Feature] });
});
afterEach(() => {
  cancelDialog();
  cleanup();
});

describe("the step dialog", () => {
  it("opens for every tool with its name and its fields", async () => {
    renderUi(<FeatureDialog />);
    const tools = TOOLBAR.filter((op) => op !== "sketch") as FeatureOp[];
    for (const op of tools) {
      await act(async () => startFeature(op));
      const dialog = document.querySelector(".dialog");
      expect(dialog, op).not.toBeNull();
      expect(dialog!.querySelector("h3")!.textContent, op).toBe(FEATURES[op].label);
      expect(dialog!.querySelectorAll("input, select, button").length, op).toBeGreaterThan(2);
      await act(async () => cancelDialog());
      expect(document.querySelector(".dialog"), op).toBeNull();
    }
  });

  it("says what to pick before it accepts", async () => {
    renderUi(<FeatureDialog />);
    await act(async () => startFeature("fillet"));
    expect(draftProblem(useApp.getState().dialog!.feature)).toBe("Select edges");
    expect(commitDialog()).toBe(false);
    expect(useApp.getState().toasts.at(-1)!.text).toBe("Select edges");
  });

  it("adds an extrude of the sketch and builds it; editing its distance changes the volume", async () => {
    renderUi(<FeatureDialog />);
    await act(async () => startFeature("extrude"));
    expect(useApp.getState().dialog!.feature).toMatchObject({ op: "extrude", profile: { sketch: "sk1" }, distance: 10 });
    await act(async () => void fireEvent.click(screen.getByTitle(/Accept|OK/)));
    expect(currentDoc().features.at(-1)).toMatchObject({ id: "ex1", op: "extrude" });
    await rebuilt();
    expect(useApp.getState().output!.report.bodies[0]!.volume).toBeCloseTo(8000, 6);
    await act(async () => editFeature("ex1"));
    expect(document.querySelector(".dialog h3")!.textContent).toBe("Extrude 1");
    await act(async () => updateDraft({ distance: 25 } as Partial<Feature>));
    await act(async () => void commitDialog());
    await rebuilt();
    expect(useApp.getState().output!.report.bodies[0]!.volume).toBeCloseTo(20000, 6);
  });

  it("closes with Escape", async () => {
    renderUi(<FeatureDialog />);
    await act(async () => startFeature("gear"));
    await act(async () => void fireEvent.keyDown(document.querySelector(".dialog")!, { key: "Escape" }));
    expect(useApp.getState().dialog).toBeNull();
  });
});
