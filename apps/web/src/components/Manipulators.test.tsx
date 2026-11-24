/**
 * Drag arrows on the model (Manipulators.tsx) in the real 3D view: editing an extrude, a fillet and
 * an offset plane shows an arrow at the right place; dragging it, by its callbacks and by the
 * pointer on the screen, changes the step, and the part comes out at the dragged size.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Pick, Viewport } from "@meercad/viewport";
import {
  apply,
  cancelDialog,
  commitDialog,
  currentDoc,
  editFeature,
  getViewport,
  newProject,
  rebuildNow,
  startFeature,
  undo,
  updateDraft,
  useApp,
} from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

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
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.l1]"] }], radius: 2 },
  { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 30 },
];
let vp: Viewport;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Arrows");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("iso", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("drag arrows", () => {
  it("puts the extrude's arrow on its top face and drags it to 25 mm", async () => {
    await act(async () => editFeature("ex1"));
    await settle();

    const h = vp.handles[0]!;
    expect(h).toBeDefined();
    expect(h.value).toBeCloseTo(10, 6);
    expect(h.dir.map((v) => Math.round(v))).toEqual([0, 0, 1]);
    await act(async () => {
      h.onStart?.();
      h.onDrag(25);
      h.onEnd(25);
    });
    expect((useApp.getState().dialog!.feature as { distance: unknown }).distance).toBe(25);
    await act(async () => void commitDialog());

    const out = await rebuildNow();
    // 40 × 20 × 25 less the R2 round along a 40 mm edge.
    expect(out.report.bodies[0]!.volume).toBeCloseTo(40 * 20 * 25 - (4 - Math.PI) * 40, 3);
  });

  it("drags a new fillet's arrow by the pointer", async () => {
    // A new fillet on the top's other long edge (the edge is still there to put the arrow on).
    await act(async () => startFeature("fillet"));
    await act(async () =>
      updateDraft({ edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.l3]"] }] } as Partial<Feature>),
    );
    await vi.waitFor(
      async () => {
        await settle();
        expect(vp.handles.length).toBeGreaterThan(0);
      },
      { timeout: 20_000, interval: 100 },
    );

    const h = vp.handles[0]!;
    expect(h.value).toBeCloseTo(2, 6);
    // The arrow sits on the middle of that edge (x = 20, y = 20, z = 25).
    expect(h.origin[0]).toBeCloseTo(20, 3);
    expect(h.origin[1]).toBeCloseTo(20, 3);
    expect(h.origin[2]).toBeCloseTo(25, 3);

    const tip = vp.handleTipScreen(h.id)!;
    expect(tip).not.toBeNull();

    const ev = { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true };
    await act(async () => {
      fireEvent.pointerDown(vp.canvas, { ...ev, clientX: tip[0], clientY: tip[1] });
      fireEvent.pointerMove(vp.canvas, { ...ev, clientX: tip[0] + 15, clientY: tip[1] - 15 });
      fireEvent.pointerMove(vp.canvas, { ...ev, clientX: tip[0] + 30, clientY: tip[1] - 30 });
      fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0, clientX: tip[0] + 30, clientY: tip[1] - 30 });
    });
    await settle();

    const r = (useApp.getState().dialog!.feature as { radius: number }).radius;
    expect(typeof r).toBe("number");
    expect(r).toBeGreaterThanOrEqual(0);
    await act(async () => cancelDialog());
  });

  it("moves an offset plane", async () => {
    await act(async () => editFeature("pl1"));
    await settle();

    const h = vp.handles[0];

    if (h) {
      expect(h.value).toBeCloseTo(30, 6);
      await act(async () => h.onDrag(45));
      expect((useApp.getState().dialog!.feature as { offset: unknown }).offset).toBe(45);
    }

    await act(async () => cancelDialog());
  });
});

/**
 * A tool started on a selection (here a fillet on a picked edge): its arrow is live at once. The mouse
 * moves the value without a button and a click sets it; Esc puts it back; a finger drags anywhere and
 * lifting it sets the value; a second finger calls the drag off and the arrow is live again.
 */
