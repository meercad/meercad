/**
 * Every tool that needs no pick, accepted in the step dialog with its defaults, builds in the real
 * kernel without an error (slow: every one is built; vitest project web-slow).
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
  // A block from the sketch: the tools that take a profile find none left and wait for a pick.
  apply({ type: "add_features", features: [{ id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(40, 20), constraints: [] } as Feature, { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" } as Feature] });
});
afterEach(() => {
  cancelDialog();
  cleanup();
});

describe("the step dialog", () => {
  it("adds every tool that needs no pick and builds it", async () => {
    renderUi(<FeatureDialog />);
    const ready = TOOLBAR.filter((op) => op !== "sketch" && op !== "plane").filter((op) => {
      startFeature(op);
      const ok = draftProblem(useApp.getState().dialog!.feature) === null;
      cancelDialog();
      return ok;
    });
    expect(ready.length).toBeGreaterThan(8);
    for (const op of ready) {
      await act(async () => startFeature(op));
      await act(async () => void expect(commitDialog(), op).toBe(true));
    }
    await rebuilt();
    const failed = useApp.getState().output!.report.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`);
    expect(failed).toEqual([]);
  });

});
