/**
 * Picking and framing in the real 3D view (packages/viewport) over the kernel's meshes, on an
 * 800 × 600 screen: what is under a point is the face, edge or part drawn there, a plane hit lands
 * at the right sketch coordinates, and the model's box is the drawn one.
 */
import { act, cleanup } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { ORIGIN_FRAMES } from "@meercad/sketch";
import { apply, getViewport, newProject } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
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
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 60, 0, 10, 10), constraints: [] },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];
const FACES = new Set(["face"] as const);
let vp: Viewport;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Picking");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("picking in the 3D view", () => {
  it("frames the drawn parts", () => {
    const box = vp.modelBox()!;
    box.min.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 0][i]!, 3));
    box.max.forEach((v, i) => expect(v).toBeCloseTo([70, 20, 10][i]!, 3));
  });

  it("finds the top face under its middle, with its normal and the point hit", () => {
    const at = vp.worldToScreen([20, 10, 10])!;
    expect(at[0]).toBeGreaterThan(0);
    expect(at[0]).toBeLessThan(800);
    const p = vp.pick(at[0], at[1], FACES)!;
    expect(p).toMatchObject({ kind: "face", bodyId: "ex1" });
    if (p.kind === "face") p.normal!.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 1][i]!, 9));
    expect(p.kind === "face" && p.tags).toContain("ex1.end_cap");
    if (p.kind === "face") p.point.forEach((v, i) => expect(v).toBeCloseTo([20, 10, 10][i]!, 3));
    // Beside the parts there is nothing.
    const off = vp.worldToScreen([50, 10, 10])!;
    expect(vp.pick(off[0], off[1], FACES)).toBeNull();
  });

  it("finds an edge near its line", () => {
    const at = vp.worldToScreen([20, 0, 10])!;
    const p = vp.pick(at[0], at[1], new Set(["edge"]));
    expect(p?.kind).toBe("edge");
    expect(p && "bodyId" in p && p.bodyId).toBe("ex1");
  });

  it("lands a point on a sketch plane at its sketch coordinates", () => {
    const at = vp.worldToScreen([33, 7, 0])!;
    const uv = vp.rayToPlane(at[0], at[1], ORIGIN_FRAMES["origin.XY"])!;
    expect(uv[0]).toBeCloseTo(33, 3);
    expect(uv[1]).toBeCloseTo(7, 3);
  });

  it("selects the faces inside a box drawn round a part", () => {
    const a = vp.worldToScreen([58, -2, 10])!;
    const b = vp.worldToScreen([72, 12, 10])!;
    const picks = vp.boxSelect(a[0], a[1], b[0], b[1], true, new Set(["face"]));
    expect(picks.length).toBeGreaterThan(0);
    expect(new Set(picks.map((p) => ("bodyId" in p ? p.bodyId : "")))).toEqual(new Set(["ex2"]));
  });

  it("switches to an orthographic camera and keeps picking right", async () => {
    await act(async () => vp.setProjection("orthographic"));
    expect(vp.projection).toBe("orthographic");
    const at = vp.worldToScreen([65, 5, 10])!;
    expect(vp.pick(at[0], at[1], FACES)).toMatchObject({ kind: "face", bodyId: "ex2" });
    expect(vp.pixelSize()).toBeGreaterThan(0);
    await act(async () => vp.setProjection("perspective"));
  });
});
