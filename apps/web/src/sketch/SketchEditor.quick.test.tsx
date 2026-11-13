/**
 * Setting sizes right after drawing in the sketch editor: a line, a circle and an arc offer their
 * size as chips at once; a value typed there becomes a dimension and the drawn shape takes it. A
 * dimension's label is changed by a double-click. And the keys: Escape steps back (the points being
 * drawn, the tool, the selection, the sketch), Delete removes what is selected, Enter closes.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { closeSketch, currentDoc, getViewport, newProject, rebuildNow, startSketch, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setTool, useSketchUi } from "./state";

let vp: Viewport;
const sketch = () => currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as SketchFeature;
const ofType = <T extends SketchEntity["type"]>(type: T) =>
  sketch().entities.filter((e): e is Extract<SketchEntity, { type: T }> => e.type === type);
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));

const screenAt = (u: number, v: number) => {
  const [x, y] = vp.worldToScreen([u, v, 0])!;

  return { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
};

async function clickAt(u: number, v: number, opts: { shiftKey?: boolean } = {}) {
  const ev = { ...screenAt(u, v), ...opts };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle();
}

async function dragFrom(from: [number, number], to: [number, number]) {
  const a = screenAt(...from);
  const b = screenAt(...to);
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...a, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...a, buttons: 1 });

    for (let i = 1; i <= 4; i++) {
      fireEvent.pointerMove(vp.canvas, {
        ...a,
        clientX: a.clientX + ((b.clientX - a.clientX) * i) / 4,
        clientY: a.clientY + ((b.clientY - a.clientY) * i) / 4,
        buttons: 1,
      });
    }
  });
  await settle(40);
  await act(async () => void fireEvent.pointerUp(vp.canvas, { ...b, buttons: 0 }));
  await settle(40);
}

async function solved() {
  const out = await rebuildNow();

  return out.report.sketches.find((x) => x.id === sketch().id)!;
}

/** A 40 × 20 rectangle from the origin, typed in. */
async function rectangle() {
  await act(async () => setTool("rect"));
  await clickAt(0, 0);
  await act(async () => void fireEvent.keyDown(window, { key: "4" }));

  const inputs = () => [...document.querySelectorAll<HTMLInputElement>(".draw-entry input")];
  await act(async () => void fireEvent.change(inputs()[0]!, { target: { value: "40" } }));
  await act(async () => void fireEvent.change(inputs()[1]!, { target: { value: "20" } }));
  await act(async () => void fireEvent.keyDown(inputs()[0]!, { key: "Enter" }));
  await act(async () => setTool("select"));
  await settle();
}

const lineAt = (y: number) => {
  const s = sketch();
  const pos = (id: string) => s.entities.find((e) => e.id === id) as { x: number; y: number };

  return ofType("line").find((l) => Math.abs(pos(l.p1).y - y) < 0.01 && Math.abs(pos(l.p2).y - y) < 0.01)!;
};

beforeEach(async () => {
  withScreen();
  await newProject(undefined, "Sketch tools");
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => startSketch({ ref: "origin.XY" }));
  await act(async () =>
    vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(20, 10, 0)),
  );
  await settle(50);
});
afterEach(async () => {
  await act(async () => closeSketch());
  cleanup();
});

/** Types into the open size fields: the first value (its first key opens them), then the others. */
async function typeSizes(...values: string[]) {
  for (const [i, v] of values.entries()) {
    if (i === 0) await act(async () => void fireEvent.keyDown(window, { key: v[0]! }));

    const inputs = [...document.querySelectorAll<HTMLInputElement>(".draw-entry input")];
    await act(async () => void fireEvent.change(inputs[i]!, { target: { value: v } }));
  }

  const inputs = [...document.querySelectorAll<HTMLInputElement>(".draw-entry input")];
  await act(async () => void fireEvent.keyDown(inputs[0]!, { key: "Enter" }));
  await settle();
}

const constraint = (type: string) =>
  sketch()
    .constraints.filter((c) => c.type === type)
    .at(-1) as { value: unknown; axis?: string } | undefined;
const num = (v: unknown) => Number(String(v).replace(/ ?(mm|deg|°)$/, ""));

