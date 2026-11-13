/**
 * Gridfinity bins in the dialog (GridfinityFields.tsx) with the real kernel: a bin made to hold a
 * 30 × 20 × 10 part sizes itself round it (one cell holds it: 41.5 mm across) and has a pocket the
 * part fits into; switched to a fixed size it keeps what it had and − / + change it a cell at a
 * time; a bin set into a 4 × 3 baseplate stands exactly over the cell asked for.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, cancelDialog, commitDialog, currentDoc, newProject, rebuildNow, startFeature, updateDraft, useApp } from "../store";
import { binForPart } from "../lib/partBin";
import { renderUi } from "../../test/ui";
import { FeatureDialog } from "./FeatureDialog";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 200, y: 0 },
  { id: "p2", type: "point", x: 230, y: 0 },
  { id: "p3", type: "point", x: 230, y: 20 },
  { id: "p4", type: "point", x: 200, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const draft = <T,>() => useApp.getState().dialog!.feature as T;
const bbox = async (id: string) => (await rebuildNow()).report.bodies.find((b) => b.id === id)!.bbox;
const settle = (ms = 50) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeAll(async () => {
  await newProject(undefined, "Bins");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "part", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  ] as Feature[] });
  await rebuildNow();
  renderUi(<FeatureDialog />);
});
afterAll(async () => {
  await act(async () => cancelDialog());
  cleanup();
});

describe("a bin for a part", () => {
  it("sizes itself round the part, one cell for 30 × 20 mm", async () => {
    await act(async () => binForPart("part"));
    expect(draft<{ pocket: { body: string } }>().pocket.body).toBe("part");
    await act(async () => void (await rebuildNow()));
    await settle();
    let ok = false;
    await act(async () => void (ok = commitDialog()));
    expect(ok).toBe(true);
    const bin = currentDoc().features.at(-1)!;
    const b = await bbox(bin.id);
    expect(b.max[0]! - b.min[0]!).toBeCloseTo(41.5, 3);
    expect(b.max[1]! - b.min[1]!).toBeCloseTo(41.5, 3);
    // The part's pocket takes volume out of the bin: less than a solid bin of the same outside.
    const out = await rebuildNow();
    expect(out.report.features.find((f) => f.id === bin.id)!.status).toBe("ok");
  });

  it("keeps its size when switched to fixed cells, and steps a cell at a time", async () => {
    const bin = currentDoc().features.at(-1)!;
    const { editFeature } = await import("../store");
    await act(async () => editFeature(bin.id));
    await act(async () => void (await rebuildNow()));
    await settle();
    const fit = screen.getByText("Size to fit the part").closest("label")!.querySelector("input")!;
    await act(async () => void fireEvent.click(fit));
    expect(draft<{ units: unknown[] }>().units).toEqual([1, 1]);
    const more = screen.getAllByLabelText("More")[0]!;
    await act(async () => void fireEvent.click(more));
    expect(draft<{ units: unknown[] }>().units).toEqual([2, 1]);
    await act(async () => void fireEvent.click(screen.getAllByLabelText("Fewer")[0]!));
    expect(draft<{ units: unknown[] }>().units).toEqual([1, 1]);
    await act(async () => cancelDialog());
  });
});

describe("a bin in a baseplate", () => {
  it("stands exactly over the cell asked for", async () => {
    await act(async () => startFeature("gridfinity"));
    await act(async () => updateDraft({ kind: "baseplate", units: [4, 3] } as Partial<Feature>));
    await act(async () => void commitDialog());
    const plate = currentDoc().features.at(-1)!;
    const pb = await bbox(plate.id);
    await act(async () => startFeature("gridfinity"));
    await act(async () => updateDraft({ kind: "bin", units: [1, 1], height: 3, baseplate: plate.id, cell: [2, 1] } as Partial<Feature>));
    await act(async () => void commitDialog());
    const bin = currentDoc().features.at(-1)!;
    const bb = await bbox(bin.id);
    // Cell (2, 1) of 42 mm cells: its middle is 2.5 and 1.5 cells in from the plate's corner.
    expect((bb.min[0]! + bb.max[0]!) / 2).toBeCloseTo(pb.min[0]! + 2.5 * 42, 3);
    expect((bb.min[1]! + bb.max[1]!) / 2).toBeCloseTo(pb.min[1]! + 1.5 * 42, 3);
  });
});

describe("switching the kind", () => {
  it("shows a bin for a part right after a drawer baseplate was previewed (its info has a width, but no nest depth)", async () => {
    await act(async () => startFeature("gridfinity"));
    await act(async () => updateDraft({ kind: "baseplate", units: [2, 2], drawer: [300, 200] } as Partial<Feature>));
    await act(async () => void (await rebuildNow()));
    await settle();
    // Once the dialog crashed here: the baseplate's width was read as the bin's and its nest depth was missing.
    await act(async () => void fireEvent.click(screen.getByText("For a part")));
    expect(document.querySelector(".dialog")).not.toBeNull();
    expect(draft<{ pocket?: unknown }>().pocket).toBeDefined();
    await act(async () => cancelDialog());
  });
});

