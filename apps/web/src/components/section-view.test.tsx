/**
 * The section view (SectionBar.tsx, lib/viewSection.ts, the viewport's section): a plane cuts the parts
 * open for viewing, square to X, Y or Z or laid on a face, the other side kept on request, moved with
 * the slider, a typed value or the arrow in the view. What it cuts away cannot be picked, a cut face
 * picks nothing, and the model never changes.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, currentDoc, getViewport, newProject, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import {
  closeSection,
  flipViewSection,
  moveViewSection,
  sectionOnAxis,
  sectionOnPick,
  toggleSection,
  useViewSection,
} from "../lib/viewSection";
import { ViewportView } from "./ViewportView";

const rect = (p: string, x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y },
  { id: `${p}2`, type: "point", x: x + w, y },
  { id: `${p}3`, type: "point", x: x + w, y: y + h },
  { id: `${p}4`, type: "point", x, y: y + h },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
/** A block 40 × 20 × 10 from the origin. */
const design: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 0, 0, 40, 20),
    constraints: [],
  },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];

let vp: Viewport;
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const state = () => useViewSection.getState();
const sel = () => useApp.getState().selection;

/** A mouse click at a world point (far enough apart in time not to be a double-click). */
async function clickAt(w: [number, number, number]) {
  const [clientX, clientY] = vp.worldToScreen(w)!;
  const ev = { pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX, clientY };
  await act(async () => {
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle(450);
}

const view = async (v: "top" | "front") =>
  act(async () => {
    vp.setView(v, false);
    vp.fit(false);
  });

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Section");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
});
beforeEach(async () => {
  await act(async () => closeSection());
  useApp.setState({ selection: [], selectedFeature: null });
});
afterAll(cleanup);