async function line(a: [number, number], b: [number, number]) {
  await act(async () => setTool("line"));
  await clickAt(...a);
  await clickAt(...b);
  await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
  await act(async () => setTool("select"));
}

async function dimension(...clicks: [number, number][]) {
  await act(async () => setTool("dimension"));
  for (const c of clicks) await clickAt(...c);
  await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
  await act(async () => setTool("select"));
}

const quick = (key: string) => document.querySelector<HTMLButtonElement>(`.quick-dim.${key} button`);

async function setQuick(key: string, value: string) {
  expect(quick(key), key).not.toBeNull();
  await act(async () => void fireEvent.click(quick(key)!));

  const input = document.querySelector<HTMLInputElement>(".quick-dim input")!;
  await act(async () => void fireEvent.change(input, { target: { value } }));
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
  await settle();
}

describe("sizes right after drawing", () => {
  it("sets a just-drawn line to 25 mm at 30°", async () => {
    // Drawn and still in the line tool: its chips are there.
    await act(async () => setTool("line"));
    await clickAt(0, 0);
    await clickAt(20, 3);
    await setQuick("len", "25");
    await setQuick("ang", "30");

    const l = (await solved()).curves.find((c) => c.kind === "line") as {
      a: [number, number];
      b: [number, number];
    };
    expect(Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1])).toBeCloseTo(25, 6);
    expect((Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]) * 180) / Math.PI).toBeCloseTo(30, 6);
  });

  it("sets a just-drawn circle to Ø12 and an arc to R8 over 120°", async () => {
    await act(async () => setTool("circle"));
    await clickAt(30, 10);
    await clickAt(35, 10);
    await setQuick("dia", "12");

    const c = (await solved()).curves.find((x) => x.kind === "circle") as { radius: number };
    expect(c.radius).toBeCloseTo(6, 6);
    await act(async () => setTool("arc_center"));
    await clickAt(0, 30);
    await clickAt(10, 30);
    await clickAt(0, 40);
    await setQuick("rad", "8");
    await setQuick("sweep", "120");

    const a = (await solved()).curves.find((x) => x.kind === "arc") as {
      radius: number;
      a0: number;
      a1: number;
    };
    expect(a.radius).toBeCloseTo(8, 6);

    const sweep = (((a.a1 - a.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect((sweep * 180) / Math.PI).toBeCloseTo(120, 6);
  });

  it("changes a dimension by double-clicking its label", async () => {
    await act(async () => setTool("line"));
    await clickAt(0, 0);
    await clickAt(20, 3);
    await setQuick("len", "20");

    const label = [...document.querySelectorAll<HTMLElement>(".sketch-label")].find((l) =>
      /20/.test(l.textContent ?? ""),
    )!;
    await act(async () => void fireEvent.doubleClick(label));

    const input = document.querySelector<HTMLInputElement>(".sketch-label input")!;
    await act(async () => void fireEvent.change(input, { target: { value: "33" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));

    const l = (await solved()).curves.find((c) => c.kind === "line") as {
      a: [number, number];
      b: [number, number];
    };
    expect(Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1])).toBeCloseTo(33, 6);
  });
});

describe("keys in a sketch", () => {
  it("steps back with Escape, deletes with Delete and closes with Enter", async () => {
    await act(async () => setTool("line"));
    await clickAt(0, 0);
    // Escape drops the point being drawn, then the tool, then the selection, then the sketch.
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(useSketchUi.getState().tool).toBe("line");
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(useSketchUi.getState().tool).toBe("select");
    await line([0, 0], [10, 0]);
    await act(async () => void fireEvent.keyDown(window, { key: "a", metaKey: true }));
    expect(useSketchUi.getState().selection.length).toBeGreaterThan(0);
    await act(async () => void fireEvent.keyDown(window, { key: "Delete" }));
    expect(sketch().entities).toEqual([]);
    await line([0, 0], [10, 0]);
    await act(async () => void fireEvent.keyDown(window, { key: "a", metaKey: true }));
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(useSketchUi.getState().selection).toEqual([]);
    await act(async () => void fireEvent.keyDown(window, { key: "Enter" }));
    expect(useApp.getState().sketchId).toBeNull();
  });
});
