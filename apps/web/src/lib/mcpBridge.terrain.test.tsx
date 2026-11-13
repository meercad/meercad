/**
 * An assistant's requests on a terrain (mcpBridge.ts, mcpTools.ts) with the real kernel: a part set
 * onto the ground stands on it there (its bottom at the ground's height, its middle where asked);
 * a spot off the terrain is refused; a model from photos without photos says what came of it; the
 * wall thickness of a plate is shown on the part.
 */
import { act } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { rebuildNow } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { glb } from "../../../../tests/glbs";
import { addTerrain } from "./terrain";
import { testCall } from "./mcpBridge";
import { useThickness } from "./thickness";
import { ViewportView } from "../components/ViewportView";

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => testCall(method, params) as Promise<T>;
const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 20, y: 0 },
  { id: "p3", type: "point", x: 20, y: 20 },
  { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];

beforeAll(async () => {
  withScreen();
  await call("new_project", { name: "Terrain requests" });
  await call("apply_ops", { ops: [{ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 2, mode: "new_body" },
  ] as Feature[] }] });
  renderUi(<ViewportView />);
  await rebuilt();
  // A flat ground 300 mm up, 10 m square.
  await act(async () => addTerrain({ folder: "Yard", photos: 3, size: [10_000, 10_000, 1], measured: false } as never, glb([{ x: 0, y: 0, z: 300, s: 10_000 }])));
  await act(async () => new Promise((r) => setTimeout(r, 200)));
});

describe("an assistant on a terrain", () => {
  it("sets a part onto the ground where asked, and refuses a spot off the terrain", async () => {
    const r = await call<{ bbox: { min: number[]; max: number[] } }>("place_on_terrain", { part: "ex1", at: [5000, 4000] });
    expect(r.bbox.min[2]).toBeCloseTo(300, 0);
    expect((r.bbox.min[0]! + r.bbox.max[0]!) / 2).toBeCloseTo(5000, 0);
    expect((r.bbox.min[1]! + r.bbox.max[1]!) / 2).toBeCloseTo(4000, 0);
    await expect(call("place_on_terrain", { part: "ex1", at: [-90_000, 0] })).rejects.toThrow(/no terrain at/);
  });

  it("says what came of a model from photos without photos", async () => {
    const r = await call<{ added: unknown[] }>("photo_terrain", { folder: "/nothing/here" });
    expect(r.added).toEqual([]);
  });

  it("shows a plate's wall thickness on the part", async () => {
    const r = await call<Record<string, unknown>>("wall_thickness", { part: "ex1", minWall: 1, show: true });
    expect(r).toBeTruthy();
    expect(useThickness.getState().body).toBe("ex1");
    await rebuildNow();
  });
});
