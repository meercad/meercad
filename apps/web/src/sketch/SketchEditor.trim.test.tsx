/**
 * Trimming in the sketch editor (SketchEditor.tsx, trim tool) with the pointer on the real 3D view,
 * seen from above: a line cut twice loses its middle and becomes two lines; cut once, it loses the
 * end clicked; an arc likewise in the middle and at an end; a spline loses the stretch between the
 * cuts round the click. Each result is checked by where the remaining ends lie.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity, SketchFeature } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { apply, closeSketch, currentDoc, editFeature, getViewport, newProject, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setTool } from "./state";

let vp: Viewport;
const sketch = () => currentDoc().features.find((f) => f.id === "sk1") as SketchFeature;
const ofType = <T extends SketchEntity["type"]>(type: T) => sketch().entities.filter((e): e is Extract<SketchEntity, { type: T }> => e.type === type);
const pos = (id: string) => {
  const p = sketch().entities.find((e) => e.id === id) as { x: number; y: number };
  return [p.x, p.y] as [number, number];
};
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
async function clickAt(u: number, v: number) {
  const [x, y] = vp.worldToScreen([u, v, 0])!;
  const ev = { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle(450);
}
const P = (id: string, x: number, y: number): SketchEntity => ({ id, type: "point", x, y });
const L = (id: string, p1: string, p2: string): SketchEntity => ({ id, type: "line", p1, p2 });
/** Opens a sketch of these entities for editing, seen from above round (cx, cy). */
async function open(entities: SketchEntity[], cx = 20, cy = 0) {
  withScreen();
  await newProject(undefined, "Trim");
  apply({ type: "add_features", features: [{ id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities, constraints: [] } as Feature] });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => editFeature("sk1"));
  await act(async () => vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(cx, cy, 0)));
  await settle(50);
  await act(async () => setTool("trim"));
}
/** Two crossing lines at x = 10 and 30 from y = −10 to 10. */
const posts: SketchEntity[] = [P("a1", 10, -10), P("a2", 10, 10), L("va", "a1", "a2"), P("b1", 30, -10), P("b2", 30, 10), L("vb", "b1", "b2")];

afterEach(async () => {
  if (useApp.getState().sketchId) await act(async () => closeSketch());
  cleanup();
});

describe("trimming", () => {
  it("cuts the middle out of a line crossed twice: two lines remain", async () => {
    await open([...posts, P("h1", 0, 0), P("h2", 40, 0), L("h", "h1", "h2")]);
    await clickAt(20, 0);
    const lines = ofType("line").filter((l) => l.id !== "va" && l.id !== "vb");
    expect(lines).toHaveLength(2);
    const spans = lines.map((l) => [pos(l.p1)[0], pos(l.p2)[0]].sort((a, b) => a - b)).sort((a, b) => a[0]! - b[0]!);
    expect(spans[0]![0]).toBeCloseTo(0, 6);
    expect(spans[0]![1]).toBeCloseTo(10, 6);
    expect(spans[1]![0]).toBeCloseTo(30, 6);
    expect(spans[1]![1]).toBeCloseTo(40, 6);
  });

  it("cuts a line's end beyond its last crossing", async () => {
    await open([...posts, P("h1", 20, 0), P("h2", 40, 0), L("h", "h1", "h2")]);
    await clickAt(35, 0);
    const h = ofType("line").find((l) => l.id === "h")!;
    const xs = [pos(h.p1)[0], pos(h.p2)[0]].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(20, 6);
    expect(xs[1]).toBeCloseTo(30, 6);
  });

  it("cuts the middle out of an arc crossed twice, and an arc's end", async () => {
    // A half circle of radius 20 round (20, −10) from (40, −10) over the top to (0, −10).
    await open([...posts, P("c", 20, -10), P("s", 40, -10), P("e", 0, -10), { id: "k", type: "arc", center: "c", start: "s", end: "e" }]);
    await clickAt(20, 10);
    const arcs = ofType("arc");
    expect(arcs).toHaveLength(2);
    // Every end of the two arcs lies on the circle; the cut ends where the posts cross it.
    for (const a of arcs)
      for (const id of [a.start, a.end]) {
        const [x, y] = pos(id);
        // (Stored to the thousandth of a millimetre.)
        expect(Math.hypot(x - 20, y + 10)).toBeCloseTo(20, 2);
      }
    const ends = arcs.flatMap((a) => [pos(a.start)[0], pos(a.end)[0]]).sort((a, b) => a - b);
    expect(ends.map((x) => Math.round(x))).toEqual([0, 10, 30, 40]);
    // The end beyond the right post: clicked, it goes, the arc then starts at the post.
    await clickAt(20 + 20 * Math.cos(0.2), -10 + 20 * Math.sin(0.2));
    const right = ofType("arc").map((a) => [pos(a.start)[0], pos(a.end)[0]]);
    expect(right.flat().every((x) => x < 30 + 1e-6)).toBe(true);
  });

  it("cuts the stretch of a spline between the crossings round the click", async () => {
    await open([...posts, P("s1", 0, 0), P("s2", 15, 3), P("s3", 25, -3), P("s4", 40, 0), { id: "sp", type: "spline", points: ["s1", "s2", "s3", "s4"] }]);
    await clickAt(20, 0);
    const splines = ofType("spline");
    expect(splines).toHaveLength(2);
    // One ends at the left post, the other starts at the right one.
    const ends = splines.map((s) => [pos(s.points[0]!)[0], pos(s.points.at(-1)!)[0]]);
    expect(ends.flat().some((x) => Math.abs(x - 10) < 0.5)).toBe(true);
    expect(ends.flat().some((x) => Math.abs(x - 30) < 0.5)).toBe(true);
  });
});
