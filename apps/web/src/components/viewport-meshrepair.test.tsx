/**
 * Cleaning up a mesh part from the 3D view's card (ViewportView.tsx, meshRepair.ts) with the real
 * kernel: a 20 × 20 × 10 box whose top is missing (an open scan) shows its triangle count from the
 * file; holes closed, it is solid again with the box's volume; the tolerance field only takes a
 * size above zero; Cancel leaves it as it was.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeStl } from "@meercad/io";
import { getViewport, rebuildNow, useApp } from "../store";
import { testCall } from "../lib/mcpBridge";
import { useMeshRepair } from "../lib/meshRepair";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

const settle = (ms = 50) => act(async () => new Promise((r) => setTimeout(r, ms)));
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
/** A box from the origin to (20, 20, 10), each face two triangles, outward; its top left out. */
function openBox(): Uint8Array {
  const p = (i: number): number[] => [i & 1 ? 20 : 0, i & 2 ? 20 : 0, i & 4 ? 10 : 0];
  const quads = [[0, 2, 3, 1], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const corners: number[] = [];
  for (const [a, b, c, d] of quads) corners.push(...p(a!), ...p(b!), ...p(c!), ...p(a!), ...p(c!), ...p(d!));
  return writeStl([{ positions: Float32Array.from(corners), indices: Uint32Array.from({ length: corners.length / 3 }, (_, i) => i) }]);
}
let part = "";

beforeAll(async () => {
  withScreen();
  await testCall("new_project", { name: "Repair" });
  part = ((await testCall("import_file", { name: "open.stl", base64: b64(openBox()) })) as { added?: string[] }).added?.[0] ?? "";
  renderUi(<ViewportView />);
  await rebuilt();
  void getViewport();
});
afterAll(cleanup);

describe("cleaning up a mesh part", () => {
  it("shows the triangle count, takes only a size above zero, and Cancel keeps it", async () => {
    const body = part || useApp.getState().doc.features.find((f) => f.op === "import")!.id;
    await act(async () => useMeshRepair.setState({ body, removePieces: false, fillHoles: false, reduce: false, tolerance: 0.05 }));
    await settle();
    expect(screen.getByText("10 triangles")).toBeTruthy();
    // Nothing chosen: nothing to do.
    expect(screen.getByText("Clean up").closest("button")!.disabled).toBe(true);
    await act(async () => void fireEvent.click(screen.getByText("Fewer triangles")));
    const tol = document.querySelector<HTMLInputElement>(".deviation-card input[type=number]")!;
    await act(async () => void fireEvent.change(tol, { target: { value: "0" } }));
    expect(useMeshRepair.getState().tolerance).toBe(0.05);
    await act(async () => void fireEvent.change(tol, { target: { value: "0.2" } }));
    expect(useMeshRepair.getState().tolerance).toBe(0.2);
    await act(async () => void fireEvent.click(screen.getByText("Cancel")));
    expect(useMeshRepair.getState().body).toBeNull();
  });

  it("closes the hole: the box is solid again, 20 × 20 × 10", async () => {
    const body = part || useApp.getState().doc.features.find((f) => f.op === "import")!.id;
    await act(async () => useMeshRepair.setState({ body, removePieces: false, fillHoles: false, reduce: false, tolerance: 0.05 }));
    await settle();
    await act(async () => void fireEvent.click(screen.getByText("Close holes")));
    await act(async () => void fireEvent.click(screen.getByText("Clean up").closest("button")!));
    await settle(300);
    await rebuilt();
    const b = (await rebuildNow()).report.bodies.find((x) => x.id === body);
    expect(b?.volume).toBeCloseTo(4000, 3);
  });
});
