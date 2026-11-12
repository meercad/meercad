/**
 * More step dialog fields (FeatureDialog.tsx) and the numbers they say: a hole for an M3 heat-set
 * insert is Ø4 for an insert Ø4.6 outside with 1.6 mm of wall around it, and comes in 5.7, 4 and 3 mm
 * lengths (a short one chosen and back); holes are placed and removed by their coordinates; a
 * screw's matching nut stands beside it with the same thread, three diameters away.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, cancelDialog, currentDoc, newProject, rebuildNow, startFeature, updateDraft, useApp } from "../store";
import { renderUi } from "../../test/ui";
import { FeatureDialog } from "./FeatureDialog";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 40, y: 0 },
  { id: "p3", type: "point", x: 40, y: 20 },
  { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const draft = <T,>() => useApp.getState().dialog!.feature as T;
const text = () => document.body.textContent ?? "";

beforeAll(async () => {
  await newProject(undefined, "Fields");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  ] as Feature[] });
  await rebuildNow();
  renderUi(<FeatureDialog />);
});
afterAll(async () => {
  await act(async () => cancelDialog());
  cleanup();
});

describe("a hole for a heat-set insert", () => {
  it("says the hole, the insert's outside and the wall it needs, and offers its lengths", async () => {
    await act(async () => startFeature("hole"));
    await act(async () => updateDraft({ kind: "insert", size: "M3", plane: { face: { face: "ex1.end_cap" } }, points: [[10, 10]] } as Partial<Feature>));
    expect(text()).toMatch(/M3×5\.7 insert: hole Ø4, insert Ø4\.6 outside, keep at least 1\.6 mm of wall around it/);
    const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) => [...s.options].some((o) => /\(standard\)/.test(o.textContent ?? "")))!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["5.7 mm (standard)", "4 mm (short)", "3 mm (short)"]);
    await act(async () => void fireEvent.change(select, { target: { value: "4" } }));
    expect(draft<{ length?: number }>().length).toBe(4);
    expect(text()).toMatch(/M3×4 insert: hole Ø4/);
    await act(async () => void fireEvent.change(select, { target: { value: "5.7" } }));
    expect(draft<{ length?: number }>().length).toBeUndefined();
  });

  it("places and removes holes by their coordinates", async () => {
    await act(async () => updateDraft({ points: [[10, 10], [30, 10]] } as Partial<Feature>));
    expect(screen.getByText("Holes (2)")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getAllByTitle("Remove").at(-1)!));
    expect(draft<{ points: unknown[] }>().points).toEqual([[10, 10]]);
    await act(async () => cancelDialog());
  });
});

describe("a screw and its nut", () => {
  it("puts the matching nut beside the screw, with the same thread", async () => {
    await act(async () => startFeature("screw"));
    await act(async () => updateDraft({ diameter: 8, pitch: 1.25, center: [5, 7] } as Partial<Feature>));
    await act(async () => void fireEvent.click(screen.getByText("Add matching nut")));
    const screw = currentDoc().features.at(-1) as Extract<Feature, { op: "screw" }>;
    expect(screw).toMatchObject({ op: "screw", diameter: 8, pitch: 1.25 });
    const nut = draft<Extract<Feature, { op: "screw" }>>();
    expect(nut).toMatchObject({ op: "screw", kind: "nut", head: "hex", diameter: 8, pitch: 1.25, center: [5 + 3 * 8, 7] });
    await act(async () => cancelDialog());
  });
});
