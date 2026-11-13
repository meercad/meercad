/**
 * Measuring on a scan in the 3D view (ViewportView.tsx): the shapes fitted on the mesh are laid
 * over the triangles they cover (one per pick, the second in another colour) and go when the
 * measurement is cleared; the tolerance field takes only a size above zero.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeStl } from "@meercad/io";
import type { Viewport } from "@meercad/viewport";
import { turned } from "../../../../tests/acceptance/meshes";
import { getViewport, useApp } from "../store";
import { testCall } from "../lib/mcpBridge";
import { clearScanMeasure, measureOnScan, useScanMeasure } from "../lib/scanMeasure";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const stlOf = (corners: Float64Array) => writeStl([{ positions: Float32Array.from(corners), indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i) }]);
let vp: Viewport;
let cyl = "";
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const overlayMeshes = () => {
  let n = 0;
  vp.overlay.traverse((o) => void ((o as { isMesh?: boolean }).isMesh && (o.parent?.type === "Group" && o.parent !== vp.overlay) && n++));
  return n;
};

beforeAll(async () => {
  withScreen();
  await testCall("new_project", { name: "Scan overlay" });
  cyl = ((await testCall("import_file", { name: "cyl.stl", base64: b64(stlOf(turned([[0, 0], [10, 0], [10, 30], [0, 30]], 48))) })) as { added: string[] }).added[0]!;
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
});
afterAll(cleanup);

describe("shapes on a scan", () => {
  it("lays each fitted shape over its triangles, and takes them away when cleared", async () => {
    await act(async () => useApp.setState({ measure: { active: true, picks: [], result: null } }));
    const before = overlayMeshes();
    await act(async () => measureOnScan(cyl, [10, 0, 15]));
    await settle();
    expect(overlayMeshes()).toBe(before + 1);
    await act(async () => measureOnScan(cyl, [3, 3, 30]));
    await settle();
    expect(useScanMeasure.getState().shapes).toHaveLength(2);
    expect(overlayMeshes()).toBe(before + 2);
    await act(async () => clearScanMeasure());
    await settle();
    expect(overlayMeshes()).toBe(before);
  });

  it("takes a tolerance above zero only", async () => {
    await act(async () => measureOnScan(cyl, [10, 0, 15]));
    await settle();
    const field = [...document.querySelectorAll<HTMLInputElement>("label")].find((l) => l.textContent?.includes("Fit tolerance"))!.querySelector("input")!;
    expect(field).toBeDefined();
    const before = useScanMeasure.getState().tol;
    await act(async () => void fireEvent.change(field, { target: { value: "0" } }));
    expect(useScanMeasure.getState().tol).toBe(before);
    await act(async () => void fireEvent.change(field, { target: { value: "0.2" } }));
    expect(useScanMeasure.getState().tol).toBe(0.2);
    await act(async () => useApp.setState({ measure: { active: false, picks: [], result: null } }));
  });
});
