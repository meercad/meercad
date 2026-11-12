/**
 * Every field of every tool's step dialog takes a change without an error: on a design with a
 * block, each tool's dialog is opened, every control in it is used once (a number typed into each
 * value, each choice picked, each switch flipped), and the draft stays a step the dialog can show.
 * Slow (vitest project web-slow).
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, FeatureOp, SketchEntity } from "@meercad/schema";
import { apply, cancelDialog, newProject, startFeature, useApp } from "../store";
import { TOOLBAR } from "../lib/features";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
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
const settle = () => act(async () => new Promise((r) => setTimeout(r, 5)));

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Fields");
  apply({
    type: "add_features",
    features: [
      { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(40, 20), constraints: [] } as Feature,
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" } as Feature,
      { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(10, 10).map((e) => (e.type === "point" ? { ...e, x: e.x + 60 } : e)), constraints: [] } as Feature,
    ],
  });
  await rebuilt();
});
afterAll(cleanup);

describe("every dialog field", () => {
  for (const op of TOOLBAR.filter((o) => o !== "sketch") as FeatureOp[]) {
    it(`takes a change in ${op}`, async () => {
      renderUi(<FeatureDialog />);
      await act(async () => startFeature(op));
      const dialog = () => document.querySelector(".dialog");
      expect(dialog(), op).not.toBeNull();
      const used = new Set<Element>();
      for (let round = 0; round < 3; round++) {
        const controls = [...dialog()!.querySelectorAll<HTMLElement>(".dialog-body input, .dialog-body select, .dialog-body button, .dialog-body [role=button]")].filter((c) => !used.has(c));
        if (!controls.length) break;
        for (const c of controls) {
          used.add(c);
          if (!dialog()?.contains(c)) continue;
          if (c instanceof HTMLSelectElement) {
            const options = [...c.options].filter((o) => !o.disabled);
            const pick = options.at(-1) ?? options[0];
            if (pick) await act(async () => void fireEvent.change(c, { target: { value: pick.value } }));
          } else if (c instanceof HTMLInputElement) {
            if (c.type === "checkbox" || c.type === "radio") await act(async () => void fireEvent.click(c));
            else if (c.type === "file" || c.type === "color") continue;
            else {
              await act(async () => void fireEvent.change(c, { target: { value: c.type === "range" ? c.max || "1" : "3" } }));
              await act(async () => void fireEvent.keyDown(c, { key: "Enter" }));
              await act(async () => void fireEvent.blur(c));
            }
          } else await act(async () => void fireEvent.click(c));
          await settle();
          // A field may have closed the dialog (it is reopened) or opened a picker (it is left).
          if (!useApp.getState().dialog) await act(async () => startFeature(op));
        }
      }
      expect(useApp.getState().dialog?.feature.op).toBe(op);
      await act(async () => cancelDialog());
      cleanup();
    }, 60_000);
  }
});
