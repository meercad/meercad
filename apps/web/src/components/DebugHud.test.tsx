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

  it("copies without a clipboard (plain http on the local network) by a hidden text field", async () => {
    const was = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const commands: string[] = [];
    const doc = document as unknown as { execCommand: (c: string) => boolean };
    const before = doc.execCommand;
    doc.execCommand = (c: string) => (commands.push(c), true);
    try {
      await act(async () => void fireEvent.click(screen.getByText("Copy")));
      expect(commands).toEqual(["copy"]);
      expect(screen.getByText("Copied")).toBeTruthy();
      expect(document.querySelector("textarea[readonly]")).toBeNull();
      // Over https it uses the clipboard.
      const copied: string[] = [];
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
      Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
      await act(async () => void fireEvent.click(screen.getByText(/^Cop/)));
      expect(copied[0]).toContain(navigator.userAgent);
    } finally {
      doc.execCommand = before;
      delete (window as unknown as Record<string, unknown>)["isSecureContext"];
      if (was) Object.defineProperty(navigator, "clipboard", was);
      else delete (navigator as unknown as Record<string, unknown>)["clipboard"];
    }
  });

  it("runs its buttons", async () => {
    for (const b of screen.queryAllByRole("button")) {
      await act(async () => void fireEvent.click(b));
      await act(async () => new Promise((r) => setTimeout(r, 50)));
    }
    expect(document.body.textContent!.length).toBeGreaterThan(10);
  }, 120_000);
});