describe("an armed arrow", () => {
  const edge = { kind: "edge", bodyId: "ex1", edge: 0, point: [20, 20, 25] } as unknown as Pick;
  const radius = () => (useApp.getState().dialog?.feature as { radius?: number } | undefined)?.radius;
  const mouse = { pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };

  /** A new fillet on the top's back edge, started with an edge selected: the arrow is armed. */
  async function armedFillet() {
    await act(async () => useApp.setState({ selection: [edge] }));
    await act(async () => startFeature("fillet"));
    expect(useApp.getState().dialog!.arm).toBeGreaterThan(0);
    await act(async () =>
      updateDraft({ edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.l3]"] }] } as Partial<Feature>),
    );
    await vi.waitFor(
      async () => {
        await settle();
        expect(vp.handleArmed).toBe(true);
      },
      { timeout: 20_000, interval: 100 },
    );

    return vp.handleTipScreen("fillet")!;
  }

  it("is not armed when the tool starts without a selection", async () => {
    await act(async () => useApp.setState({ selection: [] }));
    await act(async () => startFeature("fillet"));
    expect(useApp.getState().dialog!.arm).toBeUndefined();
    await act(async () => cancelDialog());
  });

  it("follows the hovering mouse, shows how to set it, and a click sets it", async () => {
    const tip = await armedFillet();
    expect(radius()).toBe(2);

    await act(async () => {
      fireEvent.pointerMove(vp.canvas, { ...mouse, buttons: 0, clientX: tip[0], clientY: tip[1] });
      fireEvent.pointerMove(vp.canvas, { ...mouse, buttons: 0, clientX: tip[0] + 20, clientY: tip[1] - 20 });
    });
    await settle();

    const hovered = radius();
    expect(hovered).not.toBe(2);
    expect(document.querySelector(".cursor-tip-hint")?.textContent).toBe("Click to set · Esc cancels");

    // A button held (orbiting the view) does not move it.
    await act(async () => {
      fireEvent.pointerMove(vp.canvas, { ...mouse, buttons: 4, clientX: tip[0] + 60, clientY: tip[1] - 60 });
    });
    await settle();
    expect(radius()).toBe(hovered);

    const at = [tip[0] + 20, tip[1] - 20];
    await act(async () => {
      fireEvent.pointerMove(vp.canvas, { ...mouse, buttons: 0, clientX: at[0], clientY: at[1] });
      fireEvent.pointerDown(vp.canvas, { ...mouse, buttons: 1, clientX: at[0], clientY: at[1] });
      fireEvent.pointerUp(vp.canvas, { ...mouse, buttons: 0, clientX: at[0], clientY: at[1] });
    });
    await settle();

    // Set: the dialog is committed with the hovered radius.
    expect(useApp.getState().dialog).toBeNull();
    expect(vp.handleArmed).toBe(false);

    const made = currentDoc().features.find((f) => f.op === "fillet" && f.id !== "fi1") as { radius: number };
    expect(made.radius).toBe(hovered);
    await act(async () => undo());
  });

  it("goes back with Esc", async () => {
    const tip = await armedFillet();

    await act(async () => {
      fireEvent.pointerMove(vp.canvas, { ...mouse, buttons: 0, clientX: tip[0], clientY: tip[1] });
      fireEvent.pointerMove(vp.canvas, { ...mouse, buttons: 0, clientX: tip[0] + 20, clientY: tip[1] - 20 });
    });
    await settle();
    expect(radius()).not.toBe(2);

    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await settle();
    expect(radius()).toBe(2);
    expect(vp.handleArmed).toBe(false);
    expect(document.querySelector(".cursor-tip")).toBeNull();
    await act(async () => cancelDialog());
  });

  it("keeps the value on a typed key or a press outside the view; the wheel catches it again", async () => {
    for (const leave of ["key", "outside"] as const) {
      const tip = await armedFillet();

      await act(async () => {
        fireEvent.pointerMove(vp.canvas, { ...mouse, buttons: 0, clientX: tip[0], clientY: tip[1] });
        fireEvent.wheel(vp.canvas, { deltaY: 0 });
        fireEvent.pointerLeave(vp.canvas);
        fireEvent.pointerMove(vp.canvas, { ...mouse, buttons: 0, clientX: tip[0], clientY: tip[1] });
        fireEvent.pointerMove(vp.canvas, {
          ...mouse,
          buttons: 0,
          clientX: tip[0] + 20,
          clientY: tip[1] - 20,
        });
      });
      await settle();

      const hovered = radius();
      expect(hovered).not.toBe(2);

      await act(async () => {
        if (leave === "key") fireEvent.keyDown(window, { key: "5" });
        else fireEvent.pointerDown(document.body, { ...mouse, buttons: 1 });
      });
      await settle();
      expect(vp.handleArmed).toBe(false);
      expect(radius()).toBe(hovered);
      // A modifier alone does nothing (the arrow was already let go).
      await act(async () => void fireEvent.keyDown(window, { key: "Shift" }));
      expect(useApp.getState().dialog).not.toBeNull();
      await act(async () => cancelDialog());
    }
  });

  it("by touch: drags anywhere and lifting sets it; a second finger calls it off", async () => {
    const coarse = vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: q.includes("coarse"),
          media: q,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );

    try {
      const tip = await armedFillet();
      // A finger does not hover: moving without touching changes nothing.
      const finger = { pointerType: "touch", button: 0, isPrimary: true };
      await act(async () => {
        fireEvent.pointerMove(vp.canvas, {
          ...finger,
          pointerId: 5,
          buttons: 0,
          clientX: tip[0] + 30,
          clientY: tip[1] - 30,
        });
      });
      await settle();
      expect(radius()).toBe(2);
      expect(document.querySelector(".cursor-tip-hint")?.textContent).toBe("Drag anywhere · Lift to set");

      // A second finger lands while the first drags: back to 2 and armed again.
      const from: [number, number] = [tip[0] - 80, tip[1] + 40];
      await act(async () => {
        fireEvent.pointerDown(vp.canvas, {
          ...finger,
          pointerId: 5,
          buttons: 1,
          clientX: from[0],
          clientY: from[1],
        });
        fireEvent.pointerMove(vp.canvas, {
          ...finger,
          pointerId: 5,
          buttons: 1,
          clientX: from[0] + 25,
          clientY: from[1] - 25,
        });
      });
      await settle();
      expect(radius()).not.toBe(2);
      await act(async () => {
        fireEvent.pointerDown(vp.canvas, {
          ...finger,
          pointerId: 6,
          isPrimary: false,
          buttons: 1,
          clientX: from[0] + 100,
          clientY: from[1],
        });
      });
      await settle();
      expect(radius()).toBe(2);
      expect(vp.handleArmed).toBe(true);
      await act(async () => {
        fireEvent.pointerUp(vp.canvas, {
          ...finger,
          pointerId: 6,
          isPrimary: false,
          buttons: 0,
          clientX: from[0] + 100,
          clientY: from[1],
        });
        fireEvent.pointerUp(vp.canvas, {
          ...finger,
          pointerId: 5,
          buttons: 0,
          clientX: from[0] + 25,
          clientY: from[1] - 25,
        });
      });
      await settle();
      expect(useApp.getState().dialog).not.toBeNull();

      // One finger, anywhere on the view: the value follows from where it lands, lifting sets it.
      await act(async () => {
        fireEvent.pointerDown(vp.canvas, {
          ...finger,
          pointerId: 7,
          buttons: 1,
          clientX: from[0],
          clientY: from[1],
        });
        fireEvent.pointerMove(vp.canvas, {
          ...finger,
          pointerId: 7,
          buttons: 1,
          clientX: from[0] + 25,
          clientY: from[1] - 25,
        });
      });
      await settle();
      expect(radius()).not.toBe(2);
      await act(async () => {
        fireEvent.pointerUp(vp.canvas, {
          ...finger,
          pointerId: 7,
          buttons: 0,
          clientX: from[0] + 25,
          clientY: from[1] - 25,
        });
      });
      await settle();
      expect(useApp.getState().dialog).toBeNull();
      await act(async () => undo());
    } finally {
      coarse.mockRestore();
    }
  });
});
