/**
 * The step dialog's fields for the kinds a tool's first look does not show (FeatureDialog.tsx and
 * its field groups): a Gridfinity baseplate filling a drawer, an outline or a print bed, a bin set
 * into a baseplate, a bin round a part, a label; wall boards and holders; boxes with lids and
 * hinges. Each starts from such a draft, every control in it is used once, and the draft stays a
 * step the dialog can show.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, FeatureOp, SketchEntity } from "@meercad/schema";
import { apply, cancelDialog, newProject, startFeature, updateDraft, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { FeatureDialog } from "./FeatureDialog";

const rect = (w: number, h: number, x = 0): SketchEntity[] => [
  { id: "p1", type: "point", x, y: 0 },
  { id: "p2", type: "point", x: x + w, y: 0 },
  { id: "p3", type: "point", x: x + w, y: h },
  { id: "p4", type: "point", x, y: h },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const settle = () => act(async () => new Promise((r) => setTimeout(r, 5)));

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Variants");
  apply({
    type: "add_features",
    features: [
      { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(40, 20), constraints: [] } as Feature,
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" } as Feature,
      { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(200, 150, 100), constraints: [] } as Feature,
      { id: "bp1", op: "gridfinity", kind: "baseplate", units: [3, 2] } as Feature,
      { id: "wl1", op: "wall", system: "opengrid", kind: "board", units: [3, 3] } as Feature,
    ],
  });
  await rebuilt();
});
afterAll(cleanup);

/**
 * Every control in the dialog once (a number typed into each value, each choice, each switch), from
 * the bottom up: the examples and the kind at the top would otherwise turn the draft into another
 * kind before its own fields were used.
 */
async function useEveryControl(op: FeatureOp, draft: Record<string, unknown>) {
  renderUi(<FeatureDialog />);
  const open = async () => {
    await act(async () => startFeature(op));
    await act(async () => updateDraft(draft as Partial<Feature>));
  };
  await open();
  const dialog = () => document.querySelector(".dialog");
  expect(dialog(), op).not.toBeNull();
  const used = new Set<Element>();
  for (let round = 0; round < 3; round++) {
    const controls = [...dialog()!.querySelectorAll<HTMLElement>(".dialog-body input, .dialog-body select, .dialog-body textarea, .dialog-body button, .dialog-body [role=button]")].filter((c) => !used.has(c)).reverse();
    if (!controls.length) break;
    for (const c of controls) {
      used.add(c);
      if (!dialog()?.contains(c)) continue;
      if (c instanceof HTMLSelectElement) {
        for (const o of [...c.options].filter((x) => !x.disabled)) await act(async () => void fireEvent.change(c, { target: { value: o.value } }));
      } else if (c instanceof HTMLTextAreaElement) {
        await act(async () => void fireEvent.change(c, { target: { value: "AB" } }));
      } else if (c instanceof HTMLInputElement) {
        if (c.type === "checkbox" || c.type === "radio") {
          await act(async () => void fireEvent.click(c));
          if (dialog()?.contains(c)) await act(async () => void fireEvent.click(c));
        } else if (c.type === "file" || c.type === "color") continue;
        else {
          await act(async () => void fireEvent.change(c, { target: { value: c.type === "range" ? c.max || "1" : "3" } }));
          await act(async () => void fireEvent.keyDown(c, { key: "Enter" }));
          await act(async () => void fireEvent.blur(c));
        }
      } else await act(async () => void fireEvent.click(c));
      await settle();
      if (!useApp.getState().dialog) await open();
    }
  }
  expect(useApp.getState().dialog?.feature.op).toBe(op);
  await act(async () => cancelDialog());
  cleanup();
}

