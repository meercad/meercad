/**
 * More of drawing in the sketch editor, checked by the solved sizes: arcs of a typed radius or
 * angle, dimensions placed by clicks (two points across, along or diagonal by where the label goes,
 * a point and a line, two lines at an angle or apart, an arc's radius or its angle), and trimming a
 * circle and an arc back to where a line crosses them.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { closeSketch, currentDoc, getViewport, newProject, rebuildNow, startSketch, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setTool } from "./state";

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

describe("arcs of typed sizes", () => {
  it("draws an arc between two ends with a typed radius: 10 over a 20 mm chord is a half circle", async () => {
    await act(async () => setTool("arc"));
    await clickAt(0, 0);
    await clickAt(20, 0);
    await act(async () => void fireEvent.pointerMove(vp.canvas, { ...screenAt(10, 8), buttons: 0 }));
    await typeSizes("10");

    const arc = (await solved()).curves.find((c) => c.kind === "arc") as {
      radius: number;
      center: [number, number];
      a0: number;
      a1: number;
    };
    expect(arc.radius).toBeCloseTo(10, 6);
    expect(arc.center[0]).toBeCloseTo(10, 6);
    expect(num(constraint("radius")!.value)).toBe(10);
  });

  it("draws an arc round a centre to a typed angle: a quarter of r 10", async () => {
    await act(async () => setTool("arc_center"));
    await clickAt(0, 0);
    await clickAt(10, 0);
    await act(async () => void fireEvent.pointerMove(vp.canvas, { ...screenAt(7, 7), buttons: 0 }));
    await typeSizes("90");

    const arc = (await solved()).curves.find((c) => c.kind === "arc") as {
      radius: number;
      a0: number;
      a1: number;
    };
    expect(arc.radius).toBeCloseTo(10, 6);

    const sweep = (((arc.a1 - arc.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect((sweep * 180) / Math.PI).toBeCloseTo(90, 6);
  });
});

describe("dimensions by clicks", () => {
  it("dimensions two points across, along or straight by where the label goes", async () => {
    await act(async () => setTool("point"));
    await clickAt(0, 0);
    await clickAt(30, 20);
    // Below both: the distance across (x) 30; beside them: along (y) 20; between: straight, 36.06.
    await dimension([0, 0], [30, 20], [15, -10]);
    expect(constraint("distance")).toMatchObject({ axis: "x" });
    expect(num(constraint("distance")!.value)).toBeCloseTo(30, 3);
    await dimension([0, 0], [30, 20], [40, 10]);
    expect(constraint("distance")).toMatchObject({ axis: "y" });
    expect(num(constraint("distance")!.value)).toBeCloseTo(20, 3);
    await dimension([0, 0], [30, 20], [15, 10]);
    expect(constraint("distance")!.axis).toBeUndefined();
    expect(num(constraint("distance")!.value)).toBeCloseTo(Math.hypot(30, 20), 3);
  });

  it("dimensions a point from a line, two lines at an angle, and two parallel lines apart", async () => {
    await line([0, 0], [40, 0]);
    await line([0, 0], [Math.cos(Math.PI / 6) * 30, Math.sin(Math.PI / 6) * 30]);
    await line([0, 15], [40, 15]);
    await act(async () => setTool("point"));
    await clickAt(20, 30);
    await dimension([20, 30], [30, 0], [25, 20]);
    expect(num(constraint("distance")!.value)).toBeCloseTo(30, 3);
    await dimension([30, 0], [Math.cos(Math.PI / 6) * 20, Math.sin(Math.PI / 6) * 20], [35, 8]);
    expect(num(constraint("angle")!.value)).toBeCloseTo(30, 1);
    await dimension([30, 0], [30, 15], [35, 7]);
    expect(num(constraint("distance")!.value)).toBeCloseTo(15, 3);
  });

  it("dimensions an arc by its radius further out, by its angle near its centre", async () => {
    await act(async () => setTool("arc_center"));
    await clickAt(0, 0);
    await clickAt(20, 0);
    await clickAt(0, 20);
    await act(async () => setTool("select"));

    const r = Math.SQRT1_2 * 20;
    await dimension([r, r], [30, 30]);
    expect(num(constraint("radius")!.value)).toBeCloseTo(20, 3);
    await dimension([r, r], [3, 3]);
    expect(num(constraint("arc_angle")!.value)).toBeCloseTo(90, 1);
  });
});

describe("trimming round curves", () => {
  it("trims the upper half of a circle a line crosses: a half circle is left", async () => {
    await act(async () => setTool("circle"));
    await clickAt(0, 0);
    await clickAt(10, 0);
    await line([-20, 0], [20, 0]);
    await act(async () => setTool("trim"));
    await clickAt(0, 10);
    expect(ofType("circle")).toHaveLength(0);

    const arc = (await solved()).curves.find((c) => c.kind === "arc") as {
      radius: number;
      a0: number;
      a1: number;
      center: [number, number];
    };
    expect(arc.radius).toBeCloseTo(10, 3);

    const sweep = (((arc.a1 - arc.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect((sweep * 180) / Math.PI).toBeCloseTo(180, 1);
    // What is left is the lower half.
    expect(Math.sin((arc.a0 + arc.a1) / 2 + (arc.a1 < arc.a0 ? Math.PI : 0))).toBeLessThan(0);
  });

  it("trims an arc back to where a line crosses it: half of a half circle is left", async () => {
    await act(async () => setTool("arc_center"));
    await clickAt(0, 0);
    await clickAt(20, 0);
    await clickAt(-20, 0.01);
    await line([0, -30], [0, 30]);

    const half = (await solved()).curves.find((c) => c.kind === "arc") as { a0: number; a1: number };
    await act(async () => setTool("trim"));

    // A quarter of the way along the arc from its start: the piece up to the line goes.
    const sweep0 = (((half.a1 - half.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const at = half.a0 + sweep0 / 4;
    await clickAt(20 * Math.cos(at), 20 * Math.sin(at));

    const arc = (await solved()).curves.find((c) => c.kind === "arc") as {
      radius: number;
      a0: number;
      a1: number;
    };
    expect(arc.radius).toBeCloseTo(20, 3);

    const sweep = (((arc.a1 - arc.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect((sweep0 * 180) / Math.PI).toBeCloseTo(180, 0);
    expect((sweep * 180) / Math.PI).toBeCloseTo(90, 0);
  });
});
