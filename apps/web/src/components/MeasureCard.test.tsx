/**
 * The Measure card in the 3D view (ViewportView.tsx): it says what to click; with shapes fitted on a
 * scan it offers their tolerance, and a typed tolerance is taken only when it is a positive number;
 * its × ends measuring.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newProject, rebuildNow, useApp } from "../store";
import { useScanMeasure } from "../lib/scanMeasure";
import { renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Measure card");
  await rebuildNow();
  renderUi(<ViewportView />);
  await act(async () => useApp.setState({ measure: { active: true, picks: [], result: null } }));
});
afterAll(() => {
  useScanMeasure.setState({ shapes: [], tol: 0.1 });
  cleanup();
});

describe("the Measure card", () => {
  it("takes a positive fit tolerance for scan shapes, and its × ends measuring", async () => {
    expect(screen.getByText(/Click a face or an edge/)).toBeTruthy();
    await act(async () => useScanMeasure.setState({ shapes: [{ bodyId: "none", shape: { kind: "plane", triangles: [] } as never }] }));
    const tol = document.querySelector<HTMLInputElement>(".measure-card input[type=number]")!;
    await act(async () => void fireEvent.change(tol, { target: { value: "0.3" } }));
    expect(useScanMeasure.getState().tol).toBe(0.3);
    await act(async () => void fireEvent.change(tol, { target: { value: "-1" } }));
    expect(useScanMeasure.getState().tol).toBe(0.3);
    await act(async () => void fireEvent.click(document.querySelector(".measure-card .icon-btn")!));
    expect(useApp.getState().measure.active).toBe(false);
    expect(document.querySelector(".measure-card")).toBeNull();
  });

  it("shows an assistant's activity and dismisses a preview", async () => {
    await act(async () => useApp.setState({ aiActivity: { client: "Claude", tool: "apply_ops" } as never, proposalDoc: useApp.getState().doc }));
    expect(document.querySelector(".ai-activity")!.textContent).toMatch(/Claude/);
    await act(async () => void fireEvent.click(screen.getByText("Dismiss")));
    expect(useApp.getState().proposalDoc).toBeNull();
    await act(async () => useApp.setState({ aiActivity: null }));
    expect(document.querySelector(".ai-activity")).toBeNull();
  });
});