describe("dialog fields of the other kinds", () => {
  const cases: [string, FeatureOp, Record<string, unknown>][] = [
    ["a baseplate for a drawer, cut for the bed", "gridfinity", { kind: "baseplate", units: [3, 2], drawer: [300, 200], bed: { size: [256, 256], margin: [0, 10] } }],
    ["a baseplate for an outline", "gridfinity", { kind: "baseplate", units: [3, 2], outline: { sketch: "sk2" }, gap: 1 }],
    ["a baseplate with magnets and screws", "gridfinity", { kind: "baseplate", units: [2, 2], magnets: true, screws: true }],
    ["a bin in a baseplate cell", "gridfinity", { kind: "bin", units: [1, 1], height: 3, baseplate: "bp1", cell: [1, 1], tab: { style: "left" }, scoop: 8, dividers: [2, 1] }],
    ["a bin round a part", "gridfinity", { kind: "bin", units: [1, 1], height: 3, pocket: { body: "ex1", sink: 60, clearance: 0.5 } }],
    ["a label", "gridfinity", { kind: "label", text: "M3" }],
    ["a wall holder on a board", "wall", { system: "opengrid", kind: "holder", units: [1, 1], board: "wl1", accessory: "hook" }],
    ["a pegboard", "wall", { system: "pegboard", kind: "board", units: [3, 3] }],
    ["a split with dovetails", "split", { plane: { ref: "origin.YZ" }, bodies: ["ex1"], connectors: { kind: "dovetail", size: 6, depth: 4, slide: "short" } }],
    ["a split with dowels", "split", { plane: { ref: "origin.YZ" }, bodies: ["ex1"], connectors: { kind: "dowels", size: 4, count: 2 } }],
    ["a tapped hole and an insert hole", "hole", { kind: "tapped", size: "M4", plane: { face: { face: "ex1.end_cap" } }, points: [[10, 10], [30, 10]], depth: 5 }],
    ["an insert hole", "hole", { kind: "insert", size: "M3", fit: "loose", plane: { face: { face: "ex1.end_cap" } }, points: [[10, 10]], withInserts: true }],
    ["an internal gear and a rack", "gear", { kind: "internal", module: 2, teeth: 30, width: 6, rim: 6, herringbone: true, helix: 20 }],
    ["a rack", "gear", { kind: "rack", module: 2, teeth: 10, width: 6, rim: 4, center: [5, 5] }],
    ["a gear with a flatted bore", "gear", { kind: "spur", module: 2, teeth: 20, width: 6, bore: { diameter: 6, flat: 5 } }],
    ["an extension spring", "spring", { kind: "extension", wire: 1, diameter: 10, length: 30, ends: "hooks" }],
    ["inserts and rails", "standard_part", { kind: "insert", size: "M3", plane: { face: { face: "ex1.end_cap" } }, points: [[10, 10], [20, 10]], withMoving: true }],
    ["a rail", "standard_part", { kind: "rail", size: "MGN12", length: 200, angle: 30, plane: { face: { face: "ex1.end_cap" } }, points: [[10, 10]] }],
    ["a shaft", "standard_part", { kind: "shaft", size: "8", length: 100, plane: { face: { face: "ex1.end_cap" } }, points: [[10, 10]] }],
    ["a cylinder primitive along X", "primitive", { shape: "cylinder", diameter: 10, height: 20, axis: "X" }],
    ["a box primitive", "primitive", { shape: "box", size: [10, 20, 30] }],
    ["wrapping a part round a cylinder", "bend", { mode: "wrap", bodies: ["ex1"], radius: 20 }],
    ["rolling a part into a spiral", "bend", { mode: "spiral", bodies: ["ex1"], radius: 10, gap: 1 }],
    ["a two-sided extrude", "extrude", { profile: { sketch: "sk1" }, extent: "two_sided", distance: 5, distance2: 3, flip: true }],
    ["a thread on a shaft", "thread", { faces: [{ face: "ex1.end_cap" }], size: "M8", threadLength: 6 }],
    ["moving a face up to another", "offset_face", { faces: [{ face: "ex1.end_cap" }], distance: 2, upTo: { face: { face: "ex1.start_cap" } } }],
    ["a mesh convert", "mesh_convert", { body: "ex1", tolerance: 0.2, angle: 25 }],
  ];
  for (const [name, op, draft] of cases) it(name, async () => useEveryControl(op, draft), 120_000);
});
