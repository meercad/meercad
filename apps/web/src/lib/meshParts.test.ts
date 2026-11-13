/**
 * Mesh parts (STL imports, scans) for printing and editing, with the real kernel: a 30 × 30 × 2
 * plate imported standing on its edge is laid flat by its big face (it then stands 2 mm high on
 * the plate) or turned the best way up; a part already lying best says so. Converting it to an
 * editable body keeps its 1800 mm³ and says so once; rebuilding it with features gives a part of
 * the same volume next to the hidden mesh.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as fit from "@meercad/kernel/fit";
import { writeStl } from "@meercad/io";
import { prism, turnedAboutX } from "../../../../tests/acceptance/meshes";
import { testCall } from "./mcpBridge";
import { currentDoc, rebuildNow, useApp } from "../store";
import { layOnFace, pickFaceToLay, printBestWayUp, usePrintCheck } from "./printability";
import { convertMeshPart, rebuildMeshPart } from "./meshConvert";

const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const stlOf = (corners: Float64Array) => writeStl([{ positions: Float32Array.from(corners), indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i) }]);
const lastToast = () => useApp.getState().toasts.at(-1)?.text ?? "";
const box = async (id: string) => (await rebuildNow()).report.bodies.find((b) => b.id === id)!.bbox;
let plate = "";

beforeAll(async () => {
  await testCall("new_project", { name: "Mesh parts" });
  // Standing on its 30 mm edge: 30 wide, 2 deep, 30 high.
  const standing = turnedAboutX(prism([[0, 0], [30, 0], [30, 30], [0, 30]], 2), 90);
  plate = ((await testCall("import_file", { name: "plate.stl", base64: b64(stlOf(standing)) })) as { added: string[] }).added[0]!;
  await rebuildNow();
});

describe("laying a mesh part on the plate", () => {
  it("lays the standing plate down on its big face: 2 mm high, on the plate", async () => {
    const before = await box(plate);
    expect(before.max[2]! - before.min[2]!).toBeCloseTo(30, 4);
    // A hit on the big face (its normal along −y); the face number of a mesh part says nothing.
    layOnFace(plate, -1, [0, -1, 0]);
    const after = await box(plate);
    expect(after.max[2]! - after.min[2]!).toBeCloseTo(2, 4);
    expect(after.min[2]).toBeCloseTo(0, 4);
    expect(currentDoc().features.at(-1)).toMatchObject({ op: "transform", name: "Lay on the plate" });
  });

  it("says a lying plate already stands best, and refuses a hit with no flat area", async () => {
    printBestWayUp(plate);
    expect(lastToast()).toMatch(/already stands the best way up for printing/);
    layOnFace(plate, -1, [0, 0, 0]);
    expect(lastToast()).toBe("Only a flat face can lie on the plate.");
  });

  it("waits for the face to lay down, and Escape ends the waiting", () => {
    pickFaceToLay();
    expect(usePrintCheck.getState().picking).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(usePrintCheck.getState().picking).toBe(false);
  });
});

describe("making a mesh part editable", () => {
  it("converts it to faces of the same volume, and only once", async () => {
    convertMeshPart(plate);
    await expect.poll(() => lastToast(), { timeout: 60_000 }).toMatch(/has editable faces now/);
    const out = await rebuildNow();
    expect(out.report.bodies.find((b) => b.id === plate)!.volume).toBeCloseTo(1800, 3);
    convertMeshPart(plate);
    expect(lastToast()).toMatch(/is already converted by step mc1/);
    // When that step failed, it says why (and opens the step to change it).
    const output = useApp.getState().output!;
    useApp.setState({ output: { ...output, report: { ...output.report, features: output.report.features.map((f) => (f.id === "mc1" ? { ...f, status: "error", message: "tolerance too small", hint: "raise it" } : f)) } } });
    convertMeshPart(plate);
    expect(lastToast()).toMatch(/Converting .* failed: tolerance too small \(raise it\)/);
    useApp.setState({ dialog: null, output });
  });

  it("rebuilds it with features of the same volume, the mesh hidden", async () => {
    await rebuildMeshPart(plate);
    expect(lastToast()).toMatch(/same volume as the mesh/);
    expect(useApp.getState().hidden.has(plate)).toBe(true);
    await rebuildMeshPart("nope");
    expect(lastToast()).toMatch(/is not in the model/);
    vi.spyOn(fit, "fitMesh").mockImplementationOnce(() => {
      throw new Error("no faces found");
    });
    await rebuildMeshPart(plate);
    expect(lastToast()).toMatch(/Could not rebuild .*: no faces found/);
  });
});
