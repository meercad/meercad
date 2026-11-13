/**
 * Sending a design to a slicer on the Mac (io.ts openInSlicer, sendToSlicer and the assistant's
 * send_to_slicer), with a stand-in for the installed slicers: the parts go as a 3MF to Bambu Studio
 * by default or to PrusaSlicer when named; two parts of different filaments are told apart by slot;
 * a slicer that is not installed is named, and none installed says so.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { read3mf } from "@meercad/io";
import { testCall } from "./mcpBridge";
import { refreshSlicers } from "./slicers";
import { sendToSlicer } from "../components/io";
import { useApp } from "../store";

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) =>
  testCall(method, params) as Promise<T>;
const rect = (p: string, x: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y: 0 },
  { id: `${p}2`, type: "point", x: x + 20, y: 0 },
  { id: `${p}3`, type: "point", x: x + 20, y: 20 },
  { id: `${p}4`, type: "point", x, y: 20 },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const opened: { slicer: string; name: string; data: Uint8Array }[] = [];
let installed: { id: string; name: string }[] = [
  { id: "bambu", name: "Bambu Studio" },
  { id: "prusa", name: "PrusaSlicer" },
];
const desktop = () => (window as unknown as { meercadDesktop: Record<string, unknown> }).meercadDesktop;

beforeAll(async () => {
  desktop()["slicers"] = {
    list: async () => installed,
    open: async (p: { slicer: string; name: string; data: Uint8Array }) => (
      opened.push(p),
      { slicer: installed.find((s) => s.id === p.slicer)!.name, file: `/tmp/${p.name}` }
    ),
  };
  await refreshSlicers();
  await call("new_project", { name: "Slicing" });
  await call("apply_ops", {
    ops: [
      {
        type: "add_features",
        features: [
          { id: "s1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("a", 0), constraints: [] },
          {
            id: "e1",
            op: "extrude",
            profile: { sketch: "s1" },
            extent: "blind",
            distance: 5,
            mode: "new_body",
          },
          { id: "s2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 40), constraints: [] },
          {
            id: "e2",
            op: "extrude",
            profile: { sketch: "s2" },
            extent: "blind",
            distance: 5,
            mode: "new_body",
          },
        ] as Feature[],
      },
      { type: "set_material", part: "e1", material: "pla" },
      { type: "set_material", part: "e2", material: "petg" },
    ],
  });
});
afterAll(() => {
  delete desktop()["slicers"];
});

describe("sending to a slicer", () => {
  it("sends the parts as a 3MF to Bambu Studio by default, with a slot per filament", async () => {
    const r = await call<{ slicer: string; file: string; filaments?: { slot: number }[] }>("send_to_slicer", {
      materials: true,
    });
    expect(r.slicer).toBe("Bambu Studio");
    expect(opened.at(-1)!.slicer).toBe("bambu");
    expect(opened.at(-1)!.name).toMatch(/\.3mf$/);

    const meshes = read3mf(opened.at(-1)!.data);
    expect(meshes).toHaveLength(2);
    expect(r.filaments!.map((f) => f.slot)).toEqual([1, 2]);
  });

  it("sends to PrusaSlicer when named, and says so in the app", async () => {
    await call("send_to_slicer", { slicer: "prusa", parts: ["e1"] });
    expect(opened.at(-1)!.slicer).toBe("prusa");
    expect(read3mf(opened.at(-1)!.data)).toHaveLength(1);
    await sendToSlicer("prusa");
    expect(useApp.getState().toasts.some((t) => t.text === "Sent to PrusaSlicer")).toBe(true);
  });

  it("names a slicer that is not installed, and says when none is", async () => {
    installed = [{ id: "bambu", name: "Bambu Studio" }];
    await refreshSlicers();
    await expect(call("send_to_slicer", { slicer: "prusa" })).rejects.toThrow(
      /PrusaSlicer is not installed on this Mac/,
    );
    installed = [];
    await refreshSlicers();
    await expect(call("send_to_slicer", {})).rejects.toThrow(/No slicer installed/);
    await sendToSlicer("bambu");
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(
      /^Could not send to the slicer: Bambu Studio is not installed/,
    );
  });
});
