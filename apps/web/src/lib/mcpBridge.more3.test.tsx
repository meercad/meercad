/**
 * More of what the app answers an assistant (mcpBridge.ts, mcpTools.ts) with the real kernel: the
 * view set or fitted; a USDZ export (not of variants); a print check with the way down given as a
 * flat face, refused for a round one; joints made from two meshing gears; a project closed and
 * opened again by its id.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { getViewport, useApp } from "../store";
import { renderUi, rebuilt, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { testCall } from "./mcpBridge";

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => testCall(method, params) as Promise<T>;
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
  { id: "rod", op: "primitive", shape: "cylinder", diameter: 10, height: 30, center: [80, 0, 0], mode: "new_body" } as Feature,
];

beforeAll(async () => {
  await call("new_project", { name: "Bridge more" });
  await call("apply_ops", { ops: [{ type: "add_features", features: design }] });
  withScreen();
  renderUi(<ViewportView />);
  await rebuilt();
});

describe("an assistant's requests", () => {
  it("sets the view and fits it", async () => {
    const vp = getViewport()!;
    expect(await call("set_view", { view: "top" })).toBe("ok");
    const q = vp.cameraQuaternion.clone();
    expect(await call("set_view", { view: "iso" })).toBe("ok");
    await new Promise((r) => setTimeout(r, 600));
    (vp as unknown as { frame(): void }).frame();
    expect(vp.cameraQuaternion.equals(q)).toBe(false);
    expect(await call("set_view", { view: "fit" })).toBe("ok");
  });

  it("exports USDZ, but not per variant", async () => {
    const r = await call<{ files: Record<string, string> }>("export", { format: "usdz", name: "block" });
    const data = Uint8Array.from(atob(r.files["block.usdz"]!), (c) => c.charCodeAt(0));
    // A USDZ is a zip: it starts with the local file header.
    expect([...data.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    await expect(call("export", { format: "usdz", variants: true })).rejects.toThrow(/not its variants/);
  });

  it("checks printing with the way down given as a face, and refuses a round one", async () => {
    // The block's top down: it still stands on a flat face, no overhangs.
    const r = await call<{ overhangMm2: number; onBedMm2: number }>("print_check", { part: "ex1", down: { face: "ex1.end_cap" }, show: false });
    expect(r.overhangMm2).toBeCloseTo(0, 6);
    expect(r.onBedMm2).toBeCloseTo(800, 3);
    await expect(call("print_check", { part: "rod", down: { face: "rod.side" }, show: false })).rejects.toThrow(/not flat/);
    await expect(call("print_check", { part: "rod", down: { face: "ex1.end_cap" }, show: false })).rejects.toThrow(/matches no face of "rod"/);
  });

  it("makes joints from two meshing gears", async () => {
    await call("apply_ops", { ops: [{ type: "add_features", features: [
      { id: "g1", op: "gear", kind: "spur", module: 2, teeth: 20, width: 6, center: [0, 60], mode: "new_body" },
      { id: "g2", op: "gear", kind: "spur", module: 2, teeth: 10, width: 6, meshWith: { gear: "g1" }, mode: "new_body" },
    ] }] });
    const r = await call<{ jointsAdded: number; joints: string[]; couplings: string[] }>("joints_from_gears");
    expect(r.jointsAdded).toBe(2);
    expect(r.joints).toHaveLength(2);
    // 20 : 10 teeth: the small one turns twice as fast the other way.
    expect(r.couplings.join(" ")).toMatch(/-2|−2/);
  });

  it("closes the project for the user and opens it again by its id", async () => {
    const id = useApp.getState().project!.id;
    expect(await call("close_project")).toMatchObject({ closed: true });
    const r = await call<{ project: { id: string } }>("open_project", { id });
    expect(r.project.id).toBe(id);
  });
});