describe("section view", () => {
  it("switches on from the view's button, cut square to the axis looked along, and off again", async () => {
    await view("top");

    const before = JSON.stringify(currentDoc().features);

    await act(
      async () => void fireEvent.click(screen.getByTitle("Section view: cut the parts open (view only)")),
    );
    // From above: square to Z through the middle, the top half (toward the viewer) cut away.
    expect(vp.sectionView).toEqual({ normal: [0, 0, 1], offset: 5 });
    expect(state().axis).toBe("z");
    expect(screen.getByRole("toolbar", { name: "Section view" })).toBeTruthy();
    expect(screen.getByText("Z 5 mm")).toBeTruthy();
    expect(vp.renderer.localClippingEnabled).toBe(true);

    await act(async () => void fireEvent.click(screen.getByTitle("End the section view")));
    expect(vp.sectionView).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Section view" })).toBeNull();
    expect(vp.renderer.localClippingEnabled).toBe(false);
    // Only the view changed.
    expect(JSON.stringify(currentDoc().features)).toBe(before);
  });

  it("picks nothing cut away and nothing on the cut face, and the part again once whole", async () => {
    await view("top");
    await clickAt([20, 10, 10]);
    expect(sel().map((p) => p.kind)).toEqual(["face"]);

    useApp.setState({ selection: [] });
    await act(async () => toggleSection(vp));
    // The top is gone; looking down into the block the bottom is seen from inside: the cut face.
    await clickAt([20, 10, 10]);
    expect(sel()).toEqual([]);

    // An edge left whole is picked through the opening: the bottom one under the cut-away top one.
    await clickAt([0, 10, 0]);
    expect(sel().map((p) => [p.kind, (p as { point: number[] }).point[2]! < 1])).toEqual([["edge", true]]);

    // See-through, the inside shows as it is (no cut face drawn over it).
    await act(async () => vp.setDisplayMode("xray"));
    await act(async () => vp.setDisplayMode("shaded_edges"));
  });

  it("changes axis, keeps the other side and moves with the slider or a typed value", async () => {
    await view("top");
    await act(async () => toggleSection(vp));

    await act(async () => void fireEvent.click(screen.getByTitle("Cut square to X")));
    expect(state().axis).toBe("x");
    expect(vp.sectionView!.offset).toBeCloseTo(20 * Math.sign(vp.sectionView!.normal[0]), 9);

    await act(async () => void fireEvent.click(screen.getByTitle("Cut square to Z")));
    await act(async () => void fireEvent.click(screen.getByTitle("Keep the other side")));
    expect(vp.sectionView).toEqual({ normal: [-0, -0, -1], offset: -5 });
    expect(screen.getByText("Z 5 mm")).toBeTruthy();

    const slider = screen.getByLabelText("Where the plane cuts") as HTMLInputElement;
    expect([slider.min, slider.max]).toEqual(["-10", "0"]);
    await act(async () => void fireEvent.change(slider, { target: { value: "-3" } }));
    expect(vp.sectionView!.offset).toBe(-3);
    expect(screen.getByText("Z 3 mm")).toBeTruthy();

    // Typed: the position along Z, whichever side is kept.
    await act(async () => void fireEvent.click(screen.getByText("Z 3 mm")));

    const input = document.querySelector(".section-value input") as HTMLInputElement;
    await act(async () => void fireEvent.change(input, { target: { value: "7.5" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    expect(vp.sectionView!.offset).toBe(-7.5);

    // Not a value: the plane stays.
    await act(async () => void fireEvent.click(screen.getByText("Z 7.5 mm")));

    const again = document.querySelector(".section-value input") as HTMLInputElement;
    await act(async () => void fireEvent.change(again, { target: { value: "nope +" } }));
    await act(async () => void fireEvent.keyDown(again, { key: "Enter" }));
    expect(vp.sectionView!.offset).toBe(-7.5);
    // Left unchanged.
    await act(async () => void fireEvent.click(screen.getByText("Z 7.5 mm")));
    await act(
      async () => void fireEvent.keyDown(document.querySelector(".section-value input")!, { key: "Escape" }),
    );
    expect(vp.sectionView!.offset).toBe(-7.5);
  });

  it("lays the plane on a flat face clicked, tells how deep it cuts, and ends picking on empty space or Esc", async () => {
    await view("front");
    await act(async () => toggleSection(vp));
    // From the front: square to Y, the front half cut away; flipped, the front face is there to click.
    expect(state().axis).toBe("y");
    await act(async () => flipViewSection());

    await act(
      async () => void fireEvent.click(screen.getByTitle("Click a flat face to lay the plane on it")),
    );
    expect(state().picking).toBe(true);
    expect(screen.getByText("Click a flat face")).toBeTruthy();
    await clickAt([8, 0, 3]);

    expect(state().picking).toBe(false);
    expect(state().axis).toBe("face");
    expect(vp.sectionView!.normal.map((c) => c + 0)).toEqual([0, -1, 0]);
    expect(screen.getByText("0 mm deep")).toBeTruthy();
    // The face clicked is not selected.
    expect(sel()).toEqual([]);

    await act(async () => moveViewSection(vp.sectionView!.offset - 4));
    expect(screen.getByText("4 mm deep")).toBeTruthy();
    await act(async () => flipViewSection());
    expect(screen.getByText("4 mm deep")).toBeTruthy();

    // A click on nothing ends picking; so does Esc, and pressing the button again.
    await act(
      async () => void fireEvent.click(screen.getByTitle("Click a flat face to lay the plane on it")),
    );
    await clickAt([500, 500, 500]);
    expect(state().picking).toBe(false);
    await act(
      async () => void fireEvent.click(screen.getByTitle("Click a flat face to lay the plane on it")),
    );
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(state().picking).toBe(false);
    await act(
      async () => void fireEvent.click(screen.getByTitle("Click a flat face to lay the plane on it")),
    );
    await act(
      async () => void fireEvent.click(screen.getByTitle("Click a flat face to lay the plane on it")),
    );
    expect(state().picking).toBe(false);
  });

  it("refuses a face that is not flat, and a design with nothing to cut", async () => {
    await act(async () => toggleSection(vp));

    const before = vp.sectionView;
    await act(async () =>
      sectionOnPick({ kind: "face", bodyId: "nope", face: 0, tags: [], point: [0, 0, 0], normal: null }),
    );
    expect(vp.sectionView).toBe(before);
    expect(useApp.getState().toasts.at(-1)?.text).toBe("Only a flat face can take the section plane.");

    await act(async () => closeSection());
    await act(async () => toggleSection({ facingSection: () => null }));
    expect(state().section).toBeNull();
    expect(useApp.getState().toasts.at(-1)?.text).toBe("There is nothing to cut yet.");
    await act(async () => toggleSection(null));
    expect(state().section).toBeNull();

    // Without a section the bar's actions do nothing.
    flipViewSection();
    moveViewSection(3);
    sectionOnAxis({ facingSection: () => null }, "x");
    expect(state().section).toBeNull();
  });

  it("drags along its arrow, keeps cutting through a rebuild, stays out of thumbnails, and goes with the view", async () => {
    await view("top");
    await act(async () => toggleSection(vp));

    const handles = (
      vp as unknown as { handles: { id: string; onDrag(v: number): void; onEnd(v: number): void }[] }
    ).handles;
    const arrow = handles.find((h) => h.id === "section")!;
    await act(async () => arrow.onDrag(2));
    expect(state().section!.offset).toBe(2);
    await act(async () => arrow.onEnd(4));
    expect(screen.getByText("Z 4 mm")).toBeTruthy();

    // An arrow still held when the section ends moves nothing.
    await act(async () => closeSection());
    await act(async () => arrow.onDrag(1));
    expect(vp.sectionView).toBeNull();
    await act(async () => toggleSection(vp));
    await act(async () => moveViewSection(4));

    // A rebuild (a new part) keeps the cut, on the new part as well.
    apply({
      type: "add_features",
      features: [
        {
          id: "sk2",
          op: "sketch",
          plane: { ref: "origin.XY" },
          entities: rect("c", 60, 0, 10, 10),
          constraints: [],
        },
        {
          id: "ex2",
          op: "extrude",
          profile: { sketch: "sk2" },
          extent: "blind",
          distance: 10,
          mode: "new_body",
        },
      ],
    });
    await rebuilt();
    expect(vp.sectionView!.offset).toBe(4);

    const bodies = (
      vp as unknown as { bodies: { faces: { material: { clippingPlanes: unknown[] | null } } }[] }
    ).bodies;
    expect(bodies.every((b) => b.faces.material.clippingPlanes?.length === 1)).toBe(true);

    // Analysis colours on a part are cut too.
    await act(async () =>
      vp.setBodyHeat(new Map([["ex1", { positions: new Float32Array(9), colors: new Float32Array(9) }]])),
    );
    await act(async () => vp.setBodyHeat(new Map()));

    // Thumbnails show the parts whole; the view keeps its cut.
    vp.snapshot(64, 48, true);
    expect(bodies.every((b) => b.faces.material.clippingPlanes?.length === 1)).toBe(true);
    // A picture for an assistant: its own section or none, the view's put back after.
    vp.render({ width: 64, height: 48, section: { normal: [1, 0, 0], offset: 10 } });
    vp.render({ width: 64, height: 48 });
    expect(vp.sectionView!.offset).toBe(4);
    expect(bodies.every((b) => b.faces.material.clippingPlanes?.length === 1)).toBe(true);

    // In the rendered look the shadows are cut too.
    await act(async () => vp.setDisplayMode("rendered"));
    await act(async () => moveViewSection(3));
    await act(async () => vp.setDisplayMode("shaded_edges"));
  });

  it("leaves the parts whole when the view goes", async () => {
    await act(async () => toggleSection(vp));
    expect(vp.sectionView).not.toBeNull();
    cleanup();
    expect(vp.sectionView).toBeNull();
    expect(vp.onSectionChange).toBeNull();
  });
});
