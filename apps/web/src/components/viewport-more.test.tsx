/**
 * More of the 3D view (packages/viewport) with the real scene: reference meshes, a round face that
 * has no single normal, sketch lines picked and highlighted, a trackpad pan, the grid and snap steps
 * far out, a picture in the flat projection, the bottom inset while an arrow is dragged, a joint's
 * grab cursor, and pictures or surroundings that fail to load.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import * as vpModule from "@meercad/viewport";
import { samePick, THREE, type Pick, type Viewport } from "@meercad/viewport";
import { apply, getViewport, newProject } from "../store";
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
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "c", type: "point", x: 80, y: 10 }, { id: "k", type: "circle", center: "c", radius: 8 }], constraints: [] },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];
let vp: Viewport;
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "View more");
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

describe("the 3D view, more", () => {
  it("shows reference meshes and keeps the scene it was given", () => {
    const data = vp.data!;
    expect(data.bodies.map((b) => b.bodyId).sort()).toEqual(["ex1", "ex2"]);
    const ref = { id: "r1", positions: new Float32Array([0, 0, 30, 10, 0, 30, 0, 10, 30]), indices: new Uint32Array([0, 1, 2]) };
    vp.setScene({ ...data, references: [ref] });
    expect((vp as unknown as { refGroup: { children: unknown[] } }).refGroup.children).toHaveLength(1);
    vp.setScene({ ...data, references: [] });
    expect((vp as unknown as { refGroup: { children: unknown[] } }).refGroup.children).toHaveLength(0);
  });

  it("gives a flat face its normal, a round one none", () => {
    vp.setView("top", false);
    vp.fit(false);
    vp.scene.updateMatrixWorld(true);
    const FACE = new Set(["face"] as const);
    const top = vp.worldToScreen([20, 10, 10])!;
    const flat = vp.pick(top[0], top[1], FACE) as Extract<Pick, { kind: "face" }>;
    expect(flat.normal).toEqual([0, 0, 1]);
    vp.setView("front", false);
    vp.fit(false);
    vp.scene.updateMatrixWorld(true);
    const side = vp.worldToScreen([80, -8, 5])!;
    const round = vp.pick(side[0], side[1], FACE) as Extract<Pick, { kind: "face" }>;
    expect(round.bodyId).toBe("ex2");
    expect(round.normal).toBeNull();
    // Asked again: the same answer from what it worked out.
    expect((vp.pick(side[0], side[1], FACE) as Extract<Pick, { kind: "face" }>).normal).toBeNull();
  });

  it("picks a sketch line and highlights it when selected or under the mouse", () => {
    vp.setView("top", false);
    vp.fit(false);
    vp.setSketchesVisible(true);
    // A sketch beside the parts with one line.
    const data = vp.data!;
    const line = { id: "l1", kind: "line" as const, a: [0, -30] as [number, number], b: [40, -30] as [number, number], construction: false, external: false };
    vp.setScene({ ...data, sketches: [{ id: "sk1", frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] }, curves: [line], regions: [] }] });
    vp.scene.updateMatrixWorld(true);
    const at = vp.worldToScreen([20, -30, 0])!;
    // A drawn frame gives the fat lines the canvas size (the stand-in renderer draws none).
    const g = (vp as unknown as { sketchGroup: THREE.Group }).sketchGroup;
    g.traverse((o) => (o as unknown as { material?: { resolution?: THREE.Vector2 } }).material?.resolution?.set(vp.canvas.clientWidth || 1280, vp.canvas.clientHeight || 800));
    const p = vp.pick(at[0], at[1], new Set(["sketch_curve"] as const));
    expect(p).toMatchObject({ kind: "sketch_curve", sketchId: "sk1", curveId: "l1" });
    vp.setSelection([p!]);
    vp.setHover(p);
    expect(samePick(vp.hovered, p)).toBe(true);
    vp.setSelection([]);
    vp.setHover(null);
    vp.setScene(data);
  });

  it("tells picks apart: the same edge, region or curve, or another", () => {
    const edge = { kind: "edge", bodyId: "ex1", edge: 3, tags: [], point: [0, 0, 0] } as unknown as Pick;
    expect(samePick(edge, { ...edge, point: [1, 1, 1] } as Pick)).toBe(true);
    expect(samePick(edge, { ...edge, edge: 4 } as Pick)).toBe(false);
    const region = { kind: "region", sketchId: "sk1", key: "l1+l2+l3+l4", point: [0, 0, 0] } as unknown as Pick;
    expect(samePick(region, { ...region } as Pick)).toBe(true);
    expect(samePick(region, { ...region, key: "x" } as Pick)).toBe(false);
    expect(samePick(region, edge)).toBe(false);
    expect(samePick(null, null)).toBe(true);
  });

  it("steps the grid and the snap coarsely far out", () => {
    expect(vp.gridSteps(1e6).minor).toBe(50000);
    const v = vp as unknown as { handleStep: unknown; snapStep(at: [number, number, number]): number; pixelSize(at?: unknown): number };
    const own = v.handleStep;
    v.handleStep = undefined;
    const spy = vi.spyOn(v, "pixelSize").mockReturnValue(1000);
    expect(v.snapStep([0, 0, 0])).toBe(100);
    spy.mockReturnValue(0.01);
    expect(v.snapStep([0, 0, 0])).toBe(0.1);
    spy.mockRestore();
    v.handleStep = own;
  });

  it("makes a picture in the flat projection, and zooms it when framing", async () => {
    vp.setProjection("orthographic");
    expect(vp.snapshot(200, 100)).toMatch(/^data:image\/png/);
    vp.fit(true);
    for (let i = 0; i < 20; i++) {
      await settle(30);
      (vp as unknown as { frame(): void }).frame();
    }
    vp.setProjection("perspective");
  });

  it("waits with the bottom inset until an arrow's drag ends", async () => {
    vp.setView("iso", false);
    vp.fit(false);
    vp.scene.updateMatrixWorld(true);
    let ended = false;
    vp.setHandles([{ id: "h", origin: [20, 10, 10], dir: [0, 0, 1], value: 10, onDrag: () => undefined, onEnd: () => void (ended = true) }]);
    const tip = vp.handleTipScreen("h")!;
    const at = { pointerId: 5, pointerType: "touch", isPrimary: true, button: 0, clientX: tip[0], clientY: tip[1] };
    await act(async () => void fireEvent.pointerDown(vp.canvas, { ...at, buttons: 1 }));
    expect(vp.draggingHandle).toBe(true);
    vp.setBottomInset(120);
    expect((vp as unknown as { pendingInset: number | null }).pendingInset).toBe(120);
    await act(async () => void fireEvent.pointerUp(vp.canvas, { ...at, buttons: 0 }));
    expect(ended).toBe(true);
    expect((vp as unknown as { pendingInset: number | null }).pendingInset).toBeNull();
    vp.setHandles([]);
    vp.setBottomInset(0);
  });

  it("shows a grab hand over a joint while parts can be dragged", async () => {
    vp.setJointGlyphs([{ id: "j1", type: "revolute", origin: [20, 10, 10], axis: [0, 0, 1] }]);
    const drag = { start: () => true, move: () => undefined, end: () => undefined };
    vp.partDrag = drag;
    vp.scene.updateMatrixWorld(true);
    // One of the points the symbol is grabbed by.
    const g = (vp as unknown as { jointGroup: THREE.Group }).jointGroup.children[0]!;
    const grip = (g.userData as { grip: THREE.Vector3[] }).grip[0]!.clone().applyMatrix4(g.matrixWorld);
    const at = vp.worldToScreen([grip.x, grip.y, grip.z])!;
    await act(async () => void fireEvent.pointerMove(vp.canvas, { pointerId: 6, pointerType: "mouse", buttons: 0, clientX: at[0], clientY: at[1] }));
    expect(vp.canvas.style.cursor).toBe("grab");
    await act(async () => void fireEvent.pointerMove(vp.canvas, { pointerId: 6, pointerType: "mouse", buttons: 0, clientX: 5, clientY: 5 }));
    expect(vp.canvas.style.cursor).toBe("");
    vp.partDrag = null;
    vp.setJointGlyphs([]);
  });

  it("warns about a picture or surroundings that cannot be read, and goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ex1 = vp.data!.bodies.find((b) => b.bodyId === "ex1")!;
    vp.setBodyTextures([{ bodyId: "ex1", uvs: new Float32Array((ex1.positions.length / 3) * 2), image: new Blob([new Uint8Array([1, 2, 3])]), key: "broken" }]);
    await vp.setScenery([{ id: "s1", data: new TextEncoder().encode(JSON.stringify({ asset: { version: "1.0" } })).buffer as ArrayBuffer }]);
    await settle(50);
    expect(warn.mock.calls.some((c) => c[0] === "scenery")).toBe(true);
    expect(warn.mock.calls.some((c) => c[0] === "texture")).toBe(true);
    vp.setBodyTextures([]);
    await vp.setScenery([]);
    warn.mockRestore();
  });

  it("pans with a two-finger swipe when swipes do not orbit", async () => {
    const nav = (vp as unknown as { navigation: Parameters<Viewport["setNavigation"]>[0] }).navigation;
    vp.setNavigation(nav, false, false);
    const cam = () => (vp as unknown as { camera: THREE.Camera }).camera;
    const before = cam().position.clone();
    await act(async () => void fireEvent.wheel(vp.canvas, { clientX: 400, clientY: 300, deltaX: 30, deltaY: 10, deltaMode: 0 }));
    await act(async () => void fireEvent.wheel(vp.canvas, { clientX: 400, clientY: 300, deltaX: 30, deltaY: 10, deltaMode: 0 }));
    vp.scene.updateMatrixWorld(true);
    expect(cam().position.equals(before)).toBe(false);
    vp.setNavigation(nav);
  });

  it("fades the studio ground's shadow out towards its rim", () => {
    const stage = (vp as unknown as { stage: { ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial> } }).stage;
    const shader = {
      vertexShader: "void main() {\n#include <begin_vertex>\n}",
      fragmentShader: "void main() {\ngl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );\n}",
    };
    stage.ground.material.onBeforeCompile(shader as never, undefined as never);
    expect(shader.vertexShader).toContain("vGround = position.xy;");
    expect(shader.fragmentShader).toContain("smoothstep( 0.3, 0.5, length( vGround ) )");
  });

  it("gives back the studio stage's memory when the view goes", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const { Viewport } = vpModule;
    const other = new Viewport(host);
    const stage = (other as unknown as { stage: { dispose(): void } }).stage;
    const spy = vi.spyOn(stage, "dispose");
    other.dispose();
    expect(spy).toHaveBeenCalledOnce();
    host.remove();
  });
});

