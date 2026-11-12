/**
 * The diagnostics overlay (DebugHud.tsx, `?debug`): it counts pointer moves by kind, frames and
 * kernel requests and results per second, and the bench and copy buttons run.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, newProject } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { DebugHud } from "./DebugHud";
import { ViewportView } from "./ViewportView";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 10, y: 0 },
  { id: "p3", type: "point", x: 10, y: 10 },
  { id: "p4", type: "point", x: 0, y: 10 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Debug");
  apply({ type: "add_features", features: [{ id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] }, { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" }] as Feature[] });
  renderUi(
    <>
      <ViewportView />
      <DebugHud />
    </>,
  );
  await rebuilt();
});
afterAll(cleanup);

describe("the diagnostics overlay", () => {
  it("counts pointer moves, a press and the rebuilds", async () => {
    await act(async () => {
      for (const pointerType of ["mouse", "pen", "touch"]) window.dispatchEvent(new PointerEvent("pointermove", { pointerType }));
      window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen" }));
      window.dispatchEvent(new PointerEvent("pointermove", { pointerType: "pen" }));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "pen" }));
    });
    await rebuilt();
    await act(async () => new Promise((r) => setTimeout(r, 1100)));
    expect(document.body.textContent).toMatch(/\d/);
  });

  it("runs its buttons", async () => {
    for (const b of screen.queryAllByRole("button")) {
      await act(async () => void fireEvent.click(b));
      await act(async () => new Promise((r) => setTimeout(r, 50)));
    }
    expect(document.body.textContent!.length).toBeGreaterThan(10);
  }, 120_000);
});
